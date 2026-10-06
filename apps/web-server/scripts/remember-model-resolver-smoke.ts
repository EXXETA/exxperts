// Remember runs on the room's memory model, whatever the client sends.
//
// Against a real spawned server and a synthetic gateway that records which
// model each call asks for: a room talks on the gateway's room model and has
// its memory row on the gateway's Memorize model. A Remember whose request
// body names the room model runs on the memory model anyway, asks for a 16k
// output cap, and says on the proposal which model read the conversation. An
// approval after the memory row changed is refused with the plain sentence. A
// memory pick on a signed-out provider is refused with the sentence that names
// it, and nothing runs in its place; cleared, the row runs on the default. A
// Remember that is approved starts the next conversation on the room's
// conversation model.

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

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "exxperts-remember-model-"));
const tempHome = path.join(tempRoot, "home");
const agentsRoot = path.join(tempHome, ".exxperts", "app", "personalized-agents");
const agentDir = path.join(tempHome, ".exxperts", "agent");
const appDir = path.join(tempHome, ".exxperts", "app");
fs.mkdirSync(agentsRoot, { recursive: true, mode: 0o700 });
fs.mkdirSync(agentDir, { recursive: true, mode: 0o700 });

type GatewayRequest = { model: string; remember: boolean; maxTokens?: number };
const gatewayRequests: GatewayRequest[] = [];
const FIELDS = "TITLE:\nSupplier review\n\nSESSION_ARC:\nThe review settled the supplier.\n\nBODY:\n- The supplier stays.\n\nPARKED:\nNone\n";

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
		res.write(sseChunk({ ...base, choices: [{ index: 0, delta: { role: "assistant", content: remember ? FIELDS : "Answer." }, finish_reason: null }] }));
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
					{ id: "room-model", name: "Room Model", contextWindow: 128000, maxTokens: 64000 },
					{ id: "maint-model", name: "Maintenance Model", contextWindow: 200000, maxTokens: 64000 },
				],
			},
		},
	}, null, 2), { mode: 0o600 });
	fs.writeFileSync(path.join(agentDir, "auth.json"), JSON.stringify({ "openai-compatible": { type: "api_key", key: "synthetic-remember-model-key" } }, null, 2), { mode: 0o600 });
	fs.writeFileSync(path.join(appDir, "openai-compatible-ai-profile.json"), JSON.stringify({ profileId: "openai-compatible", providerId: "openai-compatible", label: "Synthetic Gateway", roomModels: [{ modelId: "room-model", label: "Room Model" }], maintenanceModel: "maint-model" }, null, 2), { mode: 0o600 });
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

	const room = await api("/api/persistent-agents", { method: "POST", body: JSON.stringify({ displayName: "Remember Model Room", userName: "Synthetic User", preferredUserAddress: "Synthetic User" }) });
	const agentId = String(room.body?.agent?.id ?? "");
	const conversationId = `smokeconv_remember_${Date.now().toString(36)}`;
	const seeded = await api(`/api/persistent-agents/${agentId}/threads/${conversationId}`, { method: "PUT", body: JSON.stringify({ state: "active", origin: "launcher", items: [] }) });
	assert(seeded.status === 200 && seeded.body?.thread?.model?.model === "room-model", `a new conversation starts on the room's conversation model, got ${JSON.stringify(seeded.body?.thread?.model)}`);
	const memoryPick = await api(`/api/persistent-agents/${agentId}/models`, { method: "PUT", body: JSON.stringify({ memory: { provider: "openai-compatible", model: "maint-model" } }) });
	assert(memoryPick.status === 200, `the memory row takes the gateway's Memorize model, got ${memoryPick.status}`);

	// One turn, so there is a conversation to remember.
	const socket = new WebSocketImpl(`ws://127.0.0.1:${port}/ws?persistentAgentId=${agentId}&conversationId=${conversationId}`, { headers: { ...SMOKE_AUTH_HEADERS } });
	const frames: any[] = [];
	socket.addEventListener("message", (event: { data: unknown }) => { try { frames.push(JSON.parse(String(event.data))); } catch {} });
	await new Promise<void>((resolve, reject) => { socket.addEventListener("open", () => resolve()); socket.addEventListener("error", () => reject(new Error("websocket failed to connect"))); });
	await waitUntil(() => frames.some((frame) => frame.type === "ready"), "ready frame");
	assert(frames.find((frame) => frame.type === "ready")?.model?.model === "room-model", "a socket that names no model binds on the conversation's lock");
	socket.send(JSON.stringify({ type: "prompt", text: "The supplier stays; please remember that." }));
	await waitUntil(async () => (await api(`/api/persistent-agents/${agentId}/status`)).body?.activeThread?.inFlight === false && gatewayRequests.some((request) => !request.remember), "the turn settled");
	pass("a new conversation starts and binds on the room's conversation model with no model named by the client");

	// Remember names the room model in its body; it runs on the memory model.
	gatewayRequests.length = 0;
	const proposal = await api(`/api/persistent-agents/${agentId}/checkpoint/propose`, { method: "POST", body: JSON.stringify({ conversationId, model: { provider: "openai-compatible", model: "room-model" }, density: "standard" }) });
	assert(proposal.status === 200, `the proposal is written, got ${proposal.status} ${JSON.stringify(proposal.body).slice(0, 300)}`);
	const rememberCalls = gatewayRequests.filter((request) => request.remember);
	assert(rememberCalls.length === 1 && rememberCalls[0]!.model === "maint-model", `Remember runs on the memory model, not the model the client named, got ${JSON.stringify(rememberCalls)}`);
	assert(rememberCalls[0]!.maxTokens === 16000, `Remember asks for a 16k output cap, got ${rememberCalls[0]!.maxTokens}`);
	assert(proposal.body.process?.model?.model === "maint-model" && proposal.body.rememberRead?.model?.model === "maint-model" && /Maintenance Model/.test(String(proposal.body.rememberRead?.model?.label)), `the proposal says which model read the conversation, got ${JSON.stringify(proposal.body.rememberRead?.model)}`);
	const estimate = await api(`/api/persistent-agents/${agentId}/checkpoint/estimate?conversationId=${conversationId}`);
	assert(estimate.body?.model?.model === "maint-model", `the estimate names the memory model too, got ${JSON.stringify(estimate.body)}`);
	pass("Remember runs on the room's memory model at a 16k cap, ignoring the model in the request, and the proposal and the estimate name it");

	// The memory row changes before approval: the proposal is refused.
	await api(`/api/persistent-agents/${agentId}/models`, { method: "PUT", body: JSON.stringify({ memory: { provider: "openai-compatible", model: "room-model" } }) });
	const approveBody = { conversationId, density: proposal.body.density, proposal: proposal.body, approvedRecentContext: proposal.body.proposedRecentContext };
	const refused = await api(`/api/persistent-agents/${agentId}/checkpoint/approve`, { method: "POST", body: JSON.stringify(approveBody) });
	assert(refused.status === 409 && refused.body?.error === "The memory model changed after this proposal was written. Nothing was saved. Generate the proposal again.", `an approval after the memory row changed is refused with the plain sentence, got ${refused.status} ${JSON.stringify(refused.body)}`);
	pass("an approval after the memory row changed is refused with the plain sentence, and nothing is saved");

	// A memory pick on a signed-out provider: refused, and nothing runs in its place.
	fs.writeFileSync(path.join(agentsRoot, agentId, "runtime", "models.json"), JSON.stringify({ schemaVersion: 1, memory: { provider: "anthropic", model: "claude-opus-5-5" }, updatedAt: new Date().toISOString() }, null, 2));
	let rows = await api(`/api/persistent-agents/${agentId}/models`);
	assert(rows.body.models.memory.reason === "signed-out" && rows.body.models.memory.effective === null && /^This room's memory model, .+, is signed out\. Sign in again in Settings, AI setup, or choose another model in Room settings, Model\.$/.test(rows.body.models.memory.refusal), `a memory pick on a signed-out provider waits and says why, got ${JSON.stringify(rows.body.models.memory)}`);
	gatewayRequests.length = 0;
	const waiting = await api(`/api/persistent-agents/${agentId}/checkpoint/propose`, { method: "POST", body: JSON.stringify({ conversationId, density: "standard" }) });
	assert(waiting.status === 409 && waiting.body?.code === "provider_signed_out" && waiting.body?.error === rows.body.models.memory.refusal, `Remember is refused with the row's sentence, got ${waiting.status} ${JSON.stringify(waiting.body)}`);
	assert(!gatewayRequests.some((request) => request.remember), `no model read the conversation in its place, got ${JSON.stringify(gatewayRequests)}`);
	pass("a memory pick on a signed-out provider is refused with the sentence, and no other model runs Remember");

	// The pick cleared: the row follows the default again, and Remember runs there.
	await api(`/api/persistent-agents/${agentId}/models`, { method: "PUT", body: JSON.stringify({ memory: null }) });
	rows = await api(`/api/persistent-agents/${agentId}/models`);
	assert(rows.body.models.memory.effective?.model === "maint-model" && !rows.body.models.memory.reason, `a cleared memory row runs on the default, got ${JSON.stringify(rows.body.models.memory)}`);
	gatewayRequests.length = 0;
	const fallback = await api(`/api/persistent-agents/${agentId}/checkpoint/propose`, { method: "POST", body: JSON.stringify({ conversationId, density: "standard" }) });
	assert(fallback.status === 200 && gatewayRequests.filter((request) => request.remember).every((request) => request.model === "maint-model"), `the Remember runs on the default memory model, got ${JSON.stringify(gatewayRequests)}`);
	pass("the pick cleared, the row follows the default and Remember runs there");

	// Approved: the next conversation starts on the room's conversation model.
	const approved = await api(`/api/persistent-agents/${agentId}/checkpoint/approve`, { method: "POST", body: JSON.stringify({ conversationId, density: fallback.body.density, proposal: fallback.body, approvedRecentContext: fallback.body.proposedRecentContext }) });
	assert(approved.status === 200, `the approval goes through on the model that read, got ${approved.status} ${JSON.stringify(approved.body).slice(0, 300)}`);
	const status = await api(`/api/persistent-agents/${agentId}/status`);
	assert(status.body.runtime?.activeThreadId?.startsWith("postcp_") && status.body.runtime?.model?.model === "room-model", `the conversation after Remember starts on the room's conversation model, got ${JSON.stringify(status.body.runtime)}`);
	pass("once approved, the next conversation starts on the room's conversation model");
	try { socket.close(); } catch {}

	console.log("remember model resolver smoke passed");
} catch (error) {
	console.error(serverOutput.join("").slice(-6000));
	throw error;
} finally {
	try { (gateway as any).closeAllConnections?.(); } catch {}
	try { gateway.close(); } catch {}
	await stopSmokeServer(server);
	fs.rmSync(tempRoot, { recursive: true, force: true });
}
