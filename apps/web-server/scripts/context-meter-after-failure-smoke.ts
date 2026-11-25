import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import http from "node:http";
import type { AddressInfo } from "node:net";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { authedFetch, freePort, type AuthedFetchInit, SMOKE_AUTH_HEADERS, SMOKE_SERVER_AUTH_ENV, SMOKE_SERVER_SPAWN_TREE_OPTIONS, smokeHomeEnv, stopSmokeServer, waitForServer } from "./smoke-server-process.js";

// What the page is told about the context when an answer ends without having
// moved usage, against a real spawned server and a synthetic gateway. The
// session always knew: its reading is the last good answer's usage plus an
// estimate of every message after it. The page was told only with usage, so
// the meter kept its old number while every answer failed. Each row has its
// own room, the first six with one good answer in it:
//   1. an answer that fails part way keeps its message above, in the reading;
//   2. an answer the person stops, the same;
//   3. a message handed back to the box has left the conversation, so the
//      reading is the one before it; kept above after all, it is in it again;
//   4. a message refused before it was sent changes nothing;
//   5. right after a shortening the reading is unknown, never the old number;
//   6. a good answer's reading comes once more at its end, the same one.
// Beside each: no usage row, and no usage or cost in the frame.
// The last four start with nothing said. A conversation with no good answer
// has no usage to read, so its reading adds the instructions and the tools the
// model is sent to its messages, as the model was sent them here:
//   7. its first answer is stopped, then one succeeds;
//   8. its first answer fails part way, then one succeeds;
//   9. its first message is handed back to the box, then kept above after all;
//  10. its first message is refused before it was sent.

const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), "exxperts-meter-after-failure-home-"));
const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const webServerDir = path.resolve(scriptDir, "..");
const repoRoot = path.resolve(webServerDir, "..", "..");
const port = await freePort();
const baseUrl = `http://127.0.0.1:${port}`;
const agentDir = path.join(tempHome, ".exxperts", "agent");
const productAppRoot = path.join(tempHome, ".exxperts", "app");

const GOOD_TOKENS = 1_240;
// 4,000 characters, counted as 1,000 tokens; the answer's few words and any note the room adds stay under 200.
const LONG_TEXT = "word ".repeat(800);
const ADDED_AT_MOST = 200;
// The first message of a conversation brings the room's state with it.
const ROOM_STATE_AT_MOST = 500;

function assert(condition: unknown, message: string): asserts condition {
	if (!condition) throw new Error(message);
}

/** What the last request sent besides its messages, and all of it, in characters / 4. */
let sent = { instructionsAndTools: 0, all: 0 };

const tokens = (text: string): number => Math.ceil(text.length / 4);

const sseChunk = (payload: unknown): string => `data: ${JSON.stringify(payload)}\n\n`;

const gateway = http.createServer((req, res) => {
	if (req.method !== "POST" || !String(req.url ?? "").endsWith("/chat/completions")) {
		res.writeHead(404).end();
		return;
	}
	let body = "";
	req.on("data", (chunk) => { body += chunk; });
	req.on("end", () => {
		const parsed = JSON.parse(body);
		const instructions = parsed.messages.filter((message: any) => message.role === "system" || message.role === "developer").map((message: any) => (typeof message.content === "string" ? message.content : message.content.map((part: any) => part.text).join(""))).join("");
		const tools = (parsed.tools ?? []).map((tool: any) => ({ name: tool.function.name, description: tool.function.description, parameters: tool.function.parameters }));
		sent = { instructionsAndTools: tokens(instructions) + tokens(JSON.stringify(tools)), all: tokens(JSON.stringify(parsed.messages)) + tokens(JSON.stringify(parsed.tools ?? [])) };
		// The room's state may follow the message, so the last message that asks for something special is the one answered.
		const asked = parsed.messages.filter((message: any) => message.role === "user").map((message: any) => JSON.stringify(message.content)).findLast((text: string) => /FAILS-AT-ONCE|FAILS-MIDWAY|STOPPED|COUNTED/.test(text)) ?? "";
		if (asked.includes("FAILS-AT-ONCE")) {
			res.writeHead(400, { "content-type": "application/json" });
			res.end(JSON.stringify({ error: { message: "the request is odd", type: "invalid_request_error" } }));
			return;
		}
		res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
		const base = { id: "cmpl_smoke", object: "chat.completion.chunk", created: Math.floor(Date.now() / 1000), model: parsed.model };
		res.write(sseChunk({ ...base, choices: [{ index: 0, delta: { role: "assistant", content: "Some words." }, finish_reason: null }] }));
		if (asked.includes("FAILS-MIDWAY")) {
			res.write(sseChunk({ error: { message: "the request is odd", type: "invalid_request_error" } }));
			res.end();
			return;
		}
		// Stopped by the person: the connection closes with the answer still open.
		if (asked.includes("STOPPED")) return;
		const promptTokens = asked.includes("COUNTED") ? sent.all : 1_200;
		res.write(sseChunk({ ...base, choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: promptTokens, completion_tokens: 40, total_tokens: promptTokens + 40 } }));
		res.write("data: [DONE]\n\n");
		res.end();
	});
});

async function requestJson(pathname: string, init?: AuthedFetchInit): Promise<{ status: number; body: any }> {
	const response = await authedFetch(`${baseUrl}${pathname}`, init);
	const text = await response.text();
	return { status: response.status, body: text ? JSON.parse(text) : null };
}

async function createRoom(displayName: string): Promise<string> {
	const response = await requestJson("/api/persistent-agents", {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ displayName, userName: "Synthetic User", preferredUserAddress: "Synthetic User" }),
	});
	assert(response.status === 201, `room creation should return 201, got ${response.status}: ${JSON.stringify(response.body)}`);
	const id = String(response.body?.agent?.id ?? "");
	assert(id, `room creation should return an agent id, got ${JSON.stringify(response.body)}`);
	return id;
}

async function putThread(agentId: string, threadId: string, modelId: string, items: unknown[]): Promise<void> {
	// The server decides a new conversation's model: the room's conversation
	// pick, set first the way Room settings sets it.
	const pick = await requestJson(`/api/persistent-agents/${agentId}/models`, {
		method: "PUT",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ conversation: { provider: "openai-compatible", model: modelId } }),
	});
	assert(pick.status === 200, `the room's conversation pick should be set, got ${pick.status}: ${JSON.stringify(pick.body)}`);
	const response = await requestJson(`/api/persistent-agents/${agentId}/threads/${threadId}`, {
		method: "PUT",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ state: "active", origin: "launcher", model: { provider: "openai-compatible", model: modelId }, items }),
	});
	assert(response.status === 200, `thread PUT should return 200, got ${response.status}: ${JSON.stringify(response.body)}`);
}

async function readThread(agentId: string, threadId: string): Promise<any> {
	const response = await requestJson(`/api/persistent-agents/${agentId}/threads/${threadId}`);
	assert(response.status === 200, `thread GET should return 200, got ${response.status}: ${JSON.stringify(response.body)}`);
	return response.body?.thread;
}

function roomRootPath(agentId: string): string {
	return path.join(tempHome, ".exxperts", "app", "personalized-agents", agentId);
}

type Frame = Record<string, any>;

const WebSocketImpl: any = (await import("ws")).default;

class WsHarness {
	readonly frames: Frame[] = [];
	private socket: any;

	private constructor(socket: any) {
		this.socket = socket;
		socket.addEventListener("message", (event: { data: unknown }) => {
			try { this.frames.push(JSON.parse(String(event.data))); } catch {}
		});
	}

	static async connect(persistentAgentId: string, conversationId: string, modelId: string): Promise<WsHarness> {
		const socket = new WebSocketImpl(`ws://127.0.0.1:${port}/ws?persistentAgentId=${persistentAgentId}&conversationId=${conversationId}&modelProvider=openai-compatible&model=${modelId}&reattach=1`, { headers: { ...SMOKE_AUTH_HEADERS } });
		const harness = new WsHarness(socket);
		await new Promise<void>((resolve, reject) => {
			socket.addEventListener("open", () => resolve());
			socket.addEventListener("error", () => reject(new Error("websocket failed to connect")));
		});
		return harness;
	}

	send(frame: Frame): void {
		this.socket.send(JSON.stringify(frame));
	}

	close(): void {
		try { this.socket.close(); } catch {}
	}

	async waitFor(predicate: (frame: Frame) => boolean, label: string, fromIndex = 0, timeoutMs = 25_000): Promise<number> {
		const deadline = Date.now() + timeoutMs;
		let index = fromIndex;
		while (Date.now() < deadline) {
			for (; index < this.frames.length; index++) {
				if (predicate(this.frames[index])) return index;
			}
			await new Promise((resolve) => setTimeout(resolve, 25));
		}
		const errors = this.frames.filter((frame) => String(frame.type).includes("error")).map((frame) => frame.message).join(" | ");
		throw new Error(`timed out waiting for ${label}; saw frame types: ${this.frames.map((frame) => frame.type).join(", ")}${errors ? `; errors: ${errors}` : ""}`);
	}
}

function smokeEnv(): NodeJS.ProcessEnv {
	const env = smokeHomeEnv(tempHome, { PORT: String(port), ...SMOKE_SERVER_AUTH_ENV, EXXETA_HOME: repoRoot, EXXETA_PERSISTENT_AGENTS_ROOT: path.join(productAppRoot, "personalized-agents") }) as NodeJS.ProcessEnv;
	for (const key of [
		"ANTHROPIC_API_KEY",
		"ANTHROPIC_OAUTH_TOKEN",
		"OPENAI_API_KEY",
		"AZURE_OPENAI_API_KEY",
		"EXXETA_AI_API_KEY",
		"COPILOT_GITHUB_TOKEN",
		"GH_TOKEN",
		"GITHUB_TOKEN",
		"GEMINI_API_KEY",
		"GOOGLE_CLOUD_API_KEY",
		"OPENROUTER_API_KEY",
	]) {
		delete env[key];
	}
	env.EXXPERTS_CODING_AGENT_DIR = agentDir;
	return env;
}


function usageRows(agentId: string): any[] {
	const file = path.join(productAppRoot, "usage.jsonl");
	if (!fs.existsSync(file)) return [];
	return fs.readFileSync(file, "utf-8").split("\n").filter(Boolean).map((line) => JSON.parse(line)).filter((row) => row.agent === agentId);
}

interface Room { agentId: string; conversationId: string; ws: WsHarness }

/** Connects to the room's conversation and returns the reading its page opens with. */
async function connect(room: Omit<Room, "ws">): Promise<{ ws: WsHarness; health: any }> {
	const ws = await WsHarness.connect(room.agentId, room.conversationId, "smoke-model");
	open.push(ws);
	const ready = await ws.waitFor((frame) => frame.type === "ready", "ready frame");
	return { ws, health: ws.frames[ready].contextHealth };
}

/** A room with nothing said in it, its connection open and idle. */
async function openEmptyRoom(name: string): Promise<Room> {
	const agentId = await createRoom(name);
	const conversationId = `meter_${agentId}`;
	await putThread(agentId, conversationId, "smoke-model", []);
	const { ws, health } = await connect({ agentId, conversationId });
	assert(health.tokens === 0, `a conversation with no message holds nothing, got ${JSON.stringify(health)}`);
	return { agentId, conversationId, ws };
}

/** A room whose first answer landed, its connection open and idle. */
async function openRoom(name: string): Promise<Room> {
	const room = await openEmptyRoom(name);
	const from = await send(room, "Say something short.");
	await room.ws.waitFor((frame) => frame.type === "usage_turn" && frame.input > 0 && frame.contextHealth?.tokens === GOOD_TOKENS, "the good answer's usage", from);
	await idle(room);
	return room;
}

const send = async (room: Room, text: string): Promise<number> => {
	const from = room.ws.frames.length;
	room.ws.send({ type: "prompt", text });
	return from;
};

async function idle(room: Room): Promise<void> {
	for (const deadline = Date.now() + 15_000; (await requestJson(`/api/persistent-agents/${room.agentId}/status`)).body?.activeThread?.inFlight !== false;) {
		assert(Date.now() < deadline, "the turn should settle");
		await new Promise((resolve) => setTimeout(resolve, 50));
	}
}

/** The reading sent with no usage beside it, after the answer's end. It carries nothing a page could count. */
async function readingAfter(room: Room, from: number): Promise<any> {
	const at = await room.ws.waitFor((frame) => frame.type === "usage_turn" && frame.input === undefined, "the reading at the answer's end", from, 8_000);
	const frame = room.ws.frames[at];
	const extra = Object.keys(frame).filter((key) => !["type", "agent", "contextHealth", "seq"].includes(key));
	assert(extra.length === 0, `the reading carries no usage, cost or model, got ${extra.join(", ")}`);
	return frame.contextHealth;
}

/** Leaves the room. What its session writes last is written once the room is nobody's. */
async function leave(room: Room): Promise<void> {
	const lock = path.join(productAppRoot, ".room-locks", `${room.agentId}.json`);
	assert(fs.existsSync(lock), "an open room holds its lock");
	room.ws.close();
	for (const deadline = Date.now() + 10_000; fs.existsSync(lock);) {
		assert(Date.now() < deadline, "the room is let go");
		await new Promise((resolve) => setTimeout(resolve, 50));
	}
}

/** Leaves the room and opens its conversation again; returns the reading its page opens with. */
async function reopen(room: Room): Promise<any> {
	await leave(room);
	const { ws, health } = await connect(room);
	room.ws = ws;
	return health;
}

const passes: string[] = [];
const failures: string[] = [];
const open: WsHarness[] = [];
async function row(label: string, check: () => Promise<void>): Promise<void> {
	try {
		await check();
		passes.push(label);
		console.log(`  ok ${label}`);
	} catch (error) {
		failures.push(label);
		console.error(`  FAILED ${label}: ${(error as Error).message}`);
	}
}

function assertMessageCounted(health: any): void {
	assert(health?.tokens >= GOOD_TOKENS + 1_000 && health.tokens < GOOD_TOKENS + 1_000 + ADDED_AT_MOST, `the reading holds the last good answer and the message after it, got ${JSON.stringify(health)}`);
	assert(health.zone === "green" && Math.abs(health.checkpointPercent - (health.tokens / health.checkpointTokens) * 100) < 0.0001, `the percentage follows the tokens, got ${JSON.stringify(health)}`);
}

/**
 * The reading with no good answer to count from: what was sent besides the
 * messages, and the messages. Reopened, the room-tools lines of the
 * instructions come with the next message, so it may hold less by those.
 */
function assertFirstMessageCounted(health: any, reopened = false): void {
	const least = sent.instructionsAndTools + 1_000 - (reopened ? ADDED_AT_MOST : 0);
	assert(sent.instructionsAndTools > 1_000, `the model was sent instructions and tools, got ${sent.instructionsAndTools}`);
	assert(health?.tokens >= least && health.tokens < sent.instructionsAndTools + 1_000 + ROOM_STATE_AT_MOST, `the reading holds the ${sent.instructionsAndTools} tokens of instructions and tools and the message, got ${JSON.stringify(health)}`);
	assert(Math.abs(health.checkpointPercent - (health.tokens / health.checkpointTokens) * 100) < 0.0001, `the percentage follows the tokens, got ${JSON.stringify(health)}`);
}

/** The next answer lands, its count set to the size of what was sent: the provider's count stands alone, and the reading before it was within a third of it. */
async function assertNextAnswerClose(room: Room, before: number): Promise<void> {
	const from = await send(room, "COUNTED Say something short.");
	const health = await readingAfter(room, from);
	assert(health.tokens === sent.all + 40, `a finished answer's reading is the provider's count, ${sent.all + 40}, got ${JSON.stringify(health)}`);
	assert(Math.abs(health.tokens - before) <= health.tokens / 3, `the reading before, ${before}, is within a third of the one after, ${health.tokens}`);
	await idle(room);
	assertOneUsageRow(room);
}

function assertOneUsageRow(room: Room): void {
	const rows = usageRows(room.agentId);
	assert(rows.length === 1 && rows[0].output === 40, `only the good answer has a usage row, got ${JSON.stringify(rows)}`);
}

let server: ChildProcessWithoutNullStreams | null = null;
const serverOutput: string[] = [];

try {
	await new Promise<void>((resolve) => gateway.listen(0, "127.0.0.1", resolve));
	const gatewayPort = (gateway.address() as AddressInfo).port;
	fs.mkdirSync(agentDir, { recursive: true, mode: 0o700 });
	fs.mkdirSync(productAppRoot, { recursive: true, mode: 0o700 });
	const write = (file: string, value: unknown) => fs.writeFileSync(file, JSON.stringify(value), { mode: 0o600 });
	write(path.join(agentDir, "models.json"), { providers: { "openai-compatible": { name: "Synthetic SSE Gateway", baseUrl: `http://127.0.0.1:${gatewayPort}/v1`, api: "openai-completions", models: [{ id: "smoke-model", name: "Smoke Model", contextWindow: 200_000, maxTokens: 16_384 }] } } });
	write(path.join(agentDir, "auth.json"), { "openai-compatible": { type: "api_key", key: "synthetic-meter-key" } });
	write(path.join(productAppRoot, "openai-compatible-ai-profile.json"), { profileId: "openai-compatible", providerId: "openai-compatible", label: "Synthetic SSE Gateway", roomModels: [{ modelId: "smoke-model", label: "Smoke Model" }], maintenanceModel: "smoke-model" });
	write(path.join(productAppRoot, "persistent-agent-ai-profile.json"), { profileId: "openai-compatible" });

	server = spawn("npx", ["tsx", "src/index.ts"], { shell: process.platform === "win32", ...SMOKE_SERVER_SPAWN_TREE_OPTIONS, cwd: webServerDir, env: smokeEnv() });
	server.stdout.on("data", (chunk) => serverOutput.push(String(chunk)));
	server.stderr.on("data", (chunk) => serverOutput.push(String(chunk)));
	await waitForServer(server, baseUrl, 20_000);

	await row("an answer that fails part way: its message is in the reading", async () => {
		const room = await openRoom("Fails midway");
		const from = await send(room, `FAILS-MIDWAY ${LONG_TEXT}`);
		const ended = await room.ws.waitFor((frame) => frame.type === "event" && frame.event?.type === "message_end" && frame.event.message?.role === "assistant" && frame.event.message.stopReason === "error", "the failed answer", from);
		assertMessageCounted(await readingAfter(room, ended));
		await idle(room);
		assertOneUsageRow(room);
	});

	await row("an answer the person stops: its message is in the reading", async () => {
		const room = await openRoom("Stopped");
		const from = await send(room, `STOPPED ${LONG_TEXT}`);
		await room.ws.waitFor((frame) => frame.type === "event" && frame.event?.type === "message_update", "the first words", from);
		room.ws.send({ type: "abort" });
		const ended = await room.ws.waitFor((frame) => frame.type === "event" && frame.event?.type === "agent_end", "the stopped answer's end", from);
		assertMessageCounted(await readingAfter(room, ended));
		await idle(room);
		assertOneUsageRow(room);
	});

	await row("a message handed back leaves the reading at the number before it, and is in it when the page keeps it", async () => {
		const room = await openRoom("Handed back");
		const from = await send(room, `FAILS-AT-ONCE ${LONG_TEXT}`);
		const returned = await room.ws.waitFor((frame) => frame.type === "prompt_returned", "the message handed back", from);
		const health = await readingAfter(room, from);
		assert(health.tokens === GOOD_TOKENS, `the message has left the conversation, got ${JSON.stringify(health)}`);
		await idle(room);
		room.ws.send({ type: "returned_prompt_handled", kept: true });
		assertMessageCounted(await readingAfter(room, returned));
		assertOneUsageRow(room);
	});

	await row("a message refused before it was sent changes no reading", async () => {
		const room = await openRoom("Refused");
		write(path.join(agentDir, "auth.json"), {});
		try {
			const from = await send(room, LONG_TEXT);
			const refused = await room.ws.waitFor((frame) => frame.type === "error", "the refusal", from);
			const health = await readingAfter(room, refused);
			assert(health.tokens === GOOD_TOKENS, `nothing was sent, got ${JSON.stringify(health)}`);
			await idle(room);
			assertOneUsageRow(room);
		} finally {
			write(path.join(agentDir, "auth.json"), { "openai-compatible": { type: "api_key", key: "synthetic-meter-key" } });
		}
	});

	await row("after a shortening with no good answer since, the reading is unknown", async () => {
		const room = await openRoom("Shortened");
		// What the old session writes last must not come after the shortening.
		await leave(room);
		const thread = await readThread(room.agentId, room.conversationId);
		const sessionFile = path.join(roomRootPath(room.agentId), String(thread?.runtime?.sessionFileRelPath ?? ""));
		const entries = fs.readFileSync(sessionFile, "utf-8").split("\n").filter((line) => line.trim()).map((line) => JSON.parse(line));
		const firstMessage = entries.find((entry: any) => entry.type === "message");
		fs.appendFileSync(sessionFile, JSON.stringify({ type: "compaction", id: "compaction_smoke", parentId: entries[entries.length - 1].id, timestamp: new Date().toISOString(), summary: "The conversation so far, shortened.", firstKeptEntryId: firstMessage.id, tokensBefore: GOOD_TOKENS }) + "\n");
		room.ws = (await connect(room)).ws;
		const from = await send(room, `FAILS-MIDWAY ${LONG_TEXT}`);
		const health = await readingAfter(room, from);
		assert(health.tokens === null && health.checkpointPercent === null && health.zone === "unknown", `the reading is unknown, got ${JSON.stringify(health)}`);
		await idle(room);
		assertOneUsageRow(room);
	});

	await row("a good answer ends on the reading its usage carried, and counts one turn", async () => {
		const room = await openRoom("Good answer");
		const from = await send(room, "Say something short again.");
		const ended = await room.ws.waitFor((frame) => frame.type === "event" && frame.event?.type === "agent_end", "the answer's end", from);
		const health = await readingAfter(room, ended);
		assert(health.tokens === GOOD_TOKENS, `the reading is the usage's, got ${JSON.stringify(health)}`);
		const counted = room.ws.frames.slice(from).filter((frame) => frame.type === "usage_turn" && frame.input !== undefined);
		assert(counted.length === 1 && usageRows(room.agentId).length === 2, `one answer, one counted frame and one row, got ${counted.length} and ${usageRows(room.agentId).length}`);
	});

	await row("a first answer the person stops: the reading holds the instructions and the tools", async () => {
		const room = await openEmptyRoom("First stopped");
		const from = await send(room, `STOPPED ${LONG_TEXT}`);
		await room.ws.waitFor((frame) => frame.type === "event" && frame.event?.type === "message_update", "the first words", from);
		room.ws.send({ type: "abort" });
		const ended = await room.ws.waitFor((frame) => frame.type === "event" && frame.event?.type === "agent_end", "the stopped answer's end", from);
		const health = await readingAfter(room, ended);
		assertFirstMessageCounted(health);
		await idle(room);
		assertFirstMessageCounted(await reopen(room), true);
		await assertNextAnswerClose(room, health.tokens);
	});

	await row("a first answer that fails part way: the reading holds the instructions and the tools", async () => {
		const room = await openEmptyRoom("First fails midway");
		const from = await send(room, `FAILS-MIDWAY ${LONG_TEXT}`);
		const ended = await room.ws.waitFor((frame) => frame.type === "event" && frame.event?.type === "message_end" && frame.event.message?.role === "assistant" && frame.event.message.stopReason === "error", "the failed answer", from);
		const health = await readingAfter(room, ended);
		assertFirstMessageCounted(health);
		await idle(room);
		assertFirstMessageCounted(await reopen(room), true);
		await assertNextAnswerClose(room, health.tokens);
	});

	await row("a first message handed back leaves nothing to read, and the instructions and the tools count when the page keeps it", async () => {
		const room = await openEmptyRoom("First handed back");
		const from = await send(room, `FAILS-AT-ONCE ${LONG_TEXT}`);
		await room.ws.waitFor((frame) => frame.type === "prompt_returned", "the message handed back", from);
		const health = await readingAfter(room, from);
		assert(health.tokens === 0, `the message has left the conversation, got ${JSON.stringify(health)}`);
		await idle(room);
		const reopened = await reopen(room);
		assert(reopened.tokens === 0, `the conversation opens again with nothing in it, got ${JSON.stringify(reopened)}`);
		room.ws.send({ type: "returned_prompt_handled", kept: true });
		assertFirstMessageCounted(await readingAfter(room, 0), true);
	});

	await row("a first message refused before it was sent leaves nothing to read", async () => {
		const room = await openEmptyRoom("First refused");
		write(path.join(agentDir, "auth.json"), {});
		try {
			const from = await send(room, LONG_TEXT);
			const refused = await room.ws.waitFor((frame) => frame.type === "error", "the refusal", from);
			const health = await readingAfter(room, refused);
			assert(health.tokens === 0, `nothing was sent, got ${JSON.stringify(health)}`);
			await idle(room);
		} finally {
			write(path.join(agentDir, "auth.json"), { "openai-compatible": { type: "api_key", key: "synthetic-meter-key" } });
		}
	});

	if (failures.length > 0) throw new Error(`${failures.length} of ${failures.length + passes.length} rows failed`);
	console.log(`context-meter-after-failure-smoke: ${passes.length} checks passed`);
} catch (error) {
	console.error(`context-meter-after-failure-smoke FAILED: ${(error as Error).message}`);
	if (serverOutput.length > 0) console.error(serverOutput.join("").slice(-3000));
	process.exitCode = 1;
} finally {
	for (const ws of open) ws.close();
	if (server) await stopSmokeServer(server);
	gateway.closeAllConnections();
	await new Promise<void>((resolve) => gateway.close(() => resolve()));
	try { fs.rmSync(tempHome, { recursive: true, force: true }); } catch {}
}
