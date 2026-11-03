import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import http from "node:http";
import type { AddressInfo } from "node:net";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { authedFetch, freePort, type AuthedFetchInit, SMOKE_AUTH_HEADERS, SMOKE_SERVER_AUTH_ENV, SMOKE_SERVER_SPAWN_TREE_OPTIONS, smokeHomeEnv, stopSmokeServer } from "./smoke-server-process.js";
import { waitEvery } from "./smoke-wait.js";

// The rig both parts of the detached-turn smoke run on: a synthetic
// OpenAI-compatible SSE gateway, a server on the smoke's own home, and the
// websocket harness. What the run proves is in persistent-room-detached-turn-smoke.ts.

export const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), "exxperts-detached-turn-home-"));
export const scriptDir = path.dirname(fileURLToPath(import.meta.url));
export const webServerDir = path.resolve(scriptDir, "..");
export const repoRoot = path.resolve(webServerDir, "..", "..");
export const port = await freePort();
export const baseUrl = `http://127.0.0.1:${port}`;
export const agentDir = path.join(tempHome, ".exxperts", "agent");
export const productAppRoot = path.join(tempHome, ".exxperts", "app");

export const SLOW_MARKER = "SLOW_STREAM_MARKER";
export const HANG_MARKER = "HANG_STREAM_MARKER";
export const BIG_MARKER = "BIG_STREAM_MARKER";
// A slow, big or hanging stream sends its first chunk and then each later one
// only when the smoke releases it (GatewayRequest.release), so a section
// holds the turn mid-cook exactly as long as it binds, replays and leaves.
export const SLOW_ANSWER_CHUNKS = Array.from({ length: 16 }, (_, i) => `slow part ${i + 1}. `);
export const HANG_ANSWER_CHUNKS = ["Hang part 1. "];
export const FAST_ANSWER_CHUNKS = ["Quick ", "answer."];
// Section 15's overflow fodder: 10 chunks x ~16KB overflow the smoke's 64KB
// replay cap (EXXETA_REATTACH_REPLAY_CAP_BYTES below) around chunk 4, so a
// section that releases six holds the rest while it asserts the overflow bounce.
export const BIG_ANSWER_CHUNKS = Array.from({ length: 10 }, (_, i) => `big part ${i + 1} ${"x".repeat(16000)} `);
export const REPLAY_CAP_OVERRIDE_BYTES = 64 * 1024;
// The away limits' overrides (room-live-sessions.ts). The silence limit stops
// section 6's hung stream; it must comfortably exceed the longest UNWATCHED
// quiet stretch (a held stream between a leave and the smoke's next release:
// status reads, an old client's bounce, a new client's bind, under a loaded
// machine), or it would stop the legitimately-finishing detached turn the
// smoke proves. The total limit sits far above any part's turn. A part that
// proves the limits themselves passes its own (startDetachedServer).
export const DETACHED_SILENCE_OVERRIDE_MS = 8000;
export const DETACHED_LIMIT_OVERRIDE_MS = 120_000;
export type AwayLimitOverrides = { silenceMs: number; limitMs: number };

// The away-limits smoke's cases: each marker plays once per tag (the word
// after its colon, as in `QUIET_STREAM_MARKER:a`), and the same message sent
// again (Try again) gets the quick answer. A quiet stream starts its answer and
// sends nothing more; a drip sends a chunk every DRIP_EVERY_MS and never ends;
// a silent tool runs the shell command `sleep SILENT_TOOL_SECONDS`, and the
// model call after its result starts its answer and goes quiet; a failing
// call is refused as busy every time, so the runtime waits and asks again.
export const QUIET_MARKER = "QUIET_STREAM_MARKER";
export const FAILING_MARKER = "FAILING_CALL_MARKER";
export const DRIP_MARKER = "DRIP_STREAM_MARKER";
export const SILENT_TOOL_MARKER = "SILENT_TOOL_MARKER";
export const DRIP_EVERY_MS = 400;
export const SILENT_TOOL_SECONDS = 6;
export const AFTER_TOOL_TEXT = "Checking the result. ";
const PLAYED_ONCE = /\b(QUIET_STREAM_MARKER|DRIP_STREAM_MARKER|SILENT_TOOL_MARKER|FAILING_CALL_MARKER):(\w+)/;
const playedTags = new Set<string>();
// A failing case's tag while its turn still asks again; the smoke ends it with `endFailingCase`.
const failingTags = new Set<string>();
export function endFailingCase(tag: string): void {
	failingTags.delete(tag);
}

export function assert(condition: unknown, message: string): asserts condition {
	if (!condition) throw new Error(message);
}

// ---------------------------------------------------------------------------
// Synthetic OpenAI-compatible gateway: bodies carrying SLOW_MARKER (or
// BIG_MARKER, or HANG_MARKER) send one chunk and hold the rest until the
// smoke releases them, for a deterministic in-flight window; every request
// records whether the CLIENT (the server's provider call) aborted it
// mid-stream or let it finish.
// ---------------------------------------------------------------------------
export type GatewayRequest = {
	model: string;
	/** The away-limits case it played (`QUIET_STREAM_MARKER:a`), and when it came and was aborted (epoch ms). */
	played?: string;
	/** The model call after a tool's result. */
	afterTool?: boolean;
	/** The roles of the messages the call carried, in order. */
	roles: string[];
	startedAt: number;
	abortedAt?: number;
	slow: boolean;
	hang: boolean;
	aborted: boolean;
	finished: boolean;
	sent: number;
	/** Lets `count` more chunks go (all of them when not given); a hanging stream never finishes. */
	release: (count?: number) => void;
	/** Cuts the stream off mid-answer, as a provider that drops the connection does. */
	fail: () => void;
};
export const gatewayRequests: GatewayRequest[] = [];

/** Lets every held stream run to its end. */
export function releaseHeldStreams(): void {
	for (const request of gatewayRequests) request.release();
}

export function sseChunk(payload: unknown): string {
	return `data: ${JSON.stringify(payload)}\n\n`;
}

export const gateway = http.createServer((req, res) => {
	if (req.method !== "POST" || !String(req.url ?? "").endsWith("/chat/completions")) {
		res.writeHead(404).end();
		return;
	}
	let body = "";
	req.on("data", (chunk) => { body += chunk; });
	req.on("end", () => {
		let parsed: any = {};
		try { parsed = JSON.parse(body); } catch {}
		const model = String(parsed?.model ?? "");
		const messages: any[] = Array.isArray(parsed?.messages) ? parsed.messages : [];
		const roles = messages.map((message) => String(message?.role ?? ""));
		if (playAwayLimitCase(model, messages, roles, res)) return;
		const slow = body.includes(SLOW_MARKER);
		const hang = body.includes(HANG_MARKER);
		const big = body.includes(BIG_MARKER);
		const chunks = hang ? HANG_ANSWER_CHUNKS : big ? BIG_ANSWER_CHUNKS : slow ? SLOW_ANSWER_CHUNKS : FAST_ANSWER_CHUNKS;
		let allowed = slow || hang || big ? 1 : chunks.length;
		const record: GatewayRequest = {
			model, roles, startedAt: Date.now(), slow: slow || big, hang, aborted: false, finished: false, sent: 0,
			release: (count) => {
				allowed = count === undefined ? chunks.length : Math.min(chunks.length, allowed + count);
				writeNext();
			},
			fail: () => { res.destroy(); },
		};
		gatewayRequests.push(record);
		res.on("close", () => { if (!res.writableFinished) { record.aborted = true; record.abortedAt = Date.now(); } });

		res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
		const base = { id: `cmpl_${gatewayRequests.length}`, object: "chat.completion.chunk", created: Math.floor(Date.now() / 1000), model };
		res.write(sseChunk({ ...base, choices: [{ index: 0, delta: { role: "assistant", content: "" }, finish_reason: null }] }));
		let index = 0;
		function writeNext(): void {
			if (record.aborted || record.finished || res.destroyed) return;
			for (; index < allowed; index++) {
				res.write(sseChunk({ ...base, choices: [{ index: 0, delta: { content: chunks[index] }, finish_reason: null }] }));
				record.sent = index + 1;
			}
			// A hanging stream never finishes: keep the connection open until
			// the client aborts (the away limit on no progress is what must do that).
			if (index < chunks.length || hang) return;
			res.write(sseChunk({
				...base,
				choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
				usage: { prompt_tokens: 120, completion_tokens: 30, total_tokens: 150 },
			}));
			res.write("data: [DONE]\n\n");
			record.finished = true;
			res.end();
		}
		writeNext();
	});
});

function textOf(content: unknown): string {
	return typeof content === "string" ? content : Array.isArray(content) ? content.map((part: any) => String(part?.text ?? "")).join("") : "";
}

// Plays an away-limits case for a message that carries one of its markers; false for any other call.
function playAwayLimitCase(model: string, messages: any[], roles: string[], res: http.ServerResponse): boolean {
	// The person's newest message that carries a marker: the room's own state rides after it as a user message too.
	let lastUser = roles.length - 1;
	while (lastUser >= 0 && !(roles[lastUser] === "user" && PLAYED_ONCE.test(textOf(messages[lastUser]?.content)))) lastUser--;
	const found = lastUser >= 0 ? PLAYED_ONCE.exec(textOf(messages[lastUser].content)) : null;
	if (!found) return false;
	const afterTool = roles.slice(lastUser + 1).includes("tool");
	// The first call for a tag plays it; a call after its tool's result goes on with it; the message sent again answers at once.
	const fresh = !playedTags.has(found[0]) || afterTool || (found[1] === FAILING_MARKER && failingTags.has(found[0]));
	playedTags.add(found[0]);
	const record: GatewayRequest = {
		model, roles, startedAt: Date.now(), played: fresh ? found[0] : undefined, afterTool, slow: false, hang: fresh, aborted: false, finished: false, sent: 0,
		release: () => {},
		fail: () => { res.destroy(); },
	};
	gatewayRequests.push(record);
	if (fresh && found[1] === FAILING_MARKER) {
		// Every call of the turn fails; once its turn ended, the message sent again is answered.
		failingTags.add(found[0]);
		res.writeHead(503, { "content-type": "application/json" }).end(JSON.stringify({ error: { message: "synthetic overload", type: "server_error" } }));
		record.finished = true;
		return true;
	}
	let drip: ReturnType<typeof setInterval> | undefined;
	res.on("close", () => {
		if (drip) clearInterval(drip);
		if (!res.writableFinished) { record.aborted = true; record.abortedAt = Date.now(); }
	});
	res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
	const base = { id: `cmpl_${gatewayRequests.length}`, object: "chat.completion.chunk", created: Math.floor(Date.now() / 1000), model };
	const write = (delta: Record<string, unknown>, finish: string | null = null) => {
		res.write(sseChunk({ ...base, choices: [{ index: 0, delta, finish_reason: finish }], ...(finish ? { usage: { prompt_tokens: 120, completion_tokens: 30, total_tokens: 150 } } : {}) }));
		record.sent++;
	};
	const end = () => {
		res.write("data: [DONE]\n\n");
		record.finished = true;
		res.end();
	};
	if (!fresh) {
		write({ role: "assistant", content: FAST_ANSWER_CHUNKS.join("") });
		write({}, "stop");
		end();
	} else if (found[1] === SILENT_TOOL_MARKER && !afterTool) {
		write({ role: "assistant", tool_calls: [{ index: 0, id: `call_${found[2]}`, type: "function", function: { name: "bash", arguments: JSON.stringify({ command: `sleep ${SILENT_TOOL_SECONDS}` }) } }] });
		write({}, "tool_calls");
		end();
	} else if (found[1] === DRIP_MARKER) {
		write({ role: "assistant", content: "" });
		drip = setInterval(() => write({ content: `drip ${record.sent}. ` }), DRIP_EVERY_MS);
	} else {
		// Quiet, or the call after the silent tool: the stream stays open and says no more.
		write({ role: "assistant", content: afterTool ? AFTER_TOOL_TEXT : "" });
	}
	return true;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
export async function waitForServer(server: ChildProcessWithoutNullStreams): Promise<void> {
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
		await new Promise((resolve) => setTimeout(resolve, 150));
	}
	throw new Error(`server did not become ready: ${lastError}`);
}

export async function requestJson(pathname: string, init?: AuthedFetchInit): Promise<{ status: number; body: any }> {
	const response = await authedFetch(`${baseUrl}${pathname}`, init);
	const text = await response.text();
	return { status: response.status, body: text ? JSON.parse(text) : null };
}

export async function createRoom(displayName: string): Promise<string> {
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

export async function putThread(agentId: string, threadId: string, items: unknown[], state: "active" | "standby" = "active"): Promise<{ status: number; body: any }> {
	return requestJson(`/api/persistent-agents/${agentId}/threads/${threadId}`, {
		method: "PUT",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ state, origin: "launcher", model: { provider: "openai-compatible", model: "room-model" }, items }),
	});
}

export async function getThread(agentId: string, threadId: string): Promise<any> {
	const response = await requestJson(`/api/persistent-agents/${agentId}/threads/${threadId}`);
	assert(response.status === 200, `thread GET should return 200, got ${response.status}`);
	return response.body.thread;
}

export async function getStatus(agentId: string): Promise<any> {
	const response = await requestJson("/api/persistent-agents");
	assert(response.status === 200, `statuses GET should return 200, got ${response.status}`);
	const status = (response.body?.agents ?? response.body ?? []).find?.((row: any) => row.id === agentId)
		?? (Array.isArray(response.body) ? response.body.find((row: any) => row.id === agentId) : null);
	assert(status, `status for ${agentId} should exist, got ${JSON.stringify(response.body).slice(0, 400)}`);
	return status;
}

export type Frame = Record<string, any>;

// The assistant text carried by one frame, empty for every non-delta frame.
export function deltaText(frame: Frame): string {
	const update = frame?.type === "event" && frame.event?.type === "message_update" ? frame.event.assistantMessageEvent : null;
	return update?.type === "text_delta" ? String(update.delta ?? "") : "";
}

// Every delta from `fromIndex` on, joined: the reattach seam proof
// is that replayed plus live deltas concatenate to the answer, once, in order.
export function joinedDeltas(frames: Frame[], fromIndex: number): string {
	return frames.slice(fromIndex).map(deltaText).join("");
}

export function countOccurrences(haystack: string, needle: string): number {
	return haystack.split(needle).length - 1;
}

const WebSocketImpl: any = (await import("ws")).default;
// Every socket a part opened, closed when it ends.
const openedSockets: WsHarness[] = [];

export class WsHarness {
	readonly frames: Frame[] = [];
	private socket: any;

	private constructor(socket: any) {
		this.socket = socket;
		socket.addEventListener("message", (event: { data: unknown }) => {
			try { this.frames.push(JSON.parse(String(event.data))); } catch {}
		});
	}

	static async connect(persistentAgentId: string, conversationId: string, options: { reattach?: boolean; extraParams?: string } = {}): Promise<WsHarness> {
		// The reattach capability rides every connect by default, like the real
		// client; `reattach: false` impersonates an older bundle.
		const reattachParam = options.reattach === false ? "" : "&reattach=1";
		const socket = new WebSocketImpl(`ws://127.0.0.1:${port}/ws?persistentAgentId=${persistentAgentId}&conversationId=${conversationId}&modelProvider=openai-compatible&model=room-model${reattachParam}${options.extraParams ?? ""}`, { headers: { ...SMOKE_AUTH_HEADERS } });
		const harness = new WsHarness(socket);
		openedSockets.push(harness);
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

export function smokeEnv(limits: AwayLimitOverrides): NodeJS.ProcessEnv {
	const env = smokeHomeEnv(tempHome) as NodeJS.ProcessEnv;
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
	env.PORT = String(port);
	Object.assign(env, SMOKE_SERVER_AUTH_ENV);
	env.EXXETA_HOME = repoRoot;
	env.EXXPERTS_CODING_AGENT_DIR = agentDir;
	env.EXXETA_PERSISTENT_AGENTS_ROOT = path.join(productAppRoot, "personalized-agents");
	env.EXXETA_DETACHED_TURN_SILENCE_MS = String(limits.silenceMs);
	env.EXXETA_DETACHED_TURN_DEADLINE_MS = String(limits.limitMs);
	// Test introspection: honors the testBindDelayMs connect param (pins
	// the settle-during-bind branch deterministically) and the replay-buffer
	// stats probe.
	env.EXXPERTS_TEST_INTROSPECTION = "1";
	// Small replay cap so section 15 can overflow it with the BIG turn while
	// every slow-turn section stays far below (a 16-chunk slow turn buffers a
	// few KB).
	env.EXXETA_REATTACH_REPLAY_CAP_BYTES = String(REPLAY_CAP_OVERRIDE_BYTES);
	return env;
}

/** Waits until the server has the room's turn cooking with no client, after a leave. */
export async function waitDetached(roomId: string, label: string): Promise<void> {
	await waitUntil(async () => (await getStatus(roomId)).answeringDetached === true, `${label}: the turn cooks on with no client`, 10_000);
}

export const waitUntil = waitEvery(150);

export let server: ChildProcessWithoutNullStreams | null = null;
export const serverOutput: string[] = [];

// The whole slow answer, as it lands.
export const expectedText = SLOW_ANSWER_CHUNKS.join("").trim();

/** Starts the gateway and the server on the smoke's own home, with the away limits' test overrides. */
export async function startDetachedServer(limits: AwayLimitOverrides = { silenceMs: DETACHED_SILENCE_OVERRIDE_MS, limitMs: DETACHED_LIMIT_OVERRIDE_MS }): Promise<void> {
	await new Promise<void>((resolve) => gateway.listen(0, "127.0.0.1", resolve));
	const gatewayPort = (gateway.address() as AddressInfo).port;

	fs.mkdirSync(agentDir, { recursive: true, mode: 0o700 });
	fs.mkdirSync(productAppRoot, { recursive: true, mode: 0o700 });
	fs.writeFileSync(
		path.join(agentDir, "models.json"),
		JSON.stringify({
			providers: {
				"openai-compatible": {
					name: "Synthetic SSE Gateway",
					baseUrl: `http://127.0.0.1:${gatewayPort}/v1`,
					api: "openai-completions",
					models: [
						{ id: "room-model", name: "Room Model", contextWindow: 128000, maxTokens: 16384 },
					],
				},
			},
		}, null, 2),
		{ mode: 0o600 },
	);
	fs.writeFileSync(
		path.join(agentDir, "auth.json"),
		JSON.stringify({ "openai-compatible": { type: "api_key", key: "synthetic-detached-turn-key" } }, null, 2),
		{ mode: 0o600 },
	);
	fs.writeFileSync(
		path.join(productAppRoot, "openai-compatible-ai-profile.json"),
		JSON.stringify({
			profileId: "openai-compatible",
			providerId: "openai-compatible",
			label: "Synthetic SSE Gateway",
			roomModels: [{ modelId: "room-model", label: "Room Model" }],
			maintenanceModel: "room-model",
		}, null, 2),
		{ mode: 0o600 },
	);
	fs.writeFileSync(path.join(productAppRoot, "persistent-agent-ai-profile.json"), JSON.stringify({ profileId: "openai-compatible" }, null, 2), { mode: 0o600 });

	server = spawn("npx", ["tsx", "src/index.ts"], {
		shell: process.platform === "win32",
		...SMOKE_SERVER_SPAWN_TREE_OPTIONS,
		cwd: webServerDir,
		env: smokeEnv(limits),
	});
	server.stdout.on("data", (chunk) => serverOutput.push(String(chunk)));
	server.stderr.on("data", (chunk) => serverOutput.push(String(chunk)));
	await waitForServer(server);
}

/** Says why the part failed, with the server's last lines, and keeps the home for a look. */
export function reportDetachedFailure(error: unknown): void {
	const output = serverOutput.join("").trim();
	if (output) console.error(output.split("\n").slice(-80).join("\n"));
	console.error(error instanceof Error ? error.stack || error.message : error);
	console.error(`temp HOME preserved for inspection: ${tempHome}`);
	process.exitCode = 1;
}

/** Closes every socket the part opened, stops the server and the gateway, and removes the home after a pass. */
export async function stopDetachedServer(): Promise<void> {
	for (const socket of openedSockets) socket.close();
	await stopSmokeServer(server ?? undefined);
	gateway.close();
	if (process.exitCode == null || process.exitCode === 0) {
		fs.rmSync(tempHome, { recursive: true, force: true });
	}
}
