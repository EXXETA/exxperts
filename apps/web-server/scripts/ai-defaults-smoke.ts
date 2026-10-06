// The defaults for new rooms and a room's own model rows, over HTTP.
//
// Against a real spawned server with Claude and a synthetic gateway signed in:
// the start writes the defaults from the saved profile; GET and PUT
// /api/ai/defaults read and set them and refuse a model that cannot run; a
// room's rows (GET/PUT /api/persistent-agents/:id/models) inherit, set, refuse
// and clear, and the room listing and status carry them; the model status
// lists every provider with its conversation and memory models; a room whose
// model cannot run refuses a new conversation and its memory work with the
// sentence that names the model and the way out, and nothing runs in its
// place; and the defaults survive the two things that rewrite the file they
// live in, a profile switch and the delete of the gateway the saved profile
// named.

import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { authedFetch, SMOKE_SERVER_AUTH_ENV, SMOKE_SERVER_SPAWN_TREE_OPTIONS, smokeHomeEnv, stopSmokeServer, type AuthedFetchInit } from "./smoke-server-process.js";

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

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "exxperts-ai-defaults-"));
const tempHome = path.join(tempRoot, "home");
const agentsRoot = path.join(tempHome, ".exxperts", "app", "personalized-agents");
const agentDir = path.join(tempHome, ".exxperts", "agent");
const appDir = path.join(tempHome, ".exxperts", "app");
fs.mkdirSync(agentsRoot, { recursive: true, mode: 0o700 });
fs.mkdirSync(agentDir, { recursive: true, mode: 0o700 });

fs.writeFileSync(path.join(agentDir, "models.json"), JSON.stringify({
	providers: {
		"openai-compatible": {
			name: "Synthetic Gateway",
			baseUrl: "http://127.0.0.1:9/v1",
			api: "openai-completions",
			models: [
				{ id: "room-model", name: "Room Model", contextWindow: 128000, maxTokens: 16384 },
				{ id: "maint-model", name: "Maintenance Model", contextWindow: 200000, maxTokens: 32000 },
			],
		},
	},
}, null, 2), { mode: 0o600 });
fs.writeFileSync(path.join(agentDir, "auth.json"), JSON.stringify({
	"openai-compatible": { type: "api_key", key: "synthetic-ai-defaults-key" },
	anthropic: { type: "api_key", key: "synthetic-anthropic-key" },
}, null, 2), { mode: 0o600 });
fs.writeFileSync(path.join(appDir, "openai-compatible-ai-profile.json"), JSON.stringify({
	profileId: "openai-compatible",
	providerId: "openai-compatible",
	label: "Synthetic Gateway",
	roomModels: [{ modelId: "room-model", label: "Room Model" }],
	maintenanceModel: "maint-model",
}, null, 2), { mode: 0o600 });
const stateFile = path.join(appDir, "persistent-agent-ai-profile.json");
fs.writeFileSync(stateFile, JSON.stringify({ profileId: "openai-compatible" }, null, 2), { mode: 0o600 });

async function api(pathname: string, init: AuthedFetchInit = {}): Promise<{ status: number; body: any }> {
	const response = await authedFetch(`${baseUrl}${pathname}`, { ...init, headers: { ...(init.body ? { "content-type": "application/json" } : {}), ...init.headers } });
	const text = await response.text();
	return { status: response.status, body: text ? JSON.parse(text) : null };
}

const key = (lock: { provider: string; model: string } | null | undefined) => (lock ? `${lock.provider}/${lock.model}` : "none");

let server: ChildProcessWithoutNullStreams | undefined;
const serverOutput: string[] = [];
try {
	server = spawn("npx", ["tsx", "src/index.ts"], {
		shell: process.platform === "win32",
		...SMOKE_SERVER_SPAWN_TREE_OPTIONS,
		cwd: webServerDir,
		env: smokeHomeEnv(tempHome, { PORT: String(port), ...SMOKE_SERVER_AUTH_ENV, EXXETA_HOME: repoRoot, EXXPERTS_CODING_AGENT_DIR: agentDir, EXXETA_PERSISTENT_AGENTS_ROOT: agentsRoot }) as NodeJS.ProcessEnv,
	});
	server.stdout.on("data", (chunk) => serverOutput.push(String(chunk)));
	server.stderr.on("data", (chunk) => serverOutput.push(String(chunk)));
	const deadline = Date.now() + 20_000;
	while (!(await fetch(`${baseUrl}/healthz`).then((r) => r.ok).catch(() => false))) {
		assert(server.exitCode == null, `server exited before startup with code ${server.exitCode}`);
		assert(Date.now() < deadline, "server did not become ready");
		await new Promise((resolve) => setTimeout(resolve, 150));
	}

	// --- The defaults ----------------------------------------------------------------
	const written = JSON.parse(fs.readFileSync(stateFile, "utf-8"));
	assert(written.profileId === "openai-compatible" && key(written.defaults?.conversation) === "openai-compatible/room-model" && key(written.defaults?.memory) === "openai-compatible/maint-model", `the start writes the defaults from the saved profile and keeps the pointer, got ${JSON.stringify(written)}`);
	let defaults = await api("/api/ai/defaults");
	assert(defaults.status === 200 && key(defaults.body.defaults.conversation.effective) === "openai-compatible/room-model" && defaults.body.defaults.memory.source === "default", `GET /api/ai/defaults reads them, got ${JSON.stringify(defaults.body)}`);
	assert(defaults.body.defaults.memory.effective.providerLabel && defaults.body.defaults.memory.effective.label, "each row carries the names a person reads");
	pass("the start writes the defaults from the saved profile, and GET /api/ai/defaults reads them with their names");

	defaults = await api("/api/ai/defaults", { method: "PUT", body: JSON.stringify({ memory: { provider: "anthropic", model: "claude-opus-5-5" } }) });
	assert(defaults.status === 200 && key(defaults.body.defaults.memory.effective) === "anthropic/claude-opus-5-5" && key(defaults.body.defaults.conversation.effective) === "openai-compatible/room-model", `PUT sets one row and keeps the other, got ${JSON.stringify(defaults.body)}`);
	const madeUp = await api("/api/ai/defaults", { method: "PUT", body: JSON.stringify({ conversation: { provider: "anthropic", model: "claude-made-up-9" } }) });
	assert(madeUp.status === 400 && /is not offered for rooms by/.test(madeUp.body.error), `a model no list offers is refused, got ${madeUp.status} ${JSON.stringify(madeUp.body)}`);
	const signedOut = await api("/api/ai/defaults", { method: "PUT", body: JSON.stringify({ conversation: { provider: "openai-codex", model: "gpt-6-sol" } }) });
	assert(signedOut.status === 400 && /is signed out/.test(signedOut.body.error), `a model whose provider is signed out is refused, got ${signedOut.status} ${JSON.stringify(signedOut.body)}`);
	const emptied = await api("/api/ai/defaults", { method: "PUT", body: JSON.stringify({ conversation: null }) });
	assert(emptied.status === 400, "a default cannot be emptied");
	assert(key((await api("/api/ai/defaults")).body.defaults.conversation.effective) === "openai-compatible/room-model", "a refused PUT changes nothing");
	pass("PUT /api/ai/defaults sets a row, and refuses a model no list offers, a signed-out provider, and an empty row");

	// --- A room's rows ------------------------------------------------------------------
	const room = await api("/api/persistent-agents", { method: "POST", body: JSON.stringify({ displayName: "Defaults Room", userName: "Synthetic User", preferredUserAddress: "Synthetic User" }) });
	const agentId = String(room.body?.agent?.id ?? "");
	let rows = await api(`/api/persistent-agents/${agentId}/models`);
	assert(rows.status === 200 && rows.body.models.conversation.stored === null && key(rows.body.models.conversation.effective) === "openai-compatible/room-model" && key(rows.body.models.memory.effective) === "anthropic/claude-opus-5-5", `a new room inherits both defaults, got ${JSON.stringify(rows.body)}`);
	rows = await api(`/api/persistent-agents/${agentId}/models`, { method: "PUT", body: JSON.stringify({ conversation: { provider: "anthropic", model: "claude-sonnet-5" }, memory: { provider: "openai-compatible", model: "maint-model" } }) });
	assert(rows.status === 200 && rows.body.models.conversation.source === "room" && key(rows.body.models.memory.stored) === "openai-compatible/maint-model", `PUT sets the room's rows, the gateway's Memorize model on the memory row included, got ${JSON.stringify(rows.body)}`);
	const notARoomModel = await api(`/api/persistent-agents/${agentId}/models`, { method: "PUT", body: JSON.stringify({ conversation: { provider: "openai-compatible", model: "maint-model" } }) });
	assert(notARoomModel.status === 400, "the gateway's Memorize model is not a room model");
	assert(key((await api(`/api/persistent-agents/${agentId}/models`)).body.models.conversation.stored) === "anthropic/claude-sonnet-5", "a refused PUT keeps the room's pick");
	const listing = await api("/api/persistent-agents");
	const listed = (listing.body as any[]).find((row) => row.id === agentId);
	assert(key(listed?.models?.conversation?.effective) === "anthropic/claude-sonnet-5" && !("preferredModel" in listed), `the room listing carries the rows and no preferred model, got ${JSON.stringify(listed?.models)}`);
	const status = await api(`/api/persistent-agents/${agentId}/status`);
	assert(key(status.body.models?.memory?.effective) === "openai-compatible/maint-model", "the room status carries the rows");
	const gone = await api(`/api/persistent-agents/${agentId}/preferred-model`);
	assert(gone.status === 404, `the preferred-model endpoint is gone, got ${gone.status}`);
	pass("a room inherits, sets and refuses its rows, and its listing and status carry them in place of the preferred model");

	// --- The pickers' lists ---------------------------------------------------------------
	const modelStatus = await api("/api/persistent-agent-room/model-status");
	const providers = modelStatus.body.providers as any[];
	const gateway = providers.find((provider) => provider.id === "openai-compatible");
	const claude = providers.find((provider) => provider.id === "anthropic");
	const chatgpt = providers.find((provider) => provider.id === "openai-codex");
	assert(gateway?.ready && claude?.ready && chatgpt && !chatgpt.ready, `the model status lists every provider with whether it is ready, got ${JSON.stringify(providers.map((provider) => [provider.id, provider.ready]))}`);
	assert(gateway.conversation.map((option: any) => option.model).join() === "room-model" && gateway.memory.some((option: any) => option.model === "maint-model"), "the gateway offers its room model to rooms and its Memorize model to memory work");
	assert(claude.conversation[0].model === "claude-opus-5-5" && claude.conversation[0].recommended === true && claude.memory.find((option: any) => option.recommended)?.model === "claude-opus-5-5", "each list marks its provider's recommended model");
	pass("the model status lists every provider, ready or not, with its conversation and memory models and their recommended ones");

	// --- The defaults survive a profile switch and a gateway delete ------------------------------
	const switched = await api("/api/persistent-agent-ai-profile", { method: "PUT", body: JSON.stringify({ profileId: "anthropic" }) });
	assert(switched.status === 200, `the profile switch works, got ${switched.status}`);
	let file = JSON.parse(fs.readFileSync(stateFile, "utf-8"));
	assert(file.profileId === "anthropic" && key(file.defaults?.memory) === "anthropic/claude-opus-5-5" && key(file.defaults?.conversation) === "openai-compatible/room-model", `a profile switch keeps the defaults, got ${JSON.stringify(file)}`);
	await api("/api/persistent-agent-ai-profile", { method: "PUT", body: JSON.stringify({ profileId: "openai-compatible" }) });
	const deleted = await api("/api/persistent-agent-ai-profiles/openai-compatible", { method: "DELETE" });
	assert(deleted.status === 200, `the gateway delete works, got ${deleted.status} ${JSON.stringify(deleted.body).slice(0, 200)}`);
	file = JSON.parse(fs.readFileSync(stateFile, "utf-8"));
	assert(!file.profileId && key(file.defaults?.memory) === "anthropic/claude-opus-5-5" && key(file.defaults?.conversation) === "openai-compatible/room-model", `deleting the gateway the pointer named drops the pointer and keeps the defaults, got ${JSON.stringify(file)}`);
	rows = await api(`/api/persistent-agents/${agentId}/models`);
	assert(key(rows.body.models.memory.stored) === "openai-compatible/maint-model" && rows.body.models.memory.reason === "not-offered" && rows.body.models.memory.effective === null && /^This room's memory model, .+, is no longer offered\. Choose another model in Room settings, Model\.$/.test(rows.body.models.memory.refusal), `a pick on the deleted gateway is kept, nothing runs in its place, and the row carries the refusal, got ${JSON.stringify(rows.body.models.memory)}`);
	const memoryWork = await api(`/api/persistent-agents/${agentId}/checkpoint/estimate`);
	assert(memoryWork.status === 409 && memoryWork.body.code === "room_model_unavailable" && memoryWork.body.error === rows.body.models.memory.refusal, `Remember refuses on a memory model no longer offered, with the row's sentence, got ${memoryWork.status} ${JSON.stringify(memoryWork.body)}`);
	defaults = await api("/api/ai/defaults");
	assert(defaults.body.defaults.conversation.reason === "not-offered" && defaults.body.defaults.conversation.effective === null && defaults.body.defaults.conversation.source === "default" && /^The default model, .+, is no longer offered\. Choose another default in Settings, AI setup\.$/.test(defaults.body.defaults.conversation.refusal), `a default on the deleted gateway is not replaced and says why, got ${JSON.stringify(defaults.body.defaults.conversation)}`);
	pass("the defaults survive a profile switch and the delete of the gateway the pointer named, and picks on that gateway wait with the reason instead of falling back");

	// --- A room whose pick is signed out refuses, end to end ---------------------------------
	// ChatGPT is known to AI setup but signed out. A pick on it (written as an
	// older sign-in left it; PUT refuses to set one) stops the room: a new
	// conversation is refused with the sentence, and no other model is used.
	fs.writeFileSync(path.join(agentsRoot, agentId, "runtime", "models.json"), JSON.stringify({ schemaVersion: 1, conversation: { provider: "openai-codex", model: "gpt-6-sol" }, updatedAt: new Date().toISOString() }, null, 2));
	rows = await api(`/api/persistent-agents/${agentId}/models`);
	const expected = "This room's model, GPT-6 Sol on ChatGPT Plus/Pro, is signed out. Sign in again in Settings, AI setup, or choose another model in Room settings, Model.";
	assert(rows.body.models.conversation.effective === null && rows.body.models.conversation.reason === "signed-out" && rows.body.models.conversation.refusal === expected, `the row names the signed-out pick and the way out, got ${JSON.stringify(rows.body.models.conversation)}`);
	const threadId = "t-no-fallback";
	const opened = await api(`/api/persistent-agents/${agentId}/threads/${threadId}`, { method: "PUT", body: JSON.stringify({ state: "active", origin: "launcher", items: [] }) });
	assert(opened.status === 409 && opened.body.code === "provider_signed_out" && opened.body.error === expected, `a new conversation is refused with the sentence, got ${opened.status} ${JSON.stringify(opened.body)}`);
	assert(!fs.existsSync(path.join(agentsRoot, agentId, "runtime", "threads", `${threadId}.json`)) && (await api(`/api/persistent-agents/${agentId}/status`)).body.runtime?.activeThreadId !== threadId, "and no conversation was written on another model");
	pass("a room whose pick is signed out cannot start a conversation, and says which model, which provider, and the way out");

	console.log("ai defaults smoke passed");
} catch (error) {
	console.error(serverOutput.join("").slice(-6000));
	throw error;
} finally {
	await stopSmokeServer(server);
	fs.rmSync(tempRoot, { recursive: true, force: true });
}
