// The end-of-turn conversation switch: a turn finishes on conversation N, the
// client leaves on the first agent_end frame and opens conversation N+1 at
// once. The server lands N's answer itself when the client is gone; before
// 0.13.2 that landing moved the room's pointer back to N whenever it ran after
// the switch (about one run in three on Linux, never seen on macOS), and the
// next message on N+1 was refused as not current. Twenty rounds: every prompt
// on N+1 must be accepted and every N must carry its landed answer.
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

const ROUNDS = 20;
const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const webServerDir = path.resolve(scriptDir, "..");
const repoRoot = path.resolve(webServerDir, "..", "..");
const port = 26000 + Math.floor(Math.random() * 10000);
const baseUrl = `http://127.0.0.1:${port}`;

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "exxperts-switch-race-"));
const tempHome = path.join(tempRoot, "home");
const agentsRoot = path.join(tempHome, ".exxperts", "app", "personalized-agents");
const agentDir = path.join(tempHome, ".exxperts", "agent");
const productAppRoot = path.join(tempHome, ".exxperts", "app");
fs.mkdirSync(agentsRoot, { recursive: true, mode: 0o700 });
fs.mkdirSync(agentDir, { recursive: true, mode: 0o700 });

// Synthetic gateway: every request is answered with one short streamed text.
// A prompt that mentions "slow" is answered after a pause, long enough for a
// second socket to step into the conversation while the turn is still running.
function sseChunk(payload: unknown): string {
	return `data: ${JSON.stringify(payload)}\n\n`;
}
const SLOW_ANSWER_MS = 1500;
let completions = 0;
const gateway = http.createServer((req, res) => {
	if (req.method !== "POST" || !String(req.url ?? "").endsWith("/chat/completions")) {
		res.writeHead(404).end();
		return;
	}
	let body = "";
	req.on("data", (chunk) => { body += chunk; });
	req.on("end", () => {
		completions += 1;
		let parsed: any = {};
		try { parsed = JSON.parse(body); } catch {}
		const messages: any[] = Array.isArray(parsed?.messages) ? parsed.messages : [];
		const lastUser = [...messages].reverse().find((message) => message?.role === "user");
		const slow = /slow/.test(typeof lastUser?.content === "string" ? lastUser.content : JSON.stringify(lastUser?.content ?? ""));
		res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
		const base = { id: `cmpl_${completions}`, object: "chat.completion.chunk", created: Math.floor(Date.now() / 1000), model: String(parsed?.model ?? "room-model") };
		const answer = () => {
			res.write(sseChunk({ ...base, choices: [{ index: 0, delta: { role: "assistant", content: `answer ${completions}` }, finish_reason: null }] }));
			res.write(sseChunk({ ...base, choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 50, completion_tokens: 3, total_tokens: 53 } }));
			res.write("data: [DONE]\n\n");
			res.end();
		};
		if (slow) setTimeout(answer, SLOW_ANSWER_MS);
		else answer();
	});
});

async function requestJson(pathname: string, init: AuthedFetchInit = {}): Promise<{ status: number; body: any }> {
	const response = await authedFetch(`${baseUrl}${pathname}`, {
		...init,
		headers: { ...(init.body ? { "content-type": "application/json" } : {}), ...init.headers },
	});
	const text = await response.text();
	return { status: response.status, body: text ? JSON.parse(text) : null };
}

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
		await new Promise((resolve) => setTimeout(resolve, 150));
	}
	throw new Error(`server did not become ready: ${lastError}`);
}

const WebSocketImpl: any = (await import("ws")).default;

function openConversation(agentId: string, conversationId: string) {
	return requestJson(`/api/persistent-agents/${encodeURIComponent(agentId)}/threads/${encodeURIComponent(conversationId)}`, {
		method: "PUT",
		body: JSON.stringify({ state: "active", origin: "launcher", model: { provider: "openai-compatible", model: "room-model" }, items: [] }),
	});
}

function openSocket(agentId: string, conversationId: string): { socket: any; frames: any[]; opened: Promise<void> } {
	const socket = new WebSocketImpl(`ws://127.0.0.1:${port}/ws?persistentAgentId=${agentId}&conversationId=${conversationId}&modelProvider=openai-compatible&model=room-model&reattach=1`, { headers: { ...SMOKE_AUTH_HEADERS } });
	const frames: any[] = [];
	socket.addEventListener("message", (event: { data: unknown }) => {
		try { frames.push(JSON.parse(String(event.data))); } catch {}
	});
	const opened = new Promise<void>((resolve, reject) => {
		socket.addEventListener("open", () => resolve());
		socket.addEventListener("error", () => reject(new Error("websocket failed to connect")));
	});
	return { socket, frames, opened };
}

// The assistant text of the turn as the client saw it, from the message_end frame.
function assistantTextFromFrames(frames: any[]): string {
	const ends = frames.filter((frame) => frame?.type === "event" && frame?.event?.type === "message_end" && frame?.event?.message?.role === "assistant");
	const parts = ends.flatMap((frame) => (Array.isArray(frame.event.message.content) ? frame.event.message.content : []));
	return parts.filter((part: any) => part?.type === "text").map((part: any) => String(part.text ?? "")).join("").trim();
}

// Prompts on a conversation and resolves on the first agent_end frame, with
// the socket still open so the caller decides when to leave. Rejects on an
// error frame (a refused prompt arrives as one).
async function promptUntilAgentEnd(agentId: string, conversationId: string): Promise<{ close: () => void; answer: () => string }> {
	const { socket, frames, opened } = openSocket(agentId, conversationId);
	await opened;
	socket.send(JSON.stringify({ type: "prompt", text: `message on ${conversationId}` }));
	const deadline = Date.now() + 30_000;
	while (Date.now() < deadline) {
		if (frames.some((frame) => frame?.type === "event" && frame?.event?.type === "agent_end")) return { close: () => { try { socket.close(); } catch {} }, answer: () => assistantTextFromFrames(frames) };
		const error = frames.find((frame) => String(frame?.type ?? "").includes("error"));
		if (error) {
			try { socket.close(); } catch {}
			throw new Error(`prompt on ${conversationId} was refused: ${JSON.stringify(error).slice(0, 400)}`);
		}
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
	try { socket.close(); } catch {}
	throw new Error(`turn on ${conversationId} did not end; frame types: ${frames.map((f) => f?.type).join(", ")}`);
}

// Steps back into a conversation right after leaving it, the way a reload
// does: the first bind may still find the old connection winding down, so the
// attach is retried for a moment until a ready frame arrives.
async function attachUntilReady(agentId: string, conversationId: string): Promise<{ close: () => void }> {
	const deadline = Date.now() + 10_000;
	let lastError = "no attempt";
	while (Date.now() < deadline) {
		const { socket, frames, opened } = openSocket(agentId, conversationId);
		await opened;
		const attempt = Date.now() + 3_000;
		while (Date.now() < attempt) {
			if (frames.some((frame) => frame?.type === "ready")) return { close: () => { try { socket.close(); } catch {} } };
			const error = frames.find((frame) => String(frame?.type ?? "").includes("error"));
			if (error) {
				lastError = JSON.stringify(error).slice(0, 300);
				break;
			}
			await new Promise((resolve) => setTimeout(resolve, 10));
		}
		try { socket.close(); } catch {}
		await new Promise((resolve) => setTimeout(resolve, 100));
	}
	throw new Error(`could not step back into ${conversationId}: ${lastError}`);
}

async function readThread(agentId: string, conversationId: string): Promise<any> {
	const thread = await requestJson(`/api/persistent-agents/${encodeURIComponent(agentId)}/threads/${encodeURIComponent(conversationId)}`);
	return thread.status === 200 ? thread.body?.thread ?? null : null;
}

function assistantItems(thread: any): any[] {
	return (thread?.items ?? []).filter((item: any) => item?.kind === "assistant");
}

// Waits until the conversation carries at least one landed assistant answer.
async function waitForLandedAnswer(agentId: string, conversationId: string): Promise<any> {
	const deadline = Date.now() + 10_000;
	let thread: any = null;
	while (Date.now() < deadline) {
		thread = await readThread(agentId, conversationId);
		if (assistantItems(thread).some((item) => /^answer \d+$/.test(String(item?.text ?? "")))) return thread;
		await new Promise((resolve) => setTimeout(resolve, 50));
	}
	return thread;
}

let server: ChildProcessWithoutNullStreams | undefined;
const serverOutput: string[] = [];
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
	fs.writeFileSync(path.join(agentDir, "auth.json"), JSON.stringify({ "openai-compatible": { type: "api_key", key: "synthetic-race-key" } }, null, 2), { mode: 0o600 });
	fs.writeFileSync(path.join(productAppRoot, "openai-compatible-ai-profile.json"), JSON.stringify({
		profileId: "openai-compatible",
		providerId: "openai-compatible",
		label: "Synthetic Gateway",
		roomModels: [{ modelId: "room-model", label: "Room Model" }],
		maintenanceModel: "room-model",
	}, null, 2), { mode: 0o600 });
	fs.writeFileSync(path.join(productAppRoot, "persistent-agent-ai-profile.json"), JSON.stringify({ profileId: "openai-compatible" }, null, 2), { mode: 0o600 });

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

	const room = await requestJson("/api/persistent-agents", { method: "POST", body: JSON.stringify({ displayName: "Switch Race Room", userName: "Synthetic User", preferredUserAddress: "Synthetic User" }) });
	assert(room.status === 201, `room creation: expected 201, got ${room.status}: ${JSON.stringify(room.body)}`);
	const agentId = String(room.body?.agent?.id ?? room.body?.agent?.agentId ?? "");
	assert(agentId, "room creation must return an id");

	const first = await openConversation(agentId, "conv-round-0");
	assert(first.status === 200, `conversation 0: expected 200, got ${first.status}`);
	let running = await promptUntilAgentEnd(agentId, "conv-round-0");
	for (let round = 1; round <= ROUNDS; round++) {
		const previous = `conv-round-${round - 1}`;
		const next = `conv-round-${round}`;
		// Leave on the first agent_end and switch at once: the server lands the
		// previous answer on its own while the switch is already under way.
		running.close();
		const opened = await openConversation(agentId, next);
		assert(opened.status === 200, `round ${round}: opening ${next} expected 200, got ${opened.status}: ${JSON.stringify(opened.body).slice(0, 300)}`);
		try {
			running = await promptUntilAgentEnd(agentId, next);
		} catch (error) {
			throw new Error(`round ${round}: ${(error as Error).message}`);
		}
		// The previous conversation carries its landed answer, whichever way the race went.
		const landed = await waitForLandedAnswer(agentId, previous);
		assert(assistantItems(landed).length === 1 && /^answer \d+$/.test(String(assistantItems(landed)[0]?.text ?? "")), `round ${round}: ${previous} must carry its landed assistant answer once, got state ${landed?.state} items ${JSON.stringify(landed?.items ?? []).slice(0, 600)}`);
		// The person left it for another conversation: nobody watched the landing, so it is parked.
		assert(landed?.state === "standby", `round ${round}: ${previous} is parked as standby after the person moved on, got ${landed?.state}`);
	}

	running.close();

	// Adoption: a second socket steps into the SAME conversation while its
	// turn is still running (a reload), then the first socket leaves. The
	// answer is landed exactly once and the conversation stays active: nobody
	// parks a room somebody is inside.
	const adopted = "conv-adoption-slow";
	assert((await openConversation(agentId, adopted)).status === 200, "the adoption conversation opens");
	const { socket: leaver, frames: leaverFrames, opened: leaverOpened } = openSocket(agentId, adopted);
	await leaverOpened;
	leaver.send(JSON.stringify({ type: "prompt", text: `slow message on ${adopted}` }));
	await new Promise((resolve) => setTimeout(resolve, 300));
	assert(!leaverFrames.some((frame) => frame?.type === "event" && frame?.event?.type === "agent_end"), "the slow turn is still running when the second socket steps in");
	const adopter = await attachUntilReady(agentId, adopted);
	try { leaver.close(); } catch {}
	const adoptedThread = await waitForLandedAnswer(agentId, adopted);
	await new Promise((resolve) => setTimeout(resolve, SLOW_ANSWER_MS));
	const adoptedSettled = await readThread(agentId, adopted);
	assert(assistantItems(adoptedSettled).length === 1, `adoption: exactly one assistant item, got ${JSON.stringify(adoptedSettled?.items ?? []).slice(0, 600)} (first read ${JSON.stringify(adoptedThread?.items ?? []).slice(0, 300)})`);
	assert(adoptedSettled?.state === "active", `adoption: the conversation stays active, got ${adoptedSettled?.state}`);
	adopter.close();

	// The client stays and persists after agent_end, as the app does: the
	// close-time landing finds the answer already there and adds nothing.
	const persisted = "conv-client-persist";
	assert((await openConversation(agentId, persisted)).status === 200, "the client-persist conversation opens");
	const stayed = await promptUntilAgentEnd(agentId, persisted);
	const seenAnswer = stayed.answer();
	assert(/^answer \d+$/.test(seenAnswer), `the client saw the answer in its message_end frame, got ${JSON.stringify(seenAnswer)}`);
	const clientItems = [{ kind: "user", id: "client-user", text: `message on ${persisted}` }, { kind: "assistant", id: "client-assistant", text: seenAnswer, streaming: false }];
	const clientSave = await requestJson(`/api/persistent-agents/${encodeURIComponent(agentId)}/threads/${encodeURIComponent(persisted)}`, {
		method: "PUT",
		body: JSON.stringify({ state: "active", origin: "launcher", model: { provider: "openai-compatible", model: "room-model" }, items: clientItems }),
	});
	assert(clientSave.status === 200, `the client persist is accepted, got ${clientSave.status}`);
	stayed.close();
	await new Promise((resolve) => setTimeout(resolve, 500));
	const afterClientSave = await readThread(agentId, persisted);
	assert(assistantItems(afterClientSave).length === 1 && assistantItems(afterClientSave)[0]?.id === "client-assistant", `a client persist before the close leaves exactly the client's assistant item, got ${JSON.stringify(afterClientSave?.items ?? []).slice(0, 600)}`);

	// A client persist that arrives AFTER the server landed the answer merges
	// with it instead of doubling it.
	const late = "conv-late-client-save";
	assert((await openConversation(agentId, late)).status === 200, "the late-save conversation opens");
	const left = await promptUntilAgentEnd(agentId, late);
	const lateAnswer = left.answer();
	left.close();
	const landedLate = await waitForLandedAnswer(agentId, late);
	assert(assistantItems(landedLate).length === 1, `the server landed the answer once before the late save, got ${JSON.stringify(landedLate?.items ?? []).slice(0, 600)}`);
	const lateSave = await requestJson(`/api/persistent-agents/${encodeURIComponent(agentId)}/threads/${encodeURIComponent(late)}`, {
		method: "PUT",
		body: JSON.stringify({ state: "standby", origin: "launcher", model: { provider: "openai-compatible", model: "room-model" }, items: [{ kind: "user", id: "late-user", text: `message on ${late}` }, { kind: "assistant", id: "late-assistant", text: lateAnswer, streaming: false }] }),
	});
	assert(lateSave.status === 200, `the late client save is accepted, got ${lateSave.status}`);
	const afterLateSave = await readThread(agentId, late);
	assert(assistantItems(afterLateSave).length === 1 && String(assistantItems(afterLateSave)[0]?.text ?? "") === lateAnswer, `a late client save merges with the landed answer, got ${JSON.stringify(afterLateSave?.items ?? []).slice(0, 600)}`);

	console.log(`conversation-switch-race-smoke: OK (${ROUNDS} rounds, adoption, client persist before and after the landing)`);
} catch (error) {
	console.error(serverOutput.join("").split("\n").filter((line) => !/incoming request|request completed/.test(line)).join("\n").slice(-6000));
	console.error(error instanceof Error ? error.stack || error.message : error);
	process.exitCode = 1;
} finally {
	try { gateway.close(); } catch {}
	await stopSmokeServer(server);
	fs.rmSync(tempRoot, { recursive: true, force: true });
}
