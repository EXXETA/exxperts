// Search the model runs on its provider's own infrastructure, and the one
// collision that makes it dangerous.
//
// Both subscription providers call their server-side tool web_search, which is
// also the name of the room's own tool. Sending both in one request asks one
// name to mean two things, and the provider is entitled to refuse the whole
// call. So the rule is: exactly one web_search reaches the wire. This proves
// the rule from both ends, the declaration that gets added and the client tool
// that gets taken away, for each provider that offers it and for the ones that
// do not.
//
// No live API calls: the payload transform is the seam, and the seam is a pure
// function over the request body the provider layer just built.
//
// Run: node scripts/run-smokes.mjs native-provider-search

import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, "..", "..", "..");
const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), "exxperts-native-provider-search-"));
const agentDir = path.join(tempHome, ".exxperts", "agent");
const agentsRoot = path.join(tempHome, ".exxperts", "app", "personalized-agents");
process.env.HOME = tempHome;
process.env.USERPROFILE = tempHome;
process.env.EXXPERTS_CODING_AGENT_DIR = agentDir;
process.env.EXXETA_PERSISTENT_AGENTS_ROOT = agentsRoot;
process.env.EXXETA_HOME = repoRoot;
delete process.env.EXXETA_SEARCH_PROVIDER;
delete process.env.EXXETA_SEARCH_BASE_URL;
for (const key of ["ANTHROPIC_API_KEY", "ANTHROPIC_OAUTH_TOKEN", "OPENAI_API_KEY", "EXXETA_AI_API_KEY"]) delete process.env[key];
fs.mkdirSync(agentDir, { recursive: true, mode: 0o700 });
fs.mkdirSync(agentsRoot, { recursive: true, mode: 0o700 });

function assert(condition: unknown, message: string): asserts condition {
	if (!condition) throw new Error(message);
}

const appDir = path.join(tempHome, ".exxperts", "app");
const configPath = path.join(appDir, "web-search.json");
fs.mkdirSync(appDir, { recursive: true, mode: 0o700 });

function setProviderSearch(value: boolean | undefined): void {
	const document = { provider: "duckduckgo", ...(value === undefined ? {} : { providerSearch: value }) };
	fs.writeFileSync(configPath, JSON.stringify(document), { mode: 0o600 });
}

/**
 * The Anthropic credential decides whether provider search is even on offer.
 * A subscription sign-in is OAuth and the search is part of what it pays for;
 * an API key is metered and billed per search, which is not a bill to run up
 * on somebody's behalf because of a default.
 */
function setAnthropicAuth(type: "oauth" | "api_key" | "none"): void {
	const authPath = path.join(agentDir, "auth.json");
	const existing = fs.existsSync(authPath) ? JSON.parse(fs.readFileSync(authPath, "utf-8")) : {};
	if (type === "none") delete existing.anthropic;
	else if (type === "oauth") existing.anthropic = { type: "oauth", access: "sk-ant-oat-synthetic-do-not-print", refresh: "synthetic-refresh", expires: Date.now() + 600_000 };
	else existing.anthropic = { type: "api_key", key: "sk-ant-api-synthetic-do-not-print" };
	fs.mkdirSync(path.dirname(authPath), { recursive: true, mode: 0o700 });
	fs.writeFileSync(authPath, JSON.stringify(existing), { mode: 0o600 });
}

/** The client tool as the room registers it, in each provider's own shape. */
const CLIENT_WEB_SEARCH_ANTHROPIC = { name: "web_search", description: "Search the public web.", input_schema: { type: "object" } };
const CLIENT_WEB_SEARCH_CODEX = { type: "function", name: "web_search", description: "Search the public web.", parameters: { type: "object" } };
const CLIENT_FETCH_URL = { name: "fetch_url", description: "Open a page.", input_schema: { type: "object" } };

function toolNames(payload: any): string[] {
	return (payload.tools ?? []).map((tool: any) => tool.name ?? tool.type);
}

function writeJson(file: string, value: unknown): void {
	fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
	fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
}

// One shortest-legal answer per dialect. Neither says anything interesting;
// the request is the whole point, the response only has to let the turn end.
const ANTHROPIC_STREAM = [
	`event: message_start\ndata: ${JSON.stringify({ type: "message_start", message: { id: "msg_stub", type: "message", role: "assistant", model: "claude-opus-5", content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 5, output_tokens: 1 } } })}\n\n`,
	`event: content_block_start\ndata: ${JSON.stringify({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } })}\n\n`,
	`event: content_block_delta\ndata: ${JSON.stringify({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "ok" } })}\n\n`,
	`event: content_block_stop\ndata: ${JSON.stringify({ type: "content_block_stop", index: 0 })}\n\n`,
	`event: message_delta\ndata: ${JSON.stringify({ type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 1 } })}\n\n`,
	`event: message_stop\ndata: ${JSON.stringify({ type: "message_stop" })}\n\n`,
].join("");

const COMPLETIONS_STREAM = [
	`data: ${JSON.stringify({ id: "chatcmpl-stub", object: "chat.completion.chunk", choices: [{ index: 0, delta: { role: "assistant", content: "ok" }, finish_reason: null }] })}\n\n`,
	`data: ${JSON.stringify({ id: "chatcmpl-stub", object: "chat.completion.chunk", choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 5, completion_tokens: 1, prompt_tokens_details: { cached_tokens: 0 }, completion_tokens_details: { reasoning_tokens: 0 } } })}\n\n`,
	"data: [DONE]\n\n",
].join("");

/** A tool call, so the agent loop has to come back for a second round trip. */
const ANTHROPIC_TOOL_CALL_STREAM = [
	`event: message_start\ndata: ${JSON.stringify({ type: "message_start", message: { id: "msg_tool", type: "message", role: "assistant", model: "claude-opus-5", content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 5, output_tokens: 1 } } })}\n\n`,
	`event: content_block_start\ndata: ${JSON.stringify({ type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "toolu_1", name: "fetch_url", input: {} } })}\n\n`,
	`event: content_block_delta\ndata: ${JSON.stringify({ type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: '{"url":"https://example.invalid/x"}' } })}\n\n`,
	`event: content_block_stop\ndata: ${JSON.stringify({ type: "content_block_stop", index: 0 })}\n\n`,
	`event: message_delta\ndata: ${JSON.stringify({ type: "message_delta", delta: { stop_reason: "tool_use", stop_sequence: null }, usage: { output_tokens: 1 } })}\n\n`,
	`event: message_stop\ndata: ${JSON.stringify({ type: "message_stop" })}\n\n`,
].join("");

/** Every request body that reached a provider endpoint, newest last. */
const captured: Array<{ path: string; body: any }> = [];
/**
 * Scripted answers for the next Anthropic requests, and a hook that runs when
 * each one arrives. Lets a test change the world mid-turn, between two round
 * trips of the same turn, which is the only moment the turn-consistency rule
 * can actually be observed.
 */
const anthropicScript: Array<{ stream: string; onRequest?: () => void }> = [];

function startStubProvider(): Promise<{ port: number; close: () => Promise<void> }> {
	const server = http.createServer((req, res) => {
		let raw = "";
		req.on("data", (chunk) => { raw += chunk; });
		req.on("end", () => {
			let body: any = null;
			try { body = JSON.parse(raw); } catch {}
			captured.push({ path: req.url ?? "", body });
			const anthropic = (req.url ?? "").includes("/messages");
			const scripted = anthropic ? anthropicScript.shift() : undefined;
			scripted?.onRequest?.();
			res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
			res.end(scripted ? scripted.stream : anthropic ? ANTHROPIC_STREAM : COMPLETIONS_STREAM);
		});
	});
	return new Promise((resolve) => {
		server.listen(0, "127.0.0.1", () => {
			const port = (server.address() as any).port as number;
			resolve({ port, close: () => new Promise<void>((done) => server.close(() => done())) });
		});
	});
}

/**
 * Drives real background runs, which is one of the two places the conditional
 * registration lives, and reads the request that actually left.
 */
async function runRoomTurnChecks(): Promise<void> {
	const stub = await startStubProvider();
	let roomIdForLiveCheck = "";
	try {
		// A built-in provider id redirected at a local endpoint: the registry
		// applies a provider baseUrl override to that provider's built-in models,
		// so this is the real anthropic path pointed somewhere safe.
		writeJson(path.join(agentDir, "models.json"), {
			providers: {
				anthropic: { baseUrl: `http://127.0.0.1:${stub.port}/anthropic` },
				"openai-compatible": {
					name: "Synthetic Gateway",
					baseUrl: `http://127.0.0.1:${stub.port}/gateway/v1`,
					api: "openai-completions",
					models: [{ id: "gateway-model", name: "Gateway Model", contextWindow: 128000, maxTokens: 4096 }],
				},
			},
		});
		// An unexpired OAuth credential is used verbatim, so nothing here reaches
		// the network to refresh it. The token spells the subscription surface,
		// which is the shape the real profile sends.
		writeJson(path.join(agentDir, "auth.json"), {
			anthropic: { type: "oauth", access: "sk-ant-oat-synthetic-do-not-print", refresh: "synthetic-refresh", expires: Date.now() + 600_000 },
			"openai-compatible": { type: "api_key", key: "synthetic-gateway-key" },
		});
		const productAppDir = path.join(tempHome, ".exxperts", "app");
		writeJson(path.join(productAppDir, "openai-compatible-ai-profile.json"), {
			profileId: "openai-compatible", providerId: "openai-compatible", label: "Synthetic Gateway",
			roomModels: [{ modelId: "gateway-model" }], maintenanceModel: "gateway-model",
		});

		const persistentAgents = await import("../src/persistent-agents.js");
		const { writePersistentAgentAiProfileState } = await import("../src/persistent-agent-ai-profile-state.js");
		const { executePersistentRoomBackgroundPrompt } = await import("../src/persistent-room-background-execution.js");
		writePersistentAgentAiProfileState("anthropic");
		const room = persistentAgents.createPersistentAgentFromScaffoldInput({
			displayName: "Search Room", userName: "Tester", preferredUserAddress: "Tester",
		});
		const roomId = (room as any).id ?? (room as any).agent?.id;
		assert(roomId, `the smoke needs a room to run turns in, got ${JSON.stringify(room)}`);

		let turn = 0;
		async function runTurn(model: { provider: string; model: string }): Promise<any> {
			turn += 1;
			const before = captured.length;
			await executePersistentRoomBackgroundPrompt({
				roomId,
				target: { kind: "fresh-thread", model },
				prompt: "What happened today?",
				executionId: `native-search-smoke-${turn}`,
				cwd: tempHome,
				agentDir,
			} as any);
			assert(captured.length > before, `turn ${turn} never reached the stub provider`);
			return captured[before].body;
		}

		// (a) Provider search on, Claude room: the declaration is on the request
		// and the room's own tool is nowhere near it.
		setProviderSearch(true);
		const claudeOn = await runTurn({ provider: "anthropic", model: "claude-opus-5" });
		// If a refactor ever stops these turns from reaching a provider at all,
		// the tool assertions below would pass over an empty request and prove
		// nothing. Pin the surface they landed on.
		assert(captured[captured.length - 1].path === "/anthropic/v1/messages", `the Claude turn must reach the Messages endpoint, got ${captured[captured.length - 1].path}`);
		assert(Array.isArray(claudeOn.messages) && claudeOn.messages.length > 0, `and carry a real conversation, got ${JSON.stringify(Object.keys(claudeOn))}`);
		assert(claudeOn.tools?.some((tool: any) => tool.type === "web_search_20250305"), `a Claude room must declare the provider's search, got ${JSON.stringify(toolNames(claudeOn))}`);
		assert(!claudeOn.tools?.some((tool: any) => tool.name === "web_search" && !tool.type), `the room's own web_search must not be registered alongside it, got ${JSON.stringify(toolNames(claudeOn))}`);
		assert(claudeOn.tools?.some((tool: any) => tool.name === "fetch_url"), `fetch_url must survive, got ${JSON.stringify(toolNames(claudeOn))}`);

		// (b) Same room, next turn, toggle off. Nothing restarted between these
		// two lines, which is the whole point of reading the setting per turn.
		setProviderSearch(false);
		const claudeOff = await runTurn({ provider: "anthropic", model: "claude-opus-5" });
		assert(!claudeOff.tools?.some((tool: any) => tool.type === "web_search_20250305"), `turning it off must stop the declaration, got ${JSON.stringify(toolNames(claudeOff))}`);
		assert(claudeOff.tools?.some((tool: any) => tool.name === "web_search"), `with provider search off the room's own web_search comes back, got ${JSON.stringify(toolNames(claudeOff))}`);

		// (a2) A turn is one turn. Which web_search a session offers is decided
		// when it binds, so a save landing between two round trips of the SAME
		// turn must not change the rules underneath it: the second request has
		// to look like the first, or the turn would finish with a tool the model
		// was never told about, or with neither tool at all.
		setProviderSearch(true);
		writePersistentAgentAiProfileState("anthropic");
		anthropicScript.length = 0;
		anthropicScript.push({
			// First round trip asks for a tool, which guarantees a second one.
			stream: ANTHROPIC_TOOL_CALL_STREAM,
			// The setting changes while the turn is in flight.
			onRequest: () => setProviderSearch(false),
		});
		anthropicScript.push({ stream: ANTHROPIC_STREAM });
		const beforeMidTurn = captured.length;
		await executePersistentRoomBackgroundPrompt({
			roomId,
			target: { kind: "fresh-thread", model: { provider: "anthropic", model: "claude-opus-5" } },
			prompt: "Look something up.",
			executionId: "native-search-smoke-midturn",
			cwd: tempHome,
			agentDir,
		} as any);
		const midTurnRequests = captured.slice(beforeMidTurn).filter((request) => request.path === "/anthropic/v1/messages");
		assert(midTurnRequests.length >= 2, `the mid-turn check needs a multi-round-trip turn, got ${midTurnRequests.length} requests`);
		for (const [roundTrip, request] of midTurnRequests.entries()) {
			assert(
				request.body.tools?.some((tool: any) => tool.type === "web_search_20250305"),
				`round trip ${roundTrip + 1} must run under the rule the turn started with, got ${JSON.stringify(toolNames(request.body))}`,
			);
			assert(
				!request.body.tools?.some((tool: any) => tool.name === "web_search" && !tool.type),
				`round trip ${roundTrip + 1} must not gain the local tool mid-turn, got ${JSON.stringify(toolNames(request.body))}`,
			);
		}
		anthropicScript.length = 0;

		// (d) A gateway room is never touched, either way.
		setProviderSearch(true);
		writePersistentAgentAiProfileState("openai-compatible");
		const gateway = await runTurn({ provider: "openai-compatible", model: "gateway-model" });
		assert(!JSON.stringify(gateway.tools ?? []).includes("web_search_20250305"), `a gateway must never get the Anthropic declaration, got ${JSON.stringify(toolNames(gateway))}`);
		assert(gateway.tools?.some((tool: any) => (tool.function?.name ?? tool.name) === "web_search"), `a gateway room keeps the app's own web_search, got ${JSON.stringify(toolNames(gateway))}`);

		// Nothing is streaming when nothing is running. The browser marks an
		// answer mid-flight and clears the mark with a debounced save that can be
		// dropped, which used to leave a finished answer marked streaming on disk
		// forever. That is not cosmetic: the restored-context reader treats a
		// streaming assistant item as unfinished and leaves it out, so a room
		// resumes without the answer it just gave.
		const streamThreadId = "native-search-streaming";
		const streamItems = [
			{ kind: "user", id: "u-stream", text: "ask" },
			{ kind: "assistant", id: "a-stream", text: "a whole answer", streaming: true },
			// A tool call in flight when the turn was stopped is the same problem
			// in a different field: its result event never arrives, so it spins
			// forever in the room and is read back later as a live call.
			{ kind: "tool", id: "t-stream", name: "fetch_url", args: { url: "https://example.invalid" }, status: "running" },
		];
		const roomModel = { provider: "anthropic", model: "claude-opus-5" };
		// Thread writes are gated on the active profile approving the model, and
		// the gateway case above left the gateway profile active.
		writePersistentAgentAiProfileState("anthropic");
		// The thread has to exist and be the room's active one before a turn can
		// begin against it.
		persistentAgents.writePersistentAgentThread(roomId, streamThreadId, {
			state: "active", origin: "home", model: roomModel, items: [streamItems[0]],
		} as any);
		persistentAgents.beginPersistentAgentTurn(roomId, streamThreadId, { turnId: "turn-stream" });
		const midTurn = persistentAgents.writePersistentAgentThread(roomId, streamThreadId, {
			state: "active", origin: "home", model: roomModel, items: streamItems,
		} as any);
		// While the turn IS running the mark is the truth, and a reload uses it to
		// draw the caret in the right place.
		assert((midTurn.thread.items as any[]).find((item) => item?.id === "a-stream")?.streaming === true,
			"a save during a running turn keeps the streaming mark");
		assert((midTurn.thread.items as any[]).find((item) => item?.id === "t-stream")?.status === "running",
			"and a tool call that really is in flight keeps saying so");
		persistentAgents.finishPersistentAgentTurn(roomId, streamThreadId, { turnId: "turn-stream", terminalReason: "completed" });
		const settled = persistentAgents.writePersistentAgentThread(roomId, streamThreadId, {
			state: "active", origin: "home", model: roomModel, items: streamItems,
		} as any);
		const settledAssistant = (settled.thread.items as any[]).find((item) => item?.id === "a-stream");
		assert(settledAssistant?.streaming === undefined, `a settled turn must not persist a streaming mark, got ${JSON.stringify(settledAssistant)}`);
		assert(settledAssistant?.text === "a whole answer", "and must keep everything else about the item");
		const settledTool = (settled.thread.items as any[]).find((item) => item?.id === "t-stream");
		assert(settledTool?.status === "stopped",
			`a tool call left running by a stopped turn must settle, got ${JSON.stringify(settledTool)}`);
		assert(settledTool?.name === "fetch_url" && settledTool?.args?.url === "https://example.invalid",
			"and must keep everything else about the call");
		const { buildPersistentRoomRestoredLiveThreadContext } = await import("../src/persistent-room-resume-context.js");
		const restored = buildPersistentRoomRestoredLiveThreadContext(settled.thread.items as any);
		assert(String(restored?.block ?? "").includes("a whole answer"),
			`the answer must be visible to the room that resumes, got ${JSON.stringify(restored)}`);
		assert(restored?.metadata.eligibleItemCount === 2,
			`and must count as a finished message, got ${JSON.stringify(restored?.metadata)}`);

		// The read side has to stand on its own, because the write side cannot
		// reach marks that are ALREADY on disk: threads written before this was
		// enforced, and the attached-path case where the browser is killed after
		// the answer lands but before its debounced save clears the mark. Nothing
		// writes that thread again, so the reader is the only thing left.
		const staleOnDisk = [
			{ kind: "user", id: "u-stale", text: "ask" },
			{ kind: "assistant", id: "a-stale", text: "an answer nobody cleared", streaming: true },
		];
		const idleRead = buildPersistentRoomRestoredLiveThreadContext(staleOnDisk as any, false);
		assert(String(idleRead?.block ?? "").includes("an answer nobody cleared"),
			`a stale mark on an idle room must not delete the answer, got ${JSON.stringify(idleRead)}`);
		// And the mark still means what it says while a turn really is running.
		const midTurnRead = buildPersistentRoomRestoredLiveThreadContext(staleOnDisk as any, true);
		assert(!String(midTurnRead?.block ?? "").includes("an answer nobody cleared"),
			"a half-written answer is still withheld while the room is mid-answer");

		// The in-flight check is per thread, not per room: a save for one thread
		// must not be treated as mid-answer because a different one is running.
		const otherThreadId = "native-search-streaming-other";
		persistentAgents.writePersistentAgentThread(roomId, otherThreadId, {
			state: "active", origin: "home", model: roomModel, items: [streamItems[0]],
		} as any);
		persistentAgents.beginPersistentAgentTurn(roomId, otherThreadId, { turnId: "turn-other" });
		const scopedWrite = persistentAgents.writePersistentAgentThread(roomId, streamThreadId, {
			state: "active", origin: "home", model: roomModel, items: streamItems,
		} as any);
		assert((scopedWrite.thread.items as any[]).find((item) => item?.id === "a-stream")?.streaming === undefined,
			"a turn running in another thread must not keep this thread's stale mark alive");
		persistentAgents.finishPersistentAgentTurn(roomId, otherThreadId, { turnId: "turn-other", terminalReason: "completed" });

		// (e) The same thing again, but inside one live room connection that
		// never disconnects. Which web_search a session offers is decided when
		// it binds, so this is the only way to see that a change to the setting
		// rebuilds the session before the next message instead of waiting for a
		// reconnect nobody is going to perform.
		roomIdForLiveCheck = roomId;
		writePersistentAgentAiProfileState("anthropic");
		await runLiveRoomFlip(roomId);
	} finally {
		await stub.close();
		void roomIdForLiveCheck;
	}
}

/**
 * One live room connection, three turns, with the setting changed underneath it
 * between them. The room never reconnects, so anything that changes here
 * changed because the session was rebuilt before the turn.
 */
async function runLiveRoomFlip(roomId: string): Promise<void> {
	const { spawn } = await import("node:child_process");
	const { authedFetch, SMOKE_AUTH_HEADERS, SMOKE_SERVER_AUTH_ENV, SMOKE_SERVER_SPAWN_TREE_OPTIONS, stopSmokeServer } = await import("./smoke-server-process.js");
	const WebSocketImpl: any = (await import("ws")).default;
	const port = 24000 + Math.floor(Math.random() * 10000);
	const baseUrl = `http://127.0.0.1:${port}`;
	const conversationId = "native-search-live";

	const env: NodeJS.ProcessEnv = { ...process.env };
	env.PORT = String(port);
	env.EXXPERTS_AUTH_TOKEN = SMOKE_SERVER_AUTH_ENV.EXXPERTS_AUTH_TOKEN;
	// Widens the bind window on demand, so the first-message race below can be
	// held still instead of raced for.
	env.EXXPERTS_TEST_INTROSPECTION = "1";
	const server = spawn("npx", ["tsx", "src/index.ts"], {
		shell: process.platform === "win32",
		...SMOKE_SERVER_SPAWN_TREE_OPTIONS,
		cwd: path.resolve(scriptDir, ".."),
		env,
	});
	const serverOutput: string[] = [];
	server.stdout?.on("data", (chunk: unknown) => serverOutput.push(String(chunk)));
	server.stderr?.on("data", (chunk: unknown) => serverOutput.push(String(chunk)));

	try {
		const deadline = Date.now() + 25_000;
		for (;;) {
			if (server.exitCode != null) throw new Error(`server exited before startup with code ${server.exitCode}`);
			try { if ((await fetch(`${baseUrl}/healthz`)).ok) break; } catch {}
			if (Date.now() > deadline) throw new Error(`server did not become ready; output: ${serverOutput.join("").slice(-800)}`);
			await new Promise((resolve) => setTimeout(resolve, 150));
		}

		await authedFetch(`${baseUrl}/api/persistent-agents/${roomId}/threads/${conversationId}`, {
			method: "PUT",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ state: "active", origin: "launcher", model: { provider: "anthropic", model: "claude-opus-5" }, items: [] }),
		});

		// A message sent the instant the socket opens, which is well before the
		// room has finished binding. The socket is open from the upgrade, so a
		// client is entitled to that moment, and the answer has to arrive late
		// rather than never: a first message that lands in the bind window used
		// to reach a socket nobody was listening on yet and vanish without an
		// error, leaving the room looking frozen with the question already in
		// the transcript. The bind delay makes that window wide enough to aim
		// at instead of waiting for a slow machine to produce it by accident.
		await (async () => {
			const earlyFrames: any[] = [];
			const early = new WebSocketImpl(
				`ws://127.0.0.1:${port}/ws?persistentAgentId=${roomId}&conversationId=${conversationId}&modelProvider=anthropic&model=claude-opus-5&reattach=1&testBindDelayMs=1500`,
				{ headers: { ...SMOKE_AUTH_HEADERS } },
			);
			early.addEventListener("message", (event: { data: unknown }) => {
				try { earlyFrames.push(JSON.parse(String(event.data))); } catch {}
			});
			await new Promise<void>((resolve, reject) => {
				early.addEventListener("open", () => resolve());
				early.addEventListener("error", () => reject(new Error("the early-message socket failed to connect")));
			});
			early.send(JSON.stringify({ type: "prompt", text: "Say something short." }));
			const deadlineForEarly = Date.now() + 25_000;
			let landed = false;
			while (Date.now() < deadlineForEarly && !landed) {
				landed = earlyFrames.some((row) => row.type === "event" && row.event?.type === "agent_end");
				if (!landed) await new Promise((resolve) => setTimeout(resolve, 25));
			}
			assert(landed, `a message sent before the room finished binding must still be answered; frames: ${earlyFrames.map((f) => f.type).join(",")}`);
			early.close();
			// The room is single-occupancy, so the flip below needs this one gone.
			await new Promise((resolve) => setTimeout(resolve, 250));
		})();

		const frames: any[] = [];
		const socket = new WebSocketImpl(
			`ws://127.0.0.1:${port}/ws?persistentAgentId=${roomId}&conversationId=${conversationId}&modelProvider=anthropic&model=claude-opus-5&reattach=1`,
			{ headers: { ...SMOKE_AUTH_HEADERS } },
		);
		socket.addEventListener("message", (event: { data: unknown }) => {
			try { frames.push(JSON.parse(String(event.data))); } catch {}
		});
		await new Promise<void>((resolve, reject) => {
			socket.addEventListener("open", () => resolve());
			socket.addEventListener("error", () => reject(new Error("websocket failed to connect")));
		});

		async function liveTurn(label: string): Promise<any> {
			for (let attempt = 0; attempt < 40; attempt++) {
				const before = captured.length;
				const fromIndex = frames.length;
				socket.send(JSON.stringify({ type: "prompt", text: "Say something short." }));
				const settleDeadline = Date.now() + 25_000;
				let settled: any = null;
				while (Date.now() < settleDeadline && !settled) {
					for (let i = fromIndex; i < frames.length; i++) {
						const row = frames[i];
						if (row.type === "event" && row.event?.type === "agent_end") { settled = row; break; }
						if (row.type === "error" && /still running|is cancelling/.test(String(row.message ?? ""))) { settled = row; break; }
					}
					if (!settled) await new Promise((resolve) => setTimeout(resolve, 25));
				}
				if (!settled) throw new Error(`${label}: the turn never settled; frames: ${frames.map((f) => f.type).join(",")}`);
				if (settled.type === "error") { await new Promise((resolve) => setTimeout(resolve, 250)); continue; }
				assert(captured.length > before, `${label}: the turn never reached the provider`);
				return captured[before].body;
			}
			throw new Error(`${label}: the room never accepted a new turn`);
		}

		async function putProviderSearch(value: boolean): Promise<void> {
			const response = await authedFetch(`${baseUrl}/api/settings/web-search`, {
				method: "PUT",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ providerSearch: value }),
			});
			assert(response.ok, `saving providerSearch=${value} failed with ${response.status}`);
		}

		await putProviderSearch(true);
		const first = await liveTurn("provider search on");
		assert(first.tools?.some((tool: any) => tool.type === "web_search_20250305"), `the live room should declare the provider's search, got ${JSON.stringify(toolNames(first))}`);
		assert(!first.tools?.some((tool: any) => tool.name === "web_search" && !tool.type), `and not register its own, got ${JSON.stringify(toolNames(first))}`);

		// The change lands while the socket stays open and the room stays put.
		await putProviderSearch(false);
		const second = await liveTurn("provider search off");
		assert(!second.tools?.some((tool: any) => tool.type === "web_search_20250305"), `the next message must drop the declaration with no reconnect, got ${JSON.stringify(toolNames(second))}`);
		assert(second.tools?.some((tool: any) => tool.name === "web_search" && !tool.type), `and the room's own web_search must be registered again, got ${JSON.stringify(toolNames(second))}`);

		await putProviderSearch(true);
		const third = await liveTurn("provider search back on");
		assert(third.tools?.some((tool: any) => tool.type === "web_search_20250305"), `and back again, still no reconnect, got ${JSON.stringify(toolNames(third))}`);
		// Honest about what this last assertion can and cannot see. The payload
		// filter would remove a client web_search whether or not the session
		// registered one, so its absence here is not by itself proof that the
		// session rebound. The load-bearing assertion is the one above: a client
		// web_search can only APPEAR in a payload if the session actually
		// registered it, so turn two seeing it come back is what proves the
		// rebind happened and that registration follows the setting. This turn
		// confirms the return trip.
		assert(!third.tools?.some((tool: any) => tool.name === "web_search" && !tool.type), `with the local tool standing down once more, got ${JSON.stringify(toolNames(third))}`);

		// A credential store that cannot be read must NOT flip a bound session:
		// rebuilding it would cost the room its warm cache over a hiccup that
		// says nothing about how anybody signs in. The pair below is what makes
		// this a real assertion rather than a vacuous one. First the unreadable
		// case, which must change nothing.
		const authPath = path.join(agentDir, "auth.json");
		const authBackup = fs.readFileSync(authPath, "utf-8");
		fs.writeFileSync(authPath, "{ not json at all", { mode: 0o600 });
		const duringHiccup = await liveTurn("credential store unreadable");
		assert(duringHiccup.tools?.some((tool: any) => tool.type === "web_search_20250305"),
			`an unreadable credential store must leave the session as it bound, got ${JSON.stringify(toolNames(duringHiccup))}`);

		// Then a real change through the same file, which must flip. Without this
		// half, the assertion above would also pass on a server that never reads
		// the file again at all.
		const parsedAuth = JSON.parse(authBackup);
		parsedAuth.anthropic = { type: "api_key", key: "sk-ant-api-synthetic-do-not-print" };
		fs.writeFileSync(authPath, JSON.stringify(parsedAuth), { mode: 0o600 });
		const afterRealChange = await liveTurn("switched to an API key");
		assert(!afterRealChange.tools?.some((tool: any) => tool.type === "web_search_20250305"),
			`switching to an API key must stop provider search, got ${JSON.stringify(toolNames(afterRealChange))}`);
		assert(afterRealChange.tools?.some((tool: any) => tool.name === "web_search" && !tool.type),
			`and must give the room its own web_search back, got ${JSON.stringify(toolNames(afterRealChange))}`);
		fs.writeFileSync(authPath, authBackup, { mode: 0o600 });

		try { socket.close(); } catch {}
	} catch (error) {
		const output = serverOutput.join("").trim();
		if (output) console.error(output.split("\n").slice(-40).join("\n"));
		throw error;
	} finally {
		await stopSmokeServer(server as any);
	}
}

try {
	const { applyNativeProviderSearch, resolveNativeProviderSearchDecision, isNativeSearchProvider, shouldRegisterClientWebSearch, stripProviderSearchFromModel } =
		await import("../../../pi-package/extensions/web-search/native-provider-search.js");
	const { resolveWebSearchSettings } = await import("../../../pi-package/extensions/web-search/index.js");

	// ---- which providers search for themselves ------------------------------
	setProviderSearch(undefined);
	setAnthropicAuth("oauth");
	assert(isNativeSearchProvider("anthropic"), "the Claude profile's provider searches for itself");
	assert(isNativeSearchProvider("openai-codex"), "the ChatGPT profile's provider searches for itself");
	assert(!isNativeSearchProvider("openai"), "the API-key OpenAI path is not a subscription profile and is out of scope");
	assert(!isNativeSearchProvider("openai-compatible"), "a gateway is somebody else's endpoint with no server search behind it");
	assert(!isNativeSearchProvider("gateway-project"), "and so is every gateway minted after the first");
	assert(!isNativeSearchProvider(undefined), "a session with no model resolved yet declares nothing");

	// Absent from the file means on: an install upgraded from the version that
	// had no such setting must not lose the better search.
	assert(resolveNativeProviderSearchDecision("anthropic").active, "provider search is on by default");
	assert(!resolveNativeProviderSearchDecision("openai-compatible").active, "the default never reaches a gateway");

	// ---- (a) anthropic: declaration in, client tool out ---------------------
	const anthropicOn = applyNativeProviderSearch(
		{ model: "claude-x", max_tokens: 1000, tools: [CLIENT_WEB_SEARCH_ANTHROPIC, CLIENT_FETCH_URL] },
		"anthropic",
	) as any;
	assert(anthropicOn.tools.length === 2, `one tool in, one tool out, got ${JSON.stringify(toolNames(anthropicOn))}`);
	const anthropicDeclaration = anthropicOn.tools.find((tool: any) => tool.type === "web_search_20250305");
	assert(anthropicDeclaration, `the versioned server tool must be declared, got ${JSON.stringify(anthropicOn.tools)}`);
	assert(anthropicDeclaration.name === "web_search", "the server tool carries the name the provider expects");
	assert(typeof anthropicDeclaration.max_uses === "number", `a bound on searches per turn is part of the declaration, got ${JSON.stringify(anthropicDeclaration)}`);
	assert(!anthropicOn.tools.some((tool: any) => tool.name === "web_search" && !tool.type), "the room's own web_search must not ride along beside it");
	assert(anthropicOn.tools.some((tool: any) => tool.name === "fetch_url"), "fetch_url is a different job and stays");
	assert(anthropicOn.model === "claude-x" && anthropicOn.max_tokens === 1000, "nothing else about the request is touched");

	// A room whose tool policy left it with no tools at all still gets one:
	// both providers only set `tools` when there is something to put in it, so
	// the array has to be created rather than appended to.
	const anthropicNoTools = applyNativeProviderSearch({ model: "claude-x", max_tokens: 1000 }, "anthropic") as any;
	assert(anthropicNoTools.tools?.length === 1 && anthropicNoTools.tools[0].type === "web_search_20250305", `a request with no tools array must grow one, got ${JSON.stringify(anthropicNoTools)}`);

	// A payload that has already been through here (a retry) must not collect a
	// second copy of the same declaration.
	const twice = applyNativeProviderSearch(anthropicOn, "anthropic") as any;
	assert(twice.tools.filter((tool: any) => tool.type === "web_search_20250305").length === 1, `a retried payload must not declare twice, got ${JSON.stringify(twice.tools)}`);

	// ---- (c) the codex surface, same rule, its own shape --------------------
	const codexOn = applyNativeProviderSearch(
		{ model: "gpt-5.6", input: [], tools: [CLIENT_WEB_SEARCH_CODEX, CLIENT_FETCH_URL] },
		"openai-codex",
	) as any;
	assert(codexOn.tools.some((tool: any) => tool.type === "web_search"), `the codex declaration must be present, got ${JSON.stringify(codexOn.tools)}`);
	assert(!codexOn.tools.some((tool: any) => tool.type === "function" && tool.name === "web_search"), `the client function tool must be removed, got ${JSON.stringify(codexOn.tools)}`);
	assert(codexOn.tools.some((tool: any) => tool.name === "fetch_url"), "fetch_url survives here too");
	assert(!codexOn.tools.some((tool: any) => tool.type === "web_search_20250305"), "the two providers never get each other's declaration");

	// ---- (d) everything else is left completely alone -----------------------
	for (const provider of ["openai-compatible", "gateway-project-gateway", "openai", "google", "zai"]) {
		const payload = { model: "m", tools: [CLIENT_WEB_SEARCH_ANTHROPIC, CLIENT_FETCH_URL] };
		const untouched = applyNativeProviderSearch(payload, provider) as any;
		assert(untouched === payload, `${provider} must get the payload back unchanged, by identity`);
		assert(untouched.tools.some((tool: any) => tool.name === "web_search"), `${provider} keeps the room's own web_search`);
	}

	// ---- which sessions register the room's own web_search ------------------
	// The rule the two binding sites actually call. Asserted here rather than
	// inferred from a payload, because a request cannot tell you whether the
	// client tool was never registered or was registered and then filtered out
	// on the way past, and only the first of those is the intended behaviour.
	setProviderSearch(true);
	assert(!shouldRegisterClientWebSearch(resolveNativeProviderSearchDecision("anthropic")), "a Claude room with provider search on must not register the local tool");
	assert(!shouldRegisterClientWebSearch(resolveNativeProviderSearchDecision("openai-codex")), "nor a ChatGPT room");
	assert(shouldRegisterClientWebSearch(resolveNativeProviderSearchDecision("openai-compatible")), "a gateway room always registers it");
	assert(shouldRegisterClientWebSearch(resolveNativeProviderSearchDecision(undefined)), "and so does a session with no model resolved");
	setProviderSearch(false);
	for (const provider of ["anthropic", "openai-codex", "openai-compatible"]) {
		assert(shouldRegisterClientWebSearch(resolveNativeProviderSearchDecision(provider)), `with provider search off every room registers the local tool, ${provider} did not`);
	}

	// ---- (b) the toggle, and what it means ----------------------------------
	setProviderSearch(false);
	assert(!resolveNativeProviderSearchDecision("anthropic").active, "turning the toggle off takes the declaration away from Claude rooms");
	assert(!resolveNativeProviderSearchDecision("openai-codex").active, "and from ChatGPT rooms");
	setProviderSearch(true);
	assert(resolveNativeProviderSearchDecision("anthropic").active, "and turning it back on restores it");

	// The setting is read per call, never captured. This is what lets a room
	// pick up a change on its next message instead of its next restart.
	setProviderSearch(false);
	assert(!resolveNativeProviderSearchDecision("anthropic").active, "a file written under the resolver's feet is read on the very next call");
	setProviderSearch(true);
	assert(resolveNativeProviderSearchDecision("anthropic").active, "and again, in the other direction, in one process");

	// ---- the environment variable governs the local backend only ------------
	process.env.EXXETA_SEARCH_PROVIDER = "disabled";
	assert(resolveNativeProviderSearchDecision("anthropic").active, "switching the local backend off must not switch provider search off");
	delete process.env.EXXETA_SEARCH_PROVIDER;

	// ---- an API key is not a subscription -----------------------------------
	// Anthropic's provider id covers two customers. The subscription includes
	// the search; an API key is billed per thousand searches, and turning that
	// on by default would be spending somebody's money for them.
	setProviderSearch(true);
	setAnthropicAuth("api_key");
	assert(!resolveNativeProviderSearchDecision("anthropic").active, "an API-key Anthropic user must not get provider search");
	assert(shouldRegisterClientWebSearch(resolveNativeProviderSearchDecision("anthropic")), "and must keep the app's own web_search tool");
	setAnthropicAuth("none");
	assert(!resolveNativeProviderSearchDecision("anthropic").active, "no credential at all is not a subscription either");
	// The Codex surface only exists as a subscription, so it needs no such check.
	assert(resolveNativeProviderSearchDecision("openai-codex").active, "the ChatGPT profile is unaffected by the Anthropic credential");
	setAnthropicAuth("oauth");
	assert(resolveNativeProviderSearchDecision("anthropic").active, "a subscription sign-in gets it back");

	// ---- a question we could not ask is not an answer -----------------------
	// The bind-time decision is compared against a live one before each turn to
	// notice a settings change. A momentary failure to read the credential store
	// must not read as "they switched to an API key", or a room rebuilds its
	// session and throws away a warm cache over a hiccup.
	setProviderSearch(true);
	setAnthropicAuth("oauth");
	const determinate = resolveNativeProviderSearchDecision("anthropic");
	assert(determinate.active && !determinate.indeterminate, `a readable answer is not flagged, got ${JSON.stringify(determinate)}`);
	// A real answer, not an error: an API key is a decision somebody made.
	setAnthropicAuth("api_key");
	const apiKeyAnswer = resolveNativeProviderSearchDecision("anthropic");
	assert(!apiKeyAnswer.active && !apiKeyAnswer.indeterminate, `an API key is an answer, not a failure, got ${JSON.stringify(apiKeyAnswer)}`);

	// A credential store that cannot be opened is the one genuinely unanswerable
	// case: it says nothing about how somebody signs in. Reached here by making
	// auth.json unreadable rather than by trusting a comment.
	const authPath = path.join(agentDir, "auth.json");
	const authBackup = fs.readFileSync(authPath, "utf-8");
	fs.writeFileSync(authPath, "{ not json at all", { mode: 0o600 });
	const unreadableCredentials = resolveNativeProviderSearchDecision("anthropic");
	assert(unreadableCredentials.active === false, "a credential store we cannot read still resolves to the safe answer");
	assert(unreadableCredentials.indeterminate === true, `and must flag the answer as a guess, got ${JSON.stringify(unreadableCredentials)}`);
	fs.writeFileSync(authPath, authBackup, { mode: 0o600 });
	setAnthropicAuth("oauth");

	// Unreadable SETTINGS are the opposite case and deliberately not flagged.
	// That file is where somebody turns provider search off, so failing closed
	// there has to be a hard answer: a session already running under a yes gets
	// rebuilt and stops sending queries out, which is the entire point.
	fs.writeFileSync(configPath, "{ broken", { mode: 0o600 });
	const brokenSettings = resolveNativeProviderSearchDecision("anthropic");
	assert(brokenSettings.active === false, "unreadable settings mean no provider search");
	assert(!brokenSettings.indeterminate, `and must be a hard answer so a bound session flips, got ${JSON.stringify(brokenSettings)}`);
	setProviderSearch(true);

	// ---- a config nobody can read is not a config nobody wrote --------------
	// Failing open here would hand a deployment the one behaviour it may have
	// explicitly turned off, on the strength of a parse error.
	fs.writeFileSync(configPath, "{ this is not json", { mode: 0o600 });
	const broken = resolveWebSearchSettings();
	assert(broken.unreadable, "an unparseable settings file must say so rather than read as empty");
	assert(broken.providerSearch === false, `an unreadable file must fail closed on provider search, got ${JSON.stringify(broken)}`);
	assert(broken.provider === "duckduckgo", `the local backend falls back to the zero-setup default, got ${JSON.stringify(broken)}`);
	assert(!resolveNativeProviderSearchDecision("anthropic").active, "and no room searches through its provider while it is broken");
	fs.rmSync(configPath);
	const absent = resolveWebSearchSettings();
	assert(!absent.unreadable && absent.providerSearch === true, `an absent file is a different answer from a broken one, got ${JSON.stringify(absent)}`);

	// ---- restricted workers never inherit the gateway flag ------------------
	// Memorize, Review, consult and the specialists run on a model somebody
	// chose elsewhere, and a gateway may point its maintenance model at one of
	// its room models. The mark belongs to the room.
	const flagged = { id: "m", provider: "gateway-x", compat: { supportsWebSearch: true, supportsStrictMode: false } };
	const stripped = stripProviderSearchFromModel(flagged) as any;
	assert(stripped.compat.supportsWebSearch === undefined, `a worker model must not keep the web-search flag, got ${JSON.stringify(stripped)}`);
	assert(stripped.compat.supportsStrictMode === false, "and must keep every other compat key it had");
	assert(stripped.id === "m" && stripped.provider === "gateway-x", "id and provider are untouched, since the worker runtimes check them");
	const unflagged = { id: "m", provider: "gateway-x", compat: { supportsStrictMode: false } };
	assert(stripProviderSearchFromModel(unflagged) === unflagged, "a model without the flag is returned by identity, not copied");
	const noCompat = { id: "m", provider: "gateway-x" };
	assert(stripProviderSearchFromModel(noCompat) === noCompat, "and so is a model with no compat block at all");

	// ---- and now the same rule through a real room turn ---------------------
	// Everything above is the transform in isolation. This drives an actual
	// background run against a stubbed provider endpoint and reads what left the
	// machine, which is the only way to prove the other half of the rule: that
	// the room's own web_search really is absent from the session, rather than
	// merely filtered out of the payload on the way past.
	await runRoomTurnChecks();
	// Three background turns and three live ones. A refactor that quietly stops
	// driving real turns would otherwise leave every assertion above vacuously
	// true, so the count of requests that actually left is itself asserted.
	const anthropicTurns = captured.filter((request) => request.path === "/anthropic/v1/messages").length;
	assert(captured.length >= 6, `every turn should have reached the stub, got ${captured.length}: ${JSON.stringify(captured.map((r) => r.path))}`);
	assert(anthropicTurns >= 5, `the Claude turns are the point of this smoke, got ${anthropicTurns}`);

	fs.rmSync(tempHome, { recursive: true, force: true });
	console.log("native provider search smoke passed");
} catch (error) {
	console.error(error instanceof Error ? error.stack || error.message : error);
	console.error(`temp HOME preserved for inspection: ${tempHome}`);
	process.exitCode = 1;
}
