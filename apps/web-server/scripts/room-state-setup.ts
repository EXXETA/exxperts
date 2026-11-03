// The setup both room-state smokes share: a synthetic OpenAI-compatible
// gateway that keeps every request the model is sent, the real server on a
// temp home, rooms opened over the API and their sockets. The gateway answers
// "Noted." unless the person's newest message carries a marker:
//   FAIL ONCE      refused once as a bad request, answered after;
//   OVERFLOW ONCE  refused once as too long for the window, answered after.
// A room-state copy is the user message that opens with ROOM_STATE_HEADING.
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ROOM_STATE_HEADING } from "../src/room-state-message.js";
import { waitEvery } from "./smoke-wait.js";
import { authedFetch, freePort, type AuthedFetchInit, SMOKE_AUTH_HEADERS, SMOKE_SERVER_AUTH_ENV, SMOKE_SERVER_SPAWN_TREE_OPTIONS, smokeHomeEnv, stopSmokeServer, waitForServer } from "./smoke-server-process.js";

export const MODEL = { provider: "openai-compatible", model: "room-model" };

export function assert(condition: unknown, message: string): asserts condition {
	if (!condition) throw new Error(message);
}

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const webServerDir = path.resolve(scriptDir, "..");
const repoRoot = path.resolve(webServerDir, "..", "..");
export const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), "exxperts-room-state-home-"));
export const agentDir = path.join(tempHome, ".exxperts", "agent");
const productAppRoot = path.join(tempHome, ".exxperts", "app");
export const agentsRoot = path.join(productAppRoot, "personalized-agents");
for (const dir of [agentDir, agentsRoot]) fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
// The same home for what a smoke runs in this process (a scheduled run, the Remember reader) as for the server.
process.env.HOME = tempHome;
process.env.USERPROFILE = tempHome;
process.env.EXXPERTS_CODING_AGENT_DIR = agentDir;
process.env.EXXETA_PERSISTENT_AGENTS_ROOT = agentsRoot;
process.env.EXXETA_HOME = repoRoot;
const port = await freePort();
export const baseUrl = `http://127.0.0.1:${port}`;

export interface SentMessage { role: string; text: string }
/** One request the model was sent: its system prompt and the messages after it. */
export interface SentRequest { system: string; messages: SentMessage[] }

function textOf(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content.map((part) => String((part as { text?: unknown })?.text ?? "")).join("\n");
}

export { ROOM_STATE_HEADING };
export const isCopy = (message: SentMessage) => message.role === "user" && message.text.startsWith(`${ROOM_STATE_HEADING}\n`);
export const copiesIn = (request: SentRequest) => request.messages.filter(isCopy).map((message) => message.text);
/** The person's newest message in a request: the newest user message that is not a room-state copy. */
export const personsNewest = (request: SentRequest) => [...request.messages].reverse().find((message) => message.role === "user" && !isCopy(message))?.text ?? "";

export const requests: SentRequest[] = [];
const refusedOnce = new Set<string>();

function sseChunk(payload: unknown): string {
	return `data: ${JSON.stringify(payload)}\n\n`;
}

const gateway = http.createServer((req, res) => {
	if (req.method !== "POST" || !String(req.url ?? "").endsWith("/chat/completions")) {
		res.writeHead(404).end();
		return;
	}
	let raw = "";
	req.on("data", (chunk) => { raw += chunk; });
	req.on("end", () => {
		let body: any = {};
		try { body = JSON.parse(raw); } catch {}
		const all: SentMessage[] = (Array.isArray(body.messages) ? body.messages : []).map((message: any) => ({ role: String(message?.role ?? ""), text: textOf(message?.content) }));
		// The summary a compaction asks for wraps the conversation in <conversation> tags; it is not a turn.
		const isSummary = all.some((message) => message.role === "user" && message.text.includes("<conversation>"));
		const request: SentRequest = { system: all[0]?.role === "system" ? all[0].text : "", messages: all[0]?.role === "system" ? all.slice(1) : all };
		if (!isSummary) requests.push(request);
		const newest = personsNewest(request);
		const refuse = !isSummary && (["FAIL ONCE", "OVERFLOW ONCE"].find((marker) => newest.includes(marker) && !refusedOnce.has(newest)));
		if (refuse) {
			refusedOnce.add(newest);
			const error = refuse === "OVERFLOW ONCE"
				? { message: "This model's maximum context length is 128000 tokens. Please reduce the length of the messages.", type: "invalid_request_error", code: "context_length_exceeded" }
				: { message: "The request could not be read.", type: "invalid_request_error", code: "bad_request" };
			res.writeHead(400, { "content-type": "application/json" }).end(JSON.stringify({ error }));
			return;
		}
		const base = { id: `cmpl_${requests.length}`, object: "chat.completion.chunk", created: Math.floor(Date.now() / 1000), model: String(body.model ?? MODEL.model) };
		res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
		res.write(sseChunk({ ...base, choices: [{ index: 0, delta: { role: "assistant", content: isSummary ? "# Goal\nShort answers." : "Noted." }, finish_reason: null }] }));
		res.write(sseChunk({ ...base, choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 900, completion_tokens: 10, total_tokens: 910 } }));
		res.write("data: [DONE]\n\n");
		res.end();
	});
});

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export async function requestJson(pathname: string, init: AuthedFetchInit = {}): Promise<{ status: number; body: any }> {
	const response = await authedFetch(`${baseUrl}${pathname}`, { ...init, headers: { ...(init.body ? { "content-type": "application/json" } : {}), ...init.headers } });
	const text = await response.text();
	let body: any = text;
	try { body = text ? JSON.parse(text) : null; } catch {}
	return { status: response.status, body };
}

export const waitUntil = waitEvery(50);

type Frame = Record<string, any>;
const WebSocketImpl: any = (await import("ws")).default;

export class RoomSocket {
	readonly frames: Frame[] = [];
	private constructor(private readonly socket: any, readonly roomId: string) {
		socket.addEventListener("message", (event: { data: unknown }) => {
			try { this.frames.push(JSON.parse(String(event.data))); } catch {}
		});
	}

	static async connect(roomId: string, conversationId: string): Promise<RoomSocket> {
		const socket = new WebSocketImpl(`ws://127.0.0.1:${port}/ws?persistentAgentId=${roomId}&conversationId=${conversationId}&modelProvider=${MODEL.provider}&model=${MODEL.model}&reattach=1`, { headers: { ...SMOKE_AUTH_HEADERS } });
		const room = new RoomSocket(socket, roomId);
		await new Promise<void>((resolve, reject) => {
			socket.addEventListener("open", () => resolve());
			socket.addEventListener("error", () => reject(new Error("websocket failed to connect")));
		});
		await room.waitFor((frame) => frame.type === "ready", "the room's ready frame");
		return room;
	}

	send(frame: Frame): void {
		this.socket.send(JSON.stringify(frame));
	}

	async close(): Promise<void> {
		await new Promise<void>((resolve) => {
			if (this.socket.readyState === 3) return resolve();
			this.socket.addEventListener("close", () => resolve());
			this.socket.close();
		});
		await this.idle();
	}

	async waitFor(predicate: (frame: Frame) => boolean, label: string, fromIndex = 0, timeoutMs = 20_000): Promise<number> {
		let found = -1;
		await waitUntil(() => (found = this.frames.findIndex((frame, at) => at >= fromIndex && predicate(frame))) >= 0, `${label}; saw ${this.frames.slice(fromIndex).map((frame) => frame.event?.type ?? frame.type).join(", ")}`, timeoutMs);
		return found;
	}

	/** Until the room has no turn in flight. */
	async idle(): Promise<void> {
		await waitUntil(async () => (await requestJson(`/api/persistent-agents/${this.roomId}/status`)).body?.activeThread?.inFlight !== true, "the room is idle");
	}

	/** Sends one frame that starts a turn (a prompt, or Try again), and returns the requests the model was sent for it once the room is idle. */
	async turn(frame: Frame): Promise<SentRequest[]> {
		for (let attempt = 0; attempt < 40; attempt++) {
			const before = requests.length;
			const from = this.frames.length;
			this.send(frame);
			const at = await this.waitFor((f) => (f.type === "event" && f.event?.type === "agent_end") || f.type === "error" || f.type === "prompt_error", "the turn's end", from);
			if (this.frames[at].type === "error" && /still running|is cancelling/.test(String(this.frames[at].message ?? ""))) {
				await sleep(200);
				continue;
			}
			await this.idle();
			return requests.slice(before);
		}
		throw new Error("the room never accepted the turn");
	}

	prompt(text: string): Promise<SentRequest[]> {
		return this.turn({ type: "prompt", text });
	}
}

/** A new room on the synthetic model with one conversation; `before` runs between the room's creation and the conversation's, so what it sets is booted. */
export async function openRoom(displayName: string, before?: (roomId: string) => Promise<void>): Promise<{ roomId: string; conversationId: string }> {
	const created = await requestJson("/api/persistent-agents", { method: "POST", body: JSON.stringify({ displayName, userName: "Synthetic User", preferredUserAddress: "Synthetic User" }) });
	assert(created.status === 201, `room creation should return 201, got ${created.status}: ${JSON.stringify(created.body)}`);
	const roomId = String(created.body?.agent?.id ?? "");
	await before?.(roomId);
	const conversationId = `roomstate_${Math.random().toString(36).slice(2, 10)}`;
	const seeded = await requestJson(`/api/persistent-agents/${roomId}/threads/${conversationId}`, { method: "PUT", body: JSON.stringify({ state: "active", origin: "home", model: MODEL, items: [] }) });
	assert(seeded.status === 200, `the conversation should open, got ${seeded.status}: ${JSON.stringify(seeded.body).slice(0, 300)}`);
	return { roomId, conversationId };
}

export const rename = async (roomId: string, displayName: string) => {
	const renamed = await requestJson(`/api/persistent-agents/${roomId}/rename`, { method: "POST", body: JSON.stringify({ displayName }) });
	assert(renamed.status === 200, `rename should succeed, got ${renamed.status}: ${JSON.stringify(renamed.body)}`);
};

export const setInstructions = async (roomId: string, text: string) => {
	const saved = await requestJson(`/api/persistent-agents/${roomId}/instructions`, { method: "PUT", body: JSON.stringify({ text }) });
	assert(saved.status === 200, `instructions should save, got ${saved.status}: ${JSON.stringify(saved.body)}`);
};

let server: ChildProcessWithoutNullStreams | undefined;
const serverOutput: string[] = [];

export async function startRoomStateServer(): Promise<void> {
	await new Promise<void>((resolve) => gateway.listen(0, "127.0.0.1", resolve));
	const gatewayPort = (gateway.address() as AddressInfo).port;
	fs.writeFileSync(path.join(agentDir, "models.json"), JSON.stringify({ providers: { [MODEL.provider]: { name: "Synthetic Gateway", baseUrl: `http://127.0.0.1:${gatewayPort}/v1`, api: "openai-completions", models: [{ id: MODEL.model, name: "Room Model", contextWindow: 128000, maxTokens: 16384 }] } } }, null, 2), { mode: 0o600 });
	fs.writeFileSync(path.join(agentDir, "auth.json"), JSON.stringify({ [MODEL.provider]: { type: "api_key", key: "synthetic-room-state-key" } }, null, 2), { mode: 0o600 });
	// A small kept window, so a compaction leaves only the newest message and its answer.
	fs.writeFileSync(path.join(agentDir, "settings.json"), JSON.stringify({ compaction: { keepRecentTokens: 5 }, retry: { baseDelayMs: 50, provider: { maxRetries: 0 } } }, null, 2), { mode: 0o600 });
	fs.writeFileSync(path.join(productAppRoot, "openai-compatible-ai-profile.json"), JSON.stringify({ profileId: MODEL.provider, providerId: MODEL.provider, label: "Synthetic Gateway", roomModels: [{ modelId: MODEL.model, label: "Room Model" }], maintenanceModel: MODEL.model }, null, 2), { mode: 0o600 });
	fs.writeFileSync(path.join(productAppRoot, "persistent-agent-ai-profile.json"), JSON.stringify({ profileId: MODEL.provider }, null, 2), { mode: 0o600 });
	server = spawn("npx", ["tsx", "src/index.ts"], {
		shell: process.platform === "win32",
		...SMOKE_SERVER_SPAWN_TREE_OPTIONS,
		cwd: webServerDir,
		env: smokeHomeEnv(tempHome, { PORT: String(port), ...SMOKE_SERVER_AUTH_ENV, EXXETA_HOME: repoRoot, EXXPERTS_CODING_AGENT_DIR: agentDir, EXXETA_PERSISTENT_AGENTS_ROOT: agentsRoot }) as NodeJS.ProcessEnv,
	});
	server.stdout.on("data", (chunk) => serverOutput.push(String(chunk)));
	server.stderr.on("data", (chunk) => serverOutput.push(String(chunk)));
	await waitForServer(server, baseUrl, 30_000);
}

/** Stops the server and the gateway and removes the temp home; with an error, prints the server's last output first. */
export async function stopRoomStateServer(error?: unknown): Promise<void> {
	if (error) console.error(serverOutput.join("").slice(-5000));
	await stopSmokeServer(server);
	try { (gateway as any).closeAllConnections?.(); } catch {}
	await new Promise<void>((resolve) => gateway.close(() => resolve()));
	fs.rmSync(tempHome, { recursive: true, force: true });
}
