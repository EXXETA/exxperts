// The conversation Remember or Forget prepares boots on the room's model as it
// is at its first boot.
//
// A conversation is prepared at the boundary on the room's conversation model
// of that moment. If the person changes the room's model in Room settings
// before saying anything in it, the prepared conversation must start on the
// new pick, or the pick silently reverts (GitHub #58). Once something is said
// in it, its lock is its own. Against a real spawned server and a synthetic
// gateway with two room models: Forget prepares a conversation on the first;
// the room's pick moves to the second; the first bind of the prepared
// conversation runs on the second (the record, the runtime state, the ready
// frame and the model the gateway is asked for all agree); after a message in
// it, a further change of pick leaves it where it is.

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

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "exxperts-prepared-thread-model-"));
const tempHome = path.join(tempRoot, "home");
const agentsRoot = path.join(tempHome, ".exxperts", "app", "personalized-agents");
const agentDir = path.join(tempHome, ".exxperts", "agent");
const appDir = path.join(tempHome, ".exxperts", "app");
fs.mkdirSync(agentsRoot, { recursive: true, mode: 0o700 });
fs.mkdirSync(agentDir, { recursive: true, mode: 0o700 });

type GatewayRequest = { model: string; remember: boolean; maxTokens?: number };
const gatewayRequests: GatewayRequest[] = [];

function sseChunk(payload: unknown): string {
	return `data: ${JSON.stringify(payload)}\n\n`;
}

const gateway = http.createServer((req, res) => {
	let body = "";
	req.on("data", (chunk) => { body += chunk; });
	req.on("end", () => {
		const parsed = JSON.parse(body || "{}");
		const remember = body.includes("Checkpoint Compression Constitution");
		gatewayRequests.push({ model: String(parsed.model ?? ""), remember, maxTokens: parsed.max_completion_tokens ?? parsed.max_tokens });
		res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
		const base = { id: `cmpl_${gatewayRequests.length}`, object: "chat.completion.chunk", created: Math.floor(Date.now() / 1000), model: parsed.model };
		res.write(sseChunk({ ...base, choices: [{ index: 0, delta: { role: "assistant", content: "Answer." }, finish_reason: null }] }));
		res.write(sseChunk({ ...base, choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 } }));
		res.write("data: [DONE]\n\n");
		res.end();
	});
});

async function api(pathname: string, init: AuthedFetchInit = {}): Promise<{ status: number; body: any }> {
	const response = await authedFetch(`${baseUrl}${pathname}`, { ...init, headers: { ...(init.body ? { "content-type": "application/json" } : {}), ...init.headers } });
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

const WebSocketImpl: any = (await import("ws")).default;
let server: ChildProcessWithoutNullStreams | undefined;
const serverOutput: string[] = [];

async function bindAndSend(agentId: string, conversationId: string, text?: string): Promise<{ ready: any }> {
	const socket = new WebSocketImpl(`ws://127.0.0.1:${port}/ws?persistentAgentId=${agentId}&conversationId=${conversationId}&modelProvider=openai-compatible&model=first-model`, { headers: { ...SMOKE_AUTH_HEADERS } });
	const frames: any[] = [];
	socket.addEventListener("message", (event: { data: unknown }) => { try { frames.push(JSON.parse(String(event.data))); } catch {} });
	await new Promise<void>((resolve, reject) => { socket.addEventListener("open", () => resolve()); socket.addEventListener("error", () => reject(new Error("websocket failed to connect"))); });
	await waitUntil(() => frames.some((frame) => frame.type === "ready" || frame.type === "error"), "ready frame");
	const ready = frames.find((frame) => frame.type === "ready" || frame.type === "error");
	if (text) {
		const before = gatewayRequests.length;
		socket.send(JSON.stringify({ type: "prompt", text }));
		await waitUntil(async () => gatewayRequests.length > before && (await api(`/api/persistent-agents/${agentId}/status`)).body?.activeThread?.inFlight === false, "the turn settled");
	}
	try { socket.close(); } catch {}
	await waitUntil(async () => !(await api(`/api/persistent-agents/${agentId}/status`)).body?.activeLock, "the room lock released");
	return { ready };
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
				models: [
					{ id: "first-model", name: "First Model", contextWindow: 128000, maxTokens: 16000 },
					{ id: "second-model", name: "Second Model", contextWindow: 128000, maxTokens: 16000 },
				],
			},
		},
	}, null, 2), { mode: 0o600 });
	fs.writeFileSync(path.join(agentDir, "auth.json"), JSON.stringify({ "openai-compatible": { type: "api_key", key: "synthetic-prepared-thread-key" } }, null, 2), { mode: 0o600 });
	fs.writeFileSync(path.join(appDir, "openai-compatible-ai-profile.json"), JSON.stringify({ profileId: "openai-compatible", providerId: "openai-compatible", label: "Synthetic Gateway", roomModels: [{ modelId: "first-model" }, { modelId: "second-model" }], maintenanceModel: "first-model" }, null, 2), { mode: 0o600 });
	fs.writeFileSync(path.join(appDir, "persistent-agent-ai-profile.json"), JSON.stringify({ profileId: "openai-compatible" }, null, 2), { mode: 0o600 });

	server = spawn("npx", ["tsx", "src/index.ts"], {
		shell: process.platform === "win32",
		...SMOKE_SERVER_SPAWN_TREE_OPTIONS,
		cwd: webServerDir,
		env: smokeHomeEnv(tempHome, { PORT: String(port), ...SMOKE_SERVER_AUTH_ENV, EXXETA_HOME: repoRoot, EXXPERTS_CODING_AGENT_DIR: agentDir, EXXETA_PERSISTENT_AGENTS_ROOT: agentsRoot }) as NodeJS.ProcessEnv,
	});
	server.stdout.on("data", (chunk) => serverOutput.push(String(chunk)));
	server.stderr.on("data", (chunk) => serverOutput.push(String(chunk)));
	await waitUntil(() => fetch(`${baseUrl}/healthz`).then((r) => r.ok).catch(() => false), "server ready");

	const room = await api("/api/persistent-agents", { method: "POST", body: JSON.stringify({ displayName: "Prepared Thread Room", userName: "Synthetic User", preferredUserAddress: "Synthetic User" }) });
	const agentId = String(room.body?.agent?.id ?? "");
	const conversationId = `smokeconv_prepared_${Date.now().toString(36)}`;
	await api(`/api/persistent-agents/${agentId}/threads/${conversationId}`, { method: "PUT", body: JSON.stringify({ state: "active", origin: "launcher", items: [] }) });
	await bindAndSend(agentId, conversationId, "A first conversation.");

	// Forget prepares the next conversation on the room's model of this moment.
	const forget = await api(`/api/persistent-agents/${agentId}/memento`, { method: "POST", body: JSON.stringify({ conversationId }) });
	assert(forget.status === 200, `Forget works, got ${forget.status} ${JSON.stringify(forget.body).slice(0, 200)}`);
	const prepared = (await api(`/api/persistent-agents/${agentId}/status`)).body.runtime;
	assert(prepared.activeThreadId?.startsWith("postmem_") && prepared.model?.model === "first-model", `Forget prepares a conversation on the room's model, got ${JSON.stringify(prepared)}`);
	pass("Forget prepares the next conversation on the room's model of that moment");

	// The pick moves before anyone speaks in the prepared conversation.
	const moved = await api(`/api/persistent-agents/${agentId}/models`, { method: "PUT", body: JSON.stringify({ conversation: { provider: "openai-compatible", model: "second-model" } }) });
	assert(moved.status === 200, `the room's pick moves, got ${moved.status}`);
	const beforeBoot = gatewayRequests.length;
	const firstBoot = await bindAndSend(agentId, prepared.activeThreadId, "The first message in the prepared conversation.");
	assert(firstBoot.ready.type === "ready" && firstBoot.ready.model?.model === "second-model", `the prepared conversation's first bind runs on the new pick, got ${JSON.stringify(firstBoot.ready)}`);
	assert(gatewayRequests.slice(beforeBoot).every((request) => request.model === "second-model"), `the gateway is asked for the new pick, got ${JSON.stringify(gatewayRequests.slice(beforeBoot))}`);
	const thread = await api(`/api/persistent-agents/${agentId}/threads/${prepared.activeThreadId}`);
	assert(thread.body?.thread?.model?.model === "second-model", `the prepared conversation's record now holds the new pick, got ${JSON.stringify(thread.body?.thread?.model)}`);
	assert((await api(`/api/persistent-agents/${agentId}/status`)).body.runtime.model?.model === "second-model", "the runtime state follows");
	pass("the prepared conversation boots on the pick made after it was prepared: the record, the runtime state, the ready frame and the provider call agree");

	// Spoken in, the conversation keeps its lock.
	await api(`/api/persistent-agents/${agentId}/models`, { method: "PUT", body: JSON.stringify({ conversation: { provider: "openai-compatible", model: "first-model" } }) });
	const again = await bindAndSend(agentId, prepared.activeThreadId);
	assert(again.ready.type === "ready" && again.ready.model?.model === "second-model", `a conversation with a message in it keeps its own lock, got ${JSON.stringify(again.ready)}`);
	pass("once something is said in it, a later change of pick leaves the conversation on its own lock");

	console.log("prepared thread model smoke passed");
} catch (error) {
	console.error(serverOutput.join("").slice(-6000));
	throw error;
} finally {
	try { (gateway as any).closeAllConnections?.(); } catch {}
	try { gateway.close(); } catch {}
	await stopSmokeServer(server);
	fs.rmSync(tempRoot, { recursive: true, force: true });
}
