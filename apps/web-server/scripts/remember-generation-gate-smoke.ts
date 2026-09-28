// While Remember reads a conversation, the conversation holds still.
//
// A proposal is paid for, and it is only good for the conversation as it was
// when it was read: a message sent meanwhile (from a second device, where the
// Remember dialog does not cover the composer) made it stale at approval, and
// the person paid for nothing. And the dialog could be closed with Escape
// while the request kept running, with no way to stop it. Against a real
// spawned server, a synthetic gateway whose Remember call never finishes, and
// a real room websocket, this pins:
//
// 1. the progress read: one read of one while a single pass runs;
// 2. the gate: a prompt frame for the conversation is refused with the plain
//    sentence, and the gateway never sees a room turn for it;
// 3. a second Remember for the same conversation is refused with 409;
// 4. Cancel: the client closing the request aborts the worker's provider call
//    (the gateway sees its stream closed), the progress read answers 404, and
//    the next message goes through.

import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import { fileURLToPath } from "node:url";
import { authedFetch, SMOKE_AUTH_HEADERS, SMOKE_SERVER_AUTH_ENV, SMOKE_SERVER_SPAWN_TREE_OPTIONS, smokeHomeEnv, stopSmokeServer, type AuthedFetchInit } from "./smoke-server-process.js";

function assert(condition: unknown, message: string): asserts condition {
	if (!condition) throw new Error(message);
}

function pass(label: string): void {
	console.log(`  ok  ${label}`);
}

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const webServerDir = path.resolve(scriptDir, "..");
const repoRoot = path.resolve(webServerDir, "..", "..");
const port = 27000 + Math.floor(Math.random() * 10000);
const baseUrl = `http://127.0.0.1:${port}`;

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "exxperts-remember-gate-"));
const tempHome = path.join(tempRoot, "home");
const agentsRoot = path.join(tempHome, ".exxperts", "app", "personalized-agents");
const agentDir = path.join(tempHome, ".exxperts", "agent");
const productAppRoot = path.join(tempHome, ".exxperts", "app");
fs.mkdirSync(agentsRoot, { recursive: true, mode: 0o700 });
fs.mkdirSync(agentDir, { recursive: true, mode: 0o700 });
fs.mkdirSync(productAppRoot, { recursive: true, mode: 0o700 });

const FIRST_TURN = "FIRST_TURN_TOKEN";
const GATED_TURN = "GATED_TURN_TOKEN";
const AFTER_TURN = "AFTER_CANCEL_TURN_TOKEN";

// The gateway: a Remember call (its prompt carries the compression
// constitution) opens its stream and never finishes; a room turn answers.
type GatewayRequest = { body: string; remember: boolean; aborted: boolean };
const gatewayRequests: GatewayRequest[] = [];

function sseChunk(payload: unknown): string {
	return `data: ${JSON.stringify(payload)}\n\n`;
}

const gateway = http.createServer((req, res) => {
	if (req.method !== "POST" || !String(req.url ?? "").endsWith("/chat/completions")) {
		res.writeHead(404).end();
		return;
	}
	let body = "";
	req.on("data", (chunk) => { body += chunk; });
	req.on("end", () => {
		const record: GatewayRequest = { body, remember: body.includes("Checkpoint Compression Constitution"), aborted: false };
		gatewayRequests.push(record);
		res.on("close", () => { if (!res.writableFinished) record.aborted = true; });
		res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
		const base = { id: `cmpl_${gatewayRequests.length}`, object: "chat.completion.chunk", created: Math.floor(Date.now() / 1000), model: "room-model" };
		res.write(sseChunk({ ...base, choices: [{ index: 0, delta: { role: "assistant", content: "" }, finish_reason: null }] }));
		if (record.remember) return;
		res.write(sseChunk({ ...base, choices: [{ index: 0, delta: { content: "Answer." }, finish_reason: null }] }));
		res.write(sseChunk({ ...base, choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 100, completion_tokens: 2, total_tokens: 102 } }));
		res.write("data: [DONE]\n\n");
		res.end();
	});
});

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

async function requestJson(pathname: string, init: AuthedFetchInit = {}): Promise<{ status: number; body: any }> {
	const response = await authedFetch(`${baseUrl}${pathname}`, {
		...init,
		headers: { ...(init.body ? { "content-type": "application/json" } : {}), ...init.headers },
	});
	const text = await response.text();
	return { status: response.status, body: text ? JSON.parse(text) : null };
}

async function waitUntil(predicate: () => Promise<boolean> | boolean, label: string, timeoutMs = 25_000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (await predicate()) return;
		await new Promise((resolve) => setTimeout(resolve, 100));
	}
	throw new Error(`timed out waiting until ${label}`);
}

type Frame = Record<string, any>;
const WebSocketImpl: any = (await import("ws")).default;

let server: ChildProcessWithoutNullStreams | undefined;
const serverOutput: string[] = [];
let socket: any = null;
const frames: Frame[] = [];

async function waitForFrame(predicate: (frame: Frame) => boolean, label: string, fromIndex = 0): Promise<number> {
	const deadline = Date.now() + 25_000;
	let index = fromIndex;
	while (Date.now() < deadline) {
		for (; index < frames.length; index++) if (predicate(frames[index]!)) return index;
		await new Promise((resolve) => setTimeout(resolve, 25));
	}
	throw new Error(`timed out waiting for ${label}; saw ${frames.map((frame) => frame.type).join(", ")}`);
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
	fs.writeFileSync(path.join(agentDir, "auth.json"), JSON.stringify({ "openai-compatible": { type: "api_key", key: "synthetic-remember-gate-key" } }, null, 2), { mode: 0o600 });
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
		env: smokeHomeEnv(tempHome, {
			PORT: String(port),
			...SMOKE_SERVER_AUTH_ENV,
			EXXETA_HOME: repoRoot,
			EXXPERTS_CODING_AGENT_DIR: agentDir,
			EXXETA_PERSISTENT_AGENTS_ROOT: agentsRoot,
		}) as NodeJS.ProcessEnv,
	});
	server.stdout.on("data", (chunk) => serverOutput.push(String(chunk)));
	server.stderr.on("data", (chunk) => serverOutput.push(String(chunk)));
	await waitForServer(server);

	const room = await requestJson("/api/persistent-agents", { method: "POST", body: JSON.stringify({ displayName: "Remember Gate Room", userName: "Synthetic User", preferredUserAddress: "Synthetic User" }) });
	assert(room.status === 201, `room creation should return 201, got ${room.status}`);
	const agentId = String(room.body?.agent?.id ?? "");
	const conversationId = `smokeconv_gate_${Date.now().toString(36)}`;
	const seeded = await requestJson(`/api/persistent-agents/${encodeURIComponent(agentId)}/threads/${encodeURIComponent(conversationId)}`, {
		method: "PUT",
		body: JSON.stringify({ state: "active", origin: "launcher", model: { provider: "openai-compatible", model: "room-model" }, items: [] }),
	});
	assert(seeded.status === 200, `thread seed should return 200, got ${seeded.status}`);

	socket = new WebSocketImpl(`ws://127.0.0.1:${port}/ws?persistentAgentId=${agentId}&conversationId=${conversationId}&modelProvider=openai-compatible&model=room-model`, { headers: { ...SMOKE_AUTH_HEADERS } });
	socket.addEventListener("message", (event: { data: unknown }) => { try { frames.push(JSON.parse(String(event.data))); } catch {} });
	await new Promise<void>((resolve, reject) => {
		socket.addEventListener("open", () => resolve());
		socket.addEventListener("error", () => reject(new Error("websocket failed to connect")));
	});
	await waitForFrame((frame) => frame.type === "ready", "ready frame");
	socket.send(JSON.stringify({ type: "prompt", text: `Something worth remembering. ${FIRST_TURN}` }));
	await waitUntil(async () => (await requestJson(`/api/persistent-agents/${encodeURIComponent(agentId)}/status`)).body?.activeThread?.inFlight === false && gatewayRequests.some((request) => request.body.includes(FIRST_TURN)), "first turn settled");

	// --- A Remember that never finishes ------------------------------------------
	const cancel = new AbortController();
	const proposal = authedFetch(`${baseUrl}/api/persistent-agents/${encodeURIComponent(agentId)}/checkpoint/propose`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ conversationId, model: { provider: "openai-compatible", model: "room-model" }, density: "standard" }),
		signal: cancel.signal,
	}).then((response) => ({ status: response.status }), (error: Error) => ({ error }));
	await waitUntil(() => gatewayRequests.some((request) => request.remember), "the Remember call reaches the gateway");
	const rememberRequest = gatewayRequests.find((request) => request.remember)!;
	const progressPath = `/api/persistent-agents/${encodeURIComponent(agentId)}/checkpoint/progress?conversationId=${encodeURIComponent(conversationId)}`;
	const progress = await requestJson(progressPath);
	assert(progress.status === 200 && progress.body?.read === 0 && progress.body?.of === 1, `the progress read shows none of one read done, got ${progress.status} ${JSON.stringify(progress.body)}`);
	pass("while a single pass runs, the progress read shows 0 of 1");

	// --- The gate --------------------------------------------------------------
	const framesBefore = frames.length;
	const turnsBefore = gatewayRequests.filter((request) => !request.remember).length;
	socket.send(JSON.stringify({ type: "prompt", text: `A message during Remember. ${GATED_TURN}` }));
	const refusalIndex = await waitForFrame((frame) => frame.type === "error" && typeof frame.message === "string", "the refusal frame", framesBefore);
	assert(frames[refusalIndex]!.message === "Remember is reading this conversation. Send your message when it has finished, or cancel it.", `the refusal is the plain sentence, got ${JSON.stringify(frames[refusalIndex]!.message)}`);
	await new Promise((resolve) => setTimeout(resolve, 500));
	assert(gatewayRequests.filter((request) => !request.remember).length === turnsBefore && !gatewayRequests.some((request) => request.body.includes(GATED_TURN)), "the refused message never reaches the model");
	pass("a prompt frame during the proposal is refused with the plain sentence and never reaches the model");

	const second = await requestJson(`/api/persistent-agents/${encodeURIComponent(agentId)}/checkpoint/propose`, { method: "POST", body: JSON.stringify({ conversationId, model: { provider: "openai-compatible", model: "room-model" }, density: "standard" }) });
	assert(second.status === 409 && /Remember is already reading this conversation/.test(String(second.body?.error)), `a second Remember for the conversation is refused with 409, got ${second.status} ${JSON.stringify(second.body)}`);
	assert(gatewayRequests.filter((request) => request.remember).length === 1, "the refused second Remember calls no model");
	pass("a second Remember for the same conversation is refused with 409 and calls no model");

	// --- Cancel ----------------------------------------------------------------
	cancel.abort();
	const settled = await proposal;
	assert("error" in settled, "the cancelled request ends on the client");
	await waitUntil(() => rememberRequest.aborted, "the worker's provider call is closed");
	pass("Cancel closes the request, and the worker's provider call is aborted");
	await waitUntil(async () => (await requestJson(progressPath)).status === 404, "the progress read answers 404");
	pass("once cancelled, the progress read answers 404");
	const framesAfter = frames.length;
	socket.send(JSON.stringify({ type: "prompt", text: `The next message. ${AFTER_TURN}` }));
	await waitUntil(() => gatewayRequests.some((request) => request.body.includes(AFTER_TURN)), "the next message reaches the model");
	assert(!frames.slice(framesAfter).some((frame) => frame.type === "error"), "the next message is not refused");
	pass("the next message after the cancel goes through");

	console.log("remember generation gate smoke passed");
} catch (error) {
	console.error(serverOutput.join("").slice(-6000));
	throw error;
} finally {
	try { socket?.close(); } catch {}
	try { (gateway as any).closeAllConnections?.(); } catch {}
	try { gateway.close(); } catch {}
	await stopSmokeServer(server);
	fs.rmSync(tempRoot, { recursive: true, force: true });
}
