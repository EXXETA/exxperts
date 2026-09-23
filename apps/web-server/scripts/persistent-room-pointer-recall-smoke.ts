// The archive pointer line and the tool it points at, in the same turn.
//
// A demoted topic keeps a pointer in the room's context — "_Archived: 2 older
// notes from Mar to May 2026; use memory_recall to read them._" — and the room
// carries the tool that line names. Each half was covered on its own; the pair
// was not, so either could have left the room without a smoke noticing.
//
// This one makes the pair the thing under test. The gateway is scripted to
// DEPEND on both: it streams a memory_recall call only if the system prompt it
// was handed carries the pointer line AND the request's tools carry the schema,
// and otherwise answers "I don't know". So the archived words reach the person
// only when the room really was told where to look and really could go there.
//
// The room is built before the server starts, through the product's own store:
// a migrated memory with one topic, and two notes archived out of it. Then one
// question over a websocket.
//
// Red-first, by hand: run it with EXXPERTS_POINTER_RECALL_SMOKE_IGNORE_POINTER=1
// and the gateway ignores the pointer line it was given; the room answers "I
// don't know", memory_recall is never called, and the smoke fails on the
// archived words it never got. That is the failure this smoke exists to catch.
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import { fileURLToPath } from "node:url";
import { authedFetch, SMOKE_AUTH_HEADERS, SMOKE_SERVER_AUTH_ENV, SMOKE_SERVER_SPAWN_TREE_OPTIONS, stopSmokeServer, type AuthedFetchInit } from "./smoke-server-process.js";

function assert(condition: unknown, message: string): asserts condition {
	if (!condition) throw new Error(message);
}

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const webServerDir = path.resolve(scriptDir, "..");
const repoRoot = path.resolve(webServerDir, "..", "..");
const port = 27000 + Math.floor(Math.random() * 10000);
const baseUrl = `http://127.0.0.1:${port}`;

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "exxperts-pointer-recall-"));
const tempHome = path.join(tempRoot, "home");
const agentsRoot = path.join(tempHome, ".exxperts", "app", "personalized-agents");
const agentDir = path.join(tempHome, ".exxperts", "agent");
const productAppRoot = path.join(tempHome, ".exxperts", "app");
fs.mkdirSync(agentsRoot, { recursive: true, mode: 0o700 });
fs.mkdirSync(agentDir, { recursive: true, mode: 0o700 });
fs.mkdirSync(productAppRoot, { recursive: true, mode: 0o700 });

/** The line a demoted topic carries in context, and the words the gateway keys on. */
const POINTER_LINE = "_Archived: 2 older notes from Mar to May 2026; use memory_recall to read them._";
const POINTER_TRIGGER = "use memory_recall to read them";
/** Lives only in the archive: no note in memory and no summary ever said it. */
const ARCHIVED_WORDS = "Die Überweisung über den Rabatt ging am 11.07.2026 raus.";
/** Rides the question, so a captured request can be tied to the turn that caused it. */
const TURN_TOKEN = "TURN_TOKEN_POINTER_RECALL";
const QUESTION = "What do you still have about the Rabatt?";
/** The hand-run variant that proves this smoke goes red when the pointer is not followed. */
const IGNORE_POINTER = process.env.EXXPERTS_POINTER_RECALL_SMOKE_IGNORE_POINTER === "1";

// ---------------------------------------------------------------------------
// The gateway: the pointer line decides what it does.
// ---------------------------------------------------------------------------
interface RecallCall {
	arguments: string;
}
const recallCalls: RecallCall[] = [];
const legs: Array<{ pointerSeen: boolean; toolOffered: boolean; calledRecall: boolean; systemPrompt: string }> = [];

function sseChunk(payload: unknown): string {
	return `data: ${JSON.stringify(payload)}\n\n`;
}

function messageText(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content.map((part) => String((part as { text?: unknown })?.text ?? "")).join("\n");
}

const gateway = http.createServer((req, res) => {
	if (req.method !== "POST" || !String(req.url ?? "").endsWith("/chat/completions")) {
		res.writeHead(404).end();
		return;
	}
	let body = "";
	req.on("data", (chunk) => { body += chunk; });
	req.on("end", () => {
		let parsed: any = {};
		try { parsed = JSON.parse(body); } catch {}
		const messages: any[] = Array.isArray(parsed?.messages) ? parsed.messages : [];
		const toolMessages = messages.filter((message) => message?.role === "tool");
		const systemPrompt = messages[0]?.role === "system" ? messageText(messages[0].content) : "";
		const toolNames: string[] = (parsed?.tools ?? []).map((tool: any) => String(tool?.function?.name ?? tool?.name ?? ""));
		const pointerSeen = !IGNORE_POINTER && systemPrompt.includes(POINTER_TRIGGER);
		const toolOffered = toolNames.includes("memory_recall");
		const question = messages.filter((message) => message?.role === "user").map((message) => messageText(message.content)).pop() ?? "";
		const base = { id: `cmpl_${legs.length + 1}`, object: "chat.completion.chunk", created: Math.floor(Date.now() / 1000), model: String(parsed?.model ?? "room-model") };
		res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
		if (toolMessages.length === 0) {
			// First leg. The room is only looked up when the room said where to look
			// and handed over the means; otherwise this is a model with no memory.
			const calledRecall = pointerSeen && toolOffered;
			legs.push({ pointerSeen, toolOffered, calledRecall, systemPrompt });
			if (calledRecall) {
				// The question's own words go into the query — nothing the gateway
				// knows about this room's archive is smuggled in.
				const args = JSON.stringify({ query: question.replace(TURN_TOKEN, "").trim() });
				recallCalls.push({ arguments: args });
				res.write(sseChunk({ ...base, choices: [{ index: 0, delta: { role: "assistant", tool_calls: [{ index: 0, id: `call_recall_${recallCalls.length}`, type: "function", function: { name: "memory_recall", arguments: "" } }] }, finish_reason: null }] }));
				res.write(sseChunk({ ...base, choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: args } }] }, finish_reason: null }] }));
				res.write(sseChunk({ ...base, choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }], usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 } }));
			} else {
				res.write(sseChunk({ ...base, choices: [{ index: 0, delta: { role: "assistant", content: "I don't know." }, finish_reason: null }] }));
				res.write(sseChunk({ ...base, choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 100, completion_tokens: 5, total_tokens: 105 } }));
			}
		} else {
			legs.push({ pointerSeen, toolOffered, calledRecall: false, systemPrompt });
			const recalled = toolMessages.map((message) => messageText(message.content)).join("\n");
			res.write(sseChunk({ ...base, choices: [{ index: 0, delta: { role: "assistant", content: `Here is what the room still holds:\n${recalled}` }, finish_reason: null }] }));
			res.write(sseChunk({ ...base, choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 900, completion_tokens: 200, total_tokens: 1100 } }));
		}
		res.write("data: [DONE]\n\n");
		res.end();
	});
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

async function waitForServer(server: ChildProcessWithoutNullStreams): Promise<void> {
	const deadline = Date.now() + 20_000;
	let lastError = "server did not respond";
	while (Date.now() < deadline) {
		if (server.exitCode != null) throw new Error(`server exited before startup with code ${server.exitCode}`);
		try {
			const response = await fetch(`${baseUrl}/healthz`);
			if (response.ok) return;
			lastError = `healthz returned ${response.status}`;
		} catch (error) {
			lastError = (error as Error).message;
		}
		await sleep(150);
	}
	throw new Error(`server did not become ready: ${lastError}`);
}

async function requestJson(pathname: string, init: AuthedFetchInit = {}): Promise<{ status: number; body: any }> {
	const response = await authedFetch(`${baseUrl}${pathname}`, {
		...init,
		headers: { ...(init.body ? { "content-type": "application/json" } : {}), ...init.headers },
	});
	const text = await response.text();
	return { status: response.status, body: text ? JSON.parse(text) : null };
}

type Frame = Record<string, any>;

function deltaText(frame: Frame): string {
	const update = frame?.type === "event" && frame.event?.type === "message_update" ? frame.event.assistantMessageEvent : null;
	return update?.type === "text_delta" ? String(update.delta ?? "") : "";
}

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

	static async connect(persistentAgentId: string, conversationId: string): Promise<WsHarness> {
		const socket = new WebSocketImpl(`ws://127.0.0.1:${port}/ws?persistentAgentId=${persistentAgentId}&conversationId=${conversationId}&modelProvider=openai-compatible&model=room-model&reattach=1`, { headers: { ...SMOKE_AUTH_HEADERS } });
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

	answer(): string {
		return this.frames.map(deltaText).join("");
	}

	async waitFor(predicate: (frame: Frame) => boolean, label: string, timeoutMs = 20_000): Promise<void> {
		const deadline = Date.now() + timeoutMs;
		while (Date.now() < deadline) {
			if (this.frames.some(predicate)) return;
			await sleep(25);
		}
		const errors = this.frames.filter((frame) => String(frame.type).includes("error")).map((frame) => frame.message).join(" | ");
		throw new Error(`timed out waiting for ${label}; saw frame types: ${this.frames.map((frame) => frame.type).join(", ")}${errors ? `; errors: ${errors}` : ""}; answer so far: ${this.answer().slice(0, 300)}`);
	}
}

let server: ChildProcessWithoutNullStreams | undefined;
const serverOutput: string[] = [];
let ws: WsHarness | null = null;
let passes = 0;

function pass(label: string): void {
	passes += 1;
	console.log(`  ok ${label}`);
}

try {
	await new Promise<void>((resolve) => gateway.listen(0, "127.0.0.1", resolve));
	const gatewayPort = (gateway.address() as AddressInfo).port;
	fs.writeFileSync(path.join(agentDir, "models.json"), JSON.stringify({
		providers: {
			"openai-compatible": {
				name: "Synthetic Gateway",
				baseUrl: `http://127.0.0.1:${gatewayPort}/v1`,
				api: "openai-completions",
				models: [{ id: "room-model", name: "Room Model", contextWindow: 128000, maxTokens: 16384 }],
			},
		},
	}, null, 2), { mode: 0o600 });
	fs.writeFileSync(path.join(agentDir, "auth.json"), JSON.stringify({ "openai-compatible": { type: "api_key", key: "synthetic-pointer-recall-key" } }, null, 2), { mode: 0o600 });
	fs.writeFileSync(path.join(productAppRoot, "openai-compatible-ai-profile.json"), JSON.stringify({
		profileId: "openai-compatible",
		providerId: "openai-compatible",
		label: "Synthetic Gateway",
		roomModels: [{ modelId: "room-model", label: "Room Model" }],
		maintenanceModel: "room-model",
	}, null, 2), { mode: 0o600 });
	fs.writeFileSync(path.join(productAppRoot, "persistent-agent-ai-profile.json"), JSON.stringify({ profileId: "openai-compatible" }, null, 2), { mode: 0o600 });

	// --- The room, written the way the product writes it ---------------------
	process.env.HOME = tempHome;
	process.env.USERPROFILE = tempHome;
	process.env.EXXPERTS_CODING_AGENT_DIR = agentDir;
	process.env.EXXETA_PERSISTENT_AGENTS_ROOT = agentsRoot;

	const { createPersistentAgentFromScaffoldInput } = await import("../src/persistent-agents.js");
	const { writePersistentAgentAiProfileState } = await import("../src/persistent-agent-ai-profile-state.js");
	const { appendArchive } = await import("../src/memory-entries-store.js");
	writePersistentAgentAiProfileState("openai-compatible");

	const created = createPersistentAgentFromScaffoldInput({ displayName: "Pointer Recall Room", userName: "Synthetic User", preferredUserAddress: "Synthetic User" });
	const roomId = created.agent.agentId;
	const l1bPath = path.join(agentsRoot, roomId, "L1b", "current.md");
	fs.writeFileSync(l1bPath, [
		"<!-- exxeta:l1b schema_version=1 -->",
		"",
		"## Chronos",
		"",
		`- Persistent agent id: ${roomId}`,
		"- Lifecycle state: ready",
		"",
		"## Deep Memory",
		"",
		"<!-- entries: next=300 -->",
		"",
		"### Commercial terms",
		"",
		"<!-- e: id=m-0001 kind=fact saved=2026-08-02 -->",
		"- The Nordwind contract renews annually.",
		"",
		"## Active Items",
		"",
		"## Recent Context",
		"",
	].join("\n"), { mode: 0o600 });

	// Two notes archived out of that topic, months apart: the pointer line then
	// says how many there are and which months they span.
	appendArchive(roomId, [
		{
			entry: { id: "a-0101", kind: "fact", saved: "2026-01-10", pinned: false, text: `- ${ARCHIVED_WORDS}` },
			why: "budget",
			topic: "Commercial terms",
			section: "Deep Memory",
			archived: "2026-03-04",
		},
		{
			entry: { id: "a-0102", kind: "fact", saved: "2026-02-18", pinned: false, text: "- Der Rabatt galt nur für die erste Lieferung." },
			why: "budget",
			topic: "Commercial terms",
			section: "Deep Memory",
			archived: "2026-05-12",
		},
	], new Date("2026-05-12T09:00:00.000Z"));

	// --- The server, and one question ----------------------------------------
	server = spawn("npx", ["tsx", "src/index.ts"], {
		shell: process.platform === "win32",
		...SMOKE_SERVER_SPAWN_TREE_OPTIONS,
		cwd: webServerDir,
		env: {
			...process.env,
			HOME: tempHome, USERPROFILE: tempHome,
			PORT: String(port),
			...SMOKE_SERVER_AUTH_ENV,
			EXXETA_HOME: repoRoot,
			EXXPERTS_CODING_AGENT_DIR: agentDir,
			EXXETA_PERSISTENT_AGENTS_ROOT: agentsRoot,
		},
	});
	server.stdout.on("data", (chunk) => serverOutput.push(String(chunk)));
	server.stderr.on("data", (chunk) => serverOutput.push(String(chunk)));
	await waitForServer(server);

	const conversationId = `pointerconv_${Date.now().toString(36)}`;
	const seeded = await requestJson(`/api/persistent-agents/${encodeURIComponent(roomId)}/threads/${encodeURIComponent(conversationId)}`, {
		method: "PUT",
		body: JSON.stringify({ state: "active", origin: "launcher", model: { provider: "openai-compatible", model: "room-model" }, items: [] }),
	});
	assert(seeded.status === 200, `thread seed should return 200, got ${seeded.status}: ${JSON.stringify(seeded.body).slice(0, 300)}`);

	ws = await WsHarness.connect(roomId, conversationId);
	await ws.waitFor((frame) => frame.type === "ready", "the room's ready frame");
	ws.send({ type: "prompt", text: `${QUESTION} ${TURN_TOKEN}` });
	await ws.waitFor((frame) => frame.type === "event" && frame.event?.type === "agent_end", "the turn to end", 30_000);
	const answer = ws.answer();

	// --- 1. The room was told where to look, and given the means -------------
	assert(legs.length >= 1, "the turn should have reached the gateway");
	assert(IGNORE_POINTER || legs[0].pointerSeen, `the room's context should carry the archive pointer line, and the first leg did not see it: ${JSON.stringify({ toolOffered: legs[0].toolOffered })}`);
	assert(legs[0].toolOffered, `the room should offer memory_recall on the same turn the pointer line names it, got ${JSON.stringify({ pointerSeen: legs[0].pointerSeen })}`);
	pass("the pointer line and the tool it names ride the same turn");

	// --- 2. The pointer line reads as a person reads it ----------------------
	// The exact line, so a reworded pointer — or a count or month range that
	// stops matching the archive behind it — is a failure here rather than a
	// silent change of what the room is told.
	assert(legs[0].systemPrompt.includes(POINTER_LINE), `the demoted topic's pointer line should read "${POINTER_LINE}", and the memory in the prompt reads:\n${legs[0].systemPrompt.slice(legs[0].systemPrompt.indexOf("Commercial terms"), legs[0].systemPrompt.indexOf("Commercial terms") + 400)}`);
	pass("the pointer line says how many notes were archived, from when, and which tool reads them");

	// --- 3. The room followed it, once ---------------------------------------
	assert(recallCalls.length === 1, `the room should call memory_recall exactly once for one question, got ${recallCalls.length}`);
	const args = JSON.parse(recallCalls[0].arguments);
	assert(String(args.query ?? "").includes("Rabatt"), `the call should carry the question's own words, got ${recallCalls[0].arguments}`);
	assert(!String(args.query ?? "").includes(TURN_TOKEN), "the question's words, not the harness's marker");
	assert(legs.length === 2, `one question with one lookup is two legs, got ${legs.length}`);
	pass("the room called memory_recall once, with the words of the question");

	// --- 4. The archived words reached the person ----------------------------
	assert(answer.includes(ARCHIVED_WORDS), `the answer should carry the archived note's own words, got:\n${answer.slice(0, 900)}`);
	assert(/\[MEMORY RECALL: \d+ of \d+ matching rows?\]/.test(answer), `the recalled rows reach the person inside the tool's envelope, got:\n${answer.slice(0, 600)}`);
	assert(answer.includes("Commercial terms · archived 2026-03-04, moved to make room"), `each recalled row says where it came from and why it left, got:\n${answer.slice(0, 900)}`);
	assert(!answer.includes("I don't know"), `a room that holds the answer must not say it does not know, got:\n${answer.slice(0, 400)}`);
	pass("the archived note's own words came back in the room's answer");

	// The hand-run variant gets this far only if something answered from the
	// archive without following the pointer, which is not a pass either.
	assert(!IGNORE_POINTER, "this run told the gateway to ignore the pointer line, so it proves the red and cannot pass");

	ws.close();
	ws = null;
	console.log(`persistent-room-pointer-recall-smoke: ${passes} checks passed`);
} catch (error) {
	console.error(`persistent-room-pointer-recall-smoke FAILED: ${(error as Error).message}`);
	console.error(`legs: ${JSON.stringify(legs.map(({ pointerSeen, toolOffered, calledRecall }) => ({ pointerSeen, toolOffered, calledRecall })))}; recall calls: ${JSON.stringify(recallCalls)}`);
	console.error(`answer: ${(ws?.answer() ?? "").slice(0, 400)}`);
	if (serverOutput.length > 0) console.error(serverOutput.join("").slice(-4000));
	process.exitCode = 1;
} finally {
	try { ws?.close(); } catch {}
	if (server) await stopSmokeServer(server);
	try { (gateway as any).closeAllConnections?.(); } catch {}
	await new Promise<void>((resolve) => gateway.close(() => resolve()));
	try { fs.rmSync(tempRoot, { recursive: true, force: true }); } catch {}
}
