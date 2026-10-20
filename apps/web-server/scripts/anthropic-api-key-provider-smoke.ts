// An Anthropic API key is its own provider beside the Claude sign-in.
//
// Against a real spawned server and one synthetic Anthropic Messages endpoint
// (both providers point there through models.json, so nothing leaves the
// machine and no real key or token exists), with a Claude sign-in already
// stored:
//
// - Add provider lists the key provider as "Claude API key" among the key
//   providers, with no sign-in and no profile of its own, while the sign-in
//   keeps its built-in row; the key provider's models are the Anthropic list,
//   prices included;
// - an Anthropic key or token in the environment never sets the key provider
//   up (it is a key the person enters), and a pasted sign-in token is refused
//   with its plain sentence;
// - saving the key leaves the sign-in exactly as it was, and both are set up
//   at once;
// - approving its models makes its own profile (a custom row, never a
//   built-in one), and a room picks one of them in Room settings, Model;
// - the key room's turn goes out with the key, the sign-in room's with the
//   sign-in, each to the model its room chose;
// - a Memory call on the key asks for the same per-kind cache as on the
//   sign-in: Remember's call goes out with no cache marker;
// - adding and removing the key never changes either room's choice;
// - removing the key leaves the sign-in, and the usage page names the key's
//   turns "Claude API key", apart from the Claude plan.

import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import { fileURLToPath } from "node:url";
import { authedFetch, SMOKE_AUTH_HEADERS, SMOKE_SERVER_AUTH_ENV, SMOKE_SERVER_SPAWN_TREE_OPTIONS, smokeHomeEnv, stopSmokeServer, freePort, type AuthedFetchInit } from "./smoke-server-process.js";

function assert(condition: unknown, message: string): asserts condition {
	if (!condition) throw new Error(message);
}

function pass(label: string): void {
	console.log(`  ok  ${label}`);
}

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const webServerDir = path.resolve(scriptDir, "..");
const repoRoot = path.resolve(webServerDir, "..", "..");
const port = await freePort();
const baseUrl = `http://127.0.0.1:${port}`;

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "exxperts-anthropic-api-key-"));
const tempHome = path.join(tempRoot, "home");
const agentsRoot = path.join(tempHome, ".exxperts", "app", "personalized-agents");
const agentDir = path.join(tempHome, ".exxperts", "agent");
const appDir = path.join(tempHome, ".exxperts", "app");
for (const dir of [agentsRoot, agentDir]) fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
process.env.HOME = tempHome;
process.env.USERPROFILE = tempHome;
process.env.EXXPERTS_CODING_AGENT_DIR = agentDir;
process.env.EXXETA_PERSISTENT_AGENTS_ROOT = agentsRoot;

const KEY_PROVIDER = "anthropic-api-key";
const SYNTHETIC_KEY = "synthetic-anthropic-key";
const SIGN_IN = { type: "oauth", access: "sk-ant-oat01-synthetic-sign-in", refresh: "synthetic-refresh", expires: Date.now() + 365 * 24 * 3600 * 1000 };
const ON_SIGN_IN = { provider: "anthropic", model: "claude-sonnet-5-5" };
const ON_KEY = { provider: KEY_PROVIDER, model: "claude-haiku-5-5" };

// --- The synthetic Anthropic endpoint ----------------------------------------------

type Request = { model: string; apiKey: string | undefined; authorization: string | undefined; raw: string };
const requests: Request[] = [];
// How the endpoint answers the key check at save (GET /v1/models), and the keys it was asked about.
let keyCheck: "ok" | "refused" | "no-workspace" | "down" = "ok";
const keyChecks: Array<string | undefined> = [];
// How the endpoint answers a turn: with text, or with the 400 Anthropic gives a key made outside a workspace.
let turnAnswer: "text" | "no-workspace" | "region" = "text";

function sse(res: http.ServerResponse, event: string, payload: unknown): void {
	res.write(`event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`);
}

const endpoint = http.createServer((req, res) => {
	let raw = "";
	req.on("data", (chunk) => { raw += chunk; });
	req.on("end", () => {
		if (req.method === "GET" && req.url?.startsWith("/v1/models")) {
			keyChecks.push(req.headers["x-api-key"] as string | undefined);
			if (keyCheck === "down") { req.socket.destroy(); return; }
			if (keyCheck === "refused") { res.writeHead(401, { "content-type": "application/json" }); res.end(JSON.stringify({ type: "error", error: { type: "authentication_error", message: "invalid x-api-key" } })); return; }
			if (keyCheck === "no-workspace") { res.writeHead(400, { "content-type": "application/json" }); res.end(JSON.stringify({ type: "error", error: { type: "invalid_request_error", message: "This API key is not scoped to a workspace, so this request must include the anthropic-workspace-id header with the ID of the workspace to use. Add the header, or use an API key that is scoped to a workspace." } })); return; }
			res.writeHead(200, { "content-type": "application/json" });
			res.end(JSON.stringify({ data: [{ type: "model", id: "claude-haiku-5-5" }], has_more: false }));
			return;
		}
		const body = JSON.parse(raw || "{}");
		requests.push({ model: String(body.model), apiKey: req.headers["x-api-key"] as string | undefined, authorization: req.headers.authorization, raw });
		if (turnAnswer === "region") { res.writeHead(403, { "content-type": "application/json" }); res.end(JSON.stringify({ type: "error", error: { type: "permission_error", message: "Country, region, or territory not supported" } })); return; }
		if (turnAnswer === "no-workspace") { res.writeHead(400, { "content-type": "application/json" }); res.end(JSON.stringify({ type: "error", error: { type: "invalid_request_error", message: "This API key is not scoped to a workspace, so this request must include the anthropic-workspace-id header with the ID of the workspace to use. Add the header, or use an API key that is scoped to a workspace." } })); return; }
		res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
		const text = raw.includes("Checkpoint Compression Constitution") ? "TITLE:\nKey\n\nSESSION_ARC:\nA key.\n\nBODY:\n- A key.\n\nPARKED:\nNone\n" : `Answer from ${body.model}.`;
		sse(res, "message_start", { type: "message_start", message: { id: `msg_${requests.length}`, type: "message", role: "assistant", model: body.model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 100, output_tokens: 1 } } });
		sse(res, "content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } });
		sse(res, "content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text } });
		sse(res, "content_block_stop", { type: "content_block_stop", index: 0 });
		sse(res, "message_delta", { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 20 } });
		sse(res, "message_stop", { type: "message_stop" });
		res.end();
	});
});

// --- Helpers -----------------------------------------------------------------------

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

function readAuth(): Record<string, any> {
	return JSON.parse(fs.readFileSync(path.join(agentDir, "auth.json"), "utf-8"));
}

const WebSocketImpl: any = (await import("ws")).default;

async function turnIn(agentId: string, conversationId: string, text: string, frames: any[] = []): Promise<Request> {
	const created = await api(`/api/persistent-agents/${agentId}/threads/${conversationId}`, { method: "PUT", body: JSON.stringify({ state: "active", origin: "home", items: [] }) });
	assert(created.status === 200, `the conversation opens, got ${created.status} ${JSON.stringify(created.body)}`);
	const socket = new WebSocketImpl(`ws://127.0.0.1:${port}/ws?persistentAgentId=${agentId}&conversationId=${conversationId}`, { headers: { ...SMOKE_AUTH_HEADERS } });
	socket.addEventListener("message", (event: { data: unknown }) => { try { frames.push(JSON.parse(String(event.data))); } catch {} });
	await new Promise<void>((resolve, reject) => { socket.addEventListener("open", () => resolve()); socket.addEventListener("error", () => reject(new Error("websocket failed to connect"))); });
	await waitUntil(() => frames.some((frame) => frame.type === "ready"), "ready frame");
	const before = requests.length;
	socket.send(JSON.stringify({ type: "prompt", text }));
	await waitUntil(async () => requests.length > before && (await api(`/api/persistent-agents/${agentId}/status`)).body?.activeThread?.inFlight === false, `the turn "${text}" settled`);
	const answered = frames.some((frame) => JSON.stringify(frame).includes("Answer from"));
	socket.close();
	assert(answered || turnAnswer !== "text", `the room streamed the answer for "${text}"`);
	return requests[requests.length - 1]!;
}

let server: ChildProcessWithoutNullStreams | undefined;
const serverOutput: string[] = [];

try {
	await new Promise<void>((resolve) => endpoint.listen(0, "127.0.0.1", resolve));
	const endpointUrl = `http://127.0.0.1:${(endpoint.address() as AddressInfo).port}`;
	// Both built-in providers keep their models and only answer at the synthetic endpoint.
	fs.writeFileSync(path.join(agentDir, "models.json"), JSON.stringify({ providers: { anthropic: { baseUrl: endpointUrl }, [KEY_PROVIDER]: { baseUrl: endpointUrl } } }, null, 2), { mode: 0o600 });
	fs.writeFileSync(path.join(agentDir, "auth.json"), JSON.stringify({ anthropic: SIGN_IN }, null, 2), { mode: 0o600 });
	fs.writeFileSync(path.join(appDir, "persistent-agent-ai-profile.json"), JSON.stringify({ profileId: "anthropic" }, null, 2), { mode: 0o600 });

	const agents = await import("../src/persistent-agents.js");
	const roomModels = await import("../src/room-models.js");
	const newRoom = (displayName: string) => agents.createPersistentAgentFromScaffoldInput({ displayName, userName: "Synthetic User", preferredUserAddress: "Synthetic User" }).agent.agentId;
	const signInRoom = newRoom("Sign-in Room");
	const keyRoom = newRoom("Key Room");
	roomModels.writeRoomModels(signInRoom, { conversation: ON_SIGN_IN });
	roomModels.writeRoomModels(keyRoom, { conversation: ON_SIGN_IN });

	server = spawn("npx", ["tsx", "src/index.ts"], {
		shell: process.platform === "win32",
		...SMOKE_SERVER_SPAWN_TREE_OPTIONS,
		cwd: webServerDir,
		env: smokeHomeEnv(tempHome, { PORT: String(port), ...SMOKE_SERVER_AUTH_ENV, EXXETA_HOME: repoRoot, EXXPERTS_CODING_AGENT_DIR: agentDir, EXXETA_PERSISTENT_AGENTS_ROOT: agentsRoot, ANTHROPIC_API_KEY: "synthetic-environment-key", ANTHROPIC_OAUTH_TOKEN: "synthetic-environment-token" }) as NodeJS.ProcessEnv,
	});
	server.stdout.on("data", (chunk) => serverOutput.push(String(chunk)));
	server.stderr.on("data", (chunk) => serverOutput.push(String(chunk)));
	await waitUntil(() => fetch(`${baseUrl}/healthz`).then((r) => r.ok).catch(() => false), "server ready");

	const roomChoice = async (agentId: string) => (await api(`/api/persistent-agents/${agentId}/models`)).body?.models?.conversation?.chosen;
	const sameLock = (choice: any, lock: { provider: string; model: string }) => choice?.provider === lock.provider && choice?.model === lock.model;

	// Add provider, before the key.
	let catalog = (await api("/api/auth/providers")).body.providers as any[];
	let keyEntry = catalog.find((entry) => entry.id === KEY_PROVIDER);
	const signInEntry = catalog.find((entry) => entry.id === "anthropic");
	assert(keyEntry && keyEntry.name === "Claude API key", `the key provider is listed as "Claude API key", got ${JSON.stringify(keyEntry)}`);
	assert(JSON.stringify(keyEntry.authTypes) === JSON.stringify(["api_key"]) && keyEntry.profileId === null && keyEntry.configured === false, `it sits among the key providers with no profile of its own (Add provider shows a provider with no sign-in and no profile in its key list), got ${JSON.stringify(keyEntry)}`);
	assert(signInEntry && signInEntry.authTypes.includes("oauth") && signInEntry.configured === true && signInEntry.profileId === "anthropic", `the Claude sign-in keeps its own built-in row, got ${JSON.stringify(signInEntry)}`);
	pass("Add provider lists \"Claude API key\" among the key providers, and the sign-in keeps its built-in row");

	const { getModels } = await import("@exxeta/exxperts-ai");
	const anthropicModels = getModels("anthropic" as any);
	const keyModels = getModels(KEY_PROVIDER as any);
	assert(keyModels.length > 0 && keyModels.length === anthropicModels.length, `the key provider serves the whole Anthropic list, got ${keyModels.length} of ${anthropicModels.length}`);
	for (const model of anthropicModels) {
		const twin = keyModels.find((candidate) => candidate.id === model.id);
		assert(twin && twin.provider === KEY_PROVIDER && twin.api === "anthropic-messages" && JSON.stringify(twin.cost) === JSON.stringify(model.cost) && twin.contextWindow === model.contextWindow, `${model.id} has its twin on the key provider with the same price and window`);
	}
	pass("the key provider's models are the Anthropic list, prices included");

	// The environment never sets the key provider up, and a sign-in token is no key.
	assert(keyEntry.configured === false, "an Anthropic key or token in the environment does not set the key provider up");
	const token = await api("/api/auth/api-key", { method: "POST", body: JSON.stringify({ provider: KEY_PROVIDER, key: "sk-ant-oat01-synthetic-pasted-token" }) });
	assert(token.status === 400 && token.body?.error === "This looks like a Claude sign-in token, not an API key. Create an API key at console.anthropic.com.", `a pasted sign-in token is refused with its sentence, got ${token.status} ${JSON.stringify(token.body)}`);
	assert(!readAuth()[KEY_PROVIDER] && JSON.stringify(readAuth().anthropic) === JSON.stringify(SIGN_IN), "the refused token is stored nowhere");
	pass("the environment never sets the key provider up, and a pasted sign-in token is refused");

	// The key is checked with Anthropic before it is saved.
	const tryKey = async (mode: typeof keyCheck, key: string) => {
		keyCheck = mode;
		const before = keyChecks.length;
		const result = await api("/api/auth/api-key", { method: "POST", body: JSON.stringify({ provider: KEY_PROVIDER, key }) });
		assert(keyChecks.length === before + 1 && keyChecks[before] === key, `the save asks Anthropic once, with the key in its header (${mode})`);
		assert(!JSON.stringify(result.body).includes(key) && !serverOutput.join("").includes(key), `the key is never echoed or logged (${mode})`);
		return result;
	};
	const refused = await tryKey("refused", "synthetic-refused-key");
	assert(refused.status === 400 && refused.body?.error === "Anthropic did not accept this key. Check it at console.anthropic.com." && !readAuth()[KEY_PROVIDER], `a refused key is refused with its words and stored nowhere, got ${refused.status} ${JSON.stringify(refused.body)}`);
	const noWorkspace = await tryKey("no-workspace", "synthetic-no-workspace-key");
	assert(noWorkspace.status === 400 && noWorkspace.body?.error === "This key isn't tied to a workspace. In the Anthropic Console, create a key inside a workspace, then add it here." && !readAuth()[KEY_PROVIDER], `a key outside any workspace is refused with its words and stored nowhere, got ${noWorkspace.status} ${JSON.stringify(noWorkspace.body)}`);
	const unchecked = await tryKey("down", "synthetic-unchecked-key");
	assert(unchecked.status === 200 && unchecked.body?.ok === true && unchecked.body?.notice === "The key is saved. It couldn't be checked with Anthropic just now, so your first message will show whether it works." && readAuth()[KEY_PROVIDER]?.key === "synthetic-unchecked-key", `with Anthropic unreachable the key is saved with a plain notice, got ${unchecked.status} ${JSON.stringify(unchecked.body)}`);
	assert((await api("/api/auth/logout", { method: "POST", body: JSON.stringify({ provider: KEY_PROVIDER }) })).status === 200 && !readAuth()[KEY_PROVIDER], "the unchecked key is removed again");
	keyCheck = "ok";
	pass("a key is checked at save: refused and workspace-less keys are refused in plain words, and an unreachable Anthropic saves it with a notice");

	// Saving the key.
	const saved = await api("/api/auth/api-key", { method: "POST", body: JSON.stringify({ provider: KEY_PROVIDER, key: SYNTHETIC_KEY }) });
	assert(saved.status === 200 && saved.body?.ok === true && !saved.body?.notice && !JSON.stringify(saved.body).includes(SYNTHETIC_KEY), `the key Anthropic accepts saves without a notice and without being echoed, got ${saved.status} ${JSON.stringify(saved.body)}`);
	let auth = readAuth();
	assert(JSON.stringify(auth.anthropic) === JSON.stringify(SIGN_IN), "saving the key leaves the sign-in exactly as it was");
	assert(auth[KEY_PROVIDER]?.type === "api_key" && auth[KEY_PROVIDER]?.key === SYNTHETIC_KEY, "the key is stored under its own provider");
	catalog = (await api("/api/auth/providers")).body.providers as any[];
	assert(catalog.find((entry) => entry.id === KEY_PROVIDER)?.configured === true && catalog.find((entry) => entry.id === "anthropic")?.configured === true, "both are set up at once");
	assert(sameLock(await roomChoice(signInRoom), ON_SIGN_IN) && sameLock(await roomChoice(keyRoom), ON_SIGN_IN), "adding the key changes no room's model");
	pass("saving the key leaves the sign-in, both are set up at once, and no room's model moves");

	// The models it suggests: the sign-in's default, tagged.
	const keyCatalog = (await api(`/api/persistent-agent-ai-profiles/model-catalog?provider=${KEY_PROVIDER}`)).body;
	const signInCatalog = (await api("/api/persistent-agent-ai-profiles/model-catalog?provider=anthropic")).body;
	assert(keyCatalog?.suggested === signInCatalog?.suggested && keyCatalog?.suggested === "claude-opus-5-5" && keyCatalog.models.filter((model: any) => model.suggestedDefault).map((model: any) => model.id).join() === "claude-opus-5-5", `the key suggests the sign-in's default, got ${keyCatalog?.suggested} against ${signInCatalog?.suggested}`);
	pass("the key suggests the sign-in's default model, Opus 5.5, with its tag");

	// Approve models: its own profile, a custom row.
	const approved = await api("/api/persistent-agent-ai-profiles/custom", { method: "PUT", body: JSON.stringify({ providerId: KEY_PROVIDER, label: "Claude API key", roomModels: ["claude-haiku-5-5", "claude-sonnet-5-5"], learnModel: "claude-haiku-5-5" }) });
	assert(approved.status === 200, `approving the key provider's models makes its profile, got ${approved.status} ${JSON.stringify(approved.body)}`);
	const profiles = (await api("/api/persistent-agent-ai-profile")).body.profiles as any[];
	const keyProfile = profiles.find((profile) => profile.provider?.id === KEY_PROVIDER);
	assert(keyProfile && keyProfile.kind === "custom" && keyProfile.ready === true, `the key's profile is a ready custom row, got ${JSON.stringify(keyProfile && { kind: keyProfile.kind, ready: keyProfile.ready, issues: keyProfile.issues })}`);
	assert(profiles.filter((profile) => profile.kind === "builtin").every((profile) => profile.provider?.id !== KEY_PROVIDER), "no built-in row is the key provider");
	assert(profiles.some((profile) => profile.id === "anthropic" && profile.kind === "builtin" && profile.provider?.configured === true), "the Claude sign-in's built-in row stays set up");
	catalog = (await api("/api/auth/providers")).body.providers as any[];
	assert(catalog.find((entry) => entry.id === KEY_PROVIDER)?.profileId === keyProfile.id, "once approved the key provider has its own row, so Add provider no longer offers it");
	pass("approving its models makes its own custom row beside the sign-in's built-in row");

	// A room picks a key model in Room settings, Model.
	const picked = await api(`/api/persistent-agents/${keyRoom}/models`, { method: "PUT", body: JSON.stringify({ conversation: ON_KEY }) });
	assert(picked.status === 200 && sameLock(picked.body?.models?.conversation?.chosen, ON_KEY), `the key room picks ${ON_KEY.model} on the key, got ${picked.status} ${JSON.stringify(picked.body)}`);
	assert(sameLock(await roomChoice(signInRoom), ON_SIGN_IN), "the other room keeps its sign-in model");

	const keyTurn = await turnIn(keyRoom, "c_key_0001", "A question on the key.");
	assert(keyTurn.model === ON_KEY.model && keyTurn.apiKey === SYNTHETIC_KEY && !keyTurn.authorization, `the key room's turn goes out with the key, got model ${keyTurn.model}, key ${keyTurn.apiKey ? "set" : "unset"}, bearer ${keyTurn.authorization ? "set" : "unset"}`);
	const signInTurn = await turnIn(signInRoom, "c_sign_in_0001", "A question on the sign-in.");
	assert(signInTurn.model === ON_SIGN_IN.model && !signInTurn.apiKey && signInTurn.authorization === `Bearer ${SIGN_IN.access}`, `the sign-in room's turn goes out with the sign-in, got model ${signInTurn.model}, key ${signInTurn.apiKey ? "set" : "unset"}`);
	pass("each room answers through what it chose: the key room with the key, the sign-in room with the sign-in");

	// Remember on the key: the Memory model call keeps its kind's cache setting ("none").
	const memoryPick = await api(`/api/persistent-agents/${keyRoom}/models`, { method: "PUT", body: JSON.stringify({ memory: ON_KEY }) });
	assert(memoryPick.status === 200 && sameLock(memoryPick.body?.models?.memory?.chosen, ON_KEY), `the key room's Memory model is a key model, got ${memoryPick.status} ${JSON.stringify(memoryPick.body?.models?.memory)}`);
	const rememberBefore = requests.length;
	const proposed = authedFetch(`${baseUrl}/api/persistent-agents/${keyRoom}/checkpoint/propose`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ conversationId: "c_key_0001", density: "standard" }) }).catch(() => null);
	await waitUntil(() => requests.slice(rememberBefore).some((request) => request.raw.includes("Checkpoint Compression Constitution")), "the Remember call reaches the endpoint");
	const rememberCall = requests.slice(rememberBefore).find((request) => request.raw.includes("Checkpoint Compression Constitution"))!;
	assert(rememberCall.apiKey === SYNTHETIC_KEY && rememberCall.model === ON_KEY.model, "Remember runs on the key");
	assert(keyTurn.raw.includes("cache_control"), "a conversation turn on the key keeps the prompt cache (the contrast that makes the next check mean something)");
	assert(!rememberCall.raw.includes("cache_control"), "Remember's call on the key asks for no prompt cache, as on the sign-in");
	await proposed;
	await api(`/api/persistent-agents/${keyRoom}/checkpoint/cancel`, { method: "POST", body: JSON.stringify({ conversationId: "c_key_0001" }) });
	pass("a Memory call on the key keeps its kind's cache setting: Remember asks for no prompt cache");

	// A turn refused because the key is outside a workspace says so on its failing frame.
	turnAnswer = "no-workspace";
	const failedFrames: any[] = [];
	await turnIn(keyRoom, "c_key_0002", "A question on a key outside a workspace.", failedFrames);
	turnAnswer = "text";
	const failedEnd = failedFrames.find((frame) => frame.type === "event" && frame.event?.type === "message_end" && frame.event.message?.stopReason === "error");
	assert(failedEnd?.event?.credentialKey === "no-workspace", `the failing frame carries the key's state, got ${JSON.stringify(failedEnd?.event?.credentialKey)}`);
	pass("a turn refused for a key outside a workspace carries the key's state on its failing frame");

	// A 403 that is no credential failure (a region the provider does not serve) carries no key state, so the room keeps its error line.
	turnAnswer = "region";
	const regionFrames: any[] = [];
	await turnIn(keyRoom, "c_key_0003", "A question from a region Anthropic does not serve.", regionFrames);
	turnAnswer = "text";
	const regionEnd = regionFrames.find((frame) => frame.type === "event" && frame.event?.type === "message_end" && frame.event.message?.stopReason === "error");
	assert(regionEnd && regionEnd.event.credentialKey === undefined, `a 403 permission error carries no key state, got ${JSON.stringify(regionEnd?.event?.credentialKey)}`);
	pass("a 403 permission error carries no key state");

	// Usage names the key's turns apart from the Claude plan.
	const usageRows = fs.readFileSync(path.join(appDir, "usage.jsonl"), "utf-8").trim().split("\n").map((line) => JSON.parse(line));
	const keyRow = usageRows.find((row) => row.provider === KEY_PROVIDER);
	const planRow = usageRows.find((row) => row.provider === "anthropic");
	assert(keyRow && keyRow.authType === "api_key" && planRow && planRow.authType === "oauth", `the ledger tells the key's turn from the plan's, got ${JSON.stringify(usageRows.map((row) => [row.provider, row.authType]))}`);
	const usage = (await api("/api/usage")).body;
	const usageText = JSON.stringify(usage);
	assert(usageText.includes("Claude API key"), "the usage page names the key's turns \"Claude API key\"");
	pass("the usage ledger and page keep the key's turns apart from the Claude plan");

	// Removing the key. A room left open on it names the key as missing when the
	// next message fails, not as refused.
	const openFrames: any[] = [];
	await api(`/api/persistent-agents/${keyRoom}/threads/c_key_0004`, { method: "PUT", body: JSON.stringify({ state: "active", origin: "home", items: [] }) });
	const openSocket = new WebSocketImpl(`ws://127.0.0.1:${port}/ws?persistentAgentId=${keyRoom}&conversationId=c_key_0004`, { headers: { ...SMOKE_AUTH_HEADERS } });
	openSocket.addEventListener("message", (event: { data: unknown }) => { try { openFrames.push(JSON.parse(String(event.data))); } catch {} });
	await waitUntil(() => openFrames.some((frame) => frame.type === "ready"), "the open room's ready frame");
	const removed = await api("/api/auth/logout", { method: "POST", body: JSON.stringify({ provider: KEY_PROVIDER }) });
	assert(removed.status === 200, `the key is removed, got ${removed.status}`);
	openSocket.send(JSON.stringify({ type: "prompt", text: "A question after the key was removed." }));
	await waitUntil(() => openFrames.some((frame) => frame.type === "error" || (frame.type === "event" && frame.event?.message?.stopReason === "error")), "the open room's turn fails");
	openSocket.close();
	const missingFrame = openFrames.find((frame) => frame.type === "error" && /No API key found for/.test(String(frame.message)));
	assert(missingFrame?.credentialKey === "missing", `the failing turn's error frame names the key as missing, got ${JSON.stringify(openFrames.filter((frame) => frame.type === "error" || frame.event?.message?.stopReason === "error"))}`);
	pass("a room left open on a removed key names the key as missing when the next message fails");
	auth = readAuth();
	assert(!auth[KEY_PROVIDER] && JSON.stringify(auth.anthropic) === JSON.stringify(SIGN_IN), "removing the key leaves the sign-in exactly as it was");
	assert(sameLock(await roomChoice(keyRoom), ON_KEY) && sameLock(await roomChoice(signInRoom), ON_SIGN_IN), "removing the key changes no room's model: the key room keeps its key model and the sign-in room its sign-in model");
	catalog = (await api("/api/auth/providers")).body.providers as any[];
	assert(catalog.find((entry) => entry.id === "anthropic")?.configured === true && catalog.find((entry) => entry.id === KEY_PROVIDER)?.configured === false, "the sign-in stays set up and the key provider is not");
	pass("removing the key leaves the sign-in and every room's choice");

	// The key room's rows say the key is gone, not that it is signed out.
	const keyRows = (await api(`/api/persistent-agents/${keyRoom}/models`)).body?.models;
	const keyModelRow = keyRows?.conversation;
	assert(keyModelRow?.effective === null && keyModelRow?.reason === "signed-out" && keyModelRow?.keyGone === true, `the key room waits on its key, got ${JSON.stringify(keyModelRow && { effective: keyModelRow.effective, reason: keyModelRow.reason, keyGone: keyModelRow.keyGone })}`);
	assert(/^This room's model, Claude [^,]+, has no Claude API key saved\. Add the key again in Settings, AI setup, or choose another model in Room settings, Model\.$/.test(keyModelRow.refusal ?? ""), `the row's sentence says the key is gone and the way back, got ${JSON.stringify(keyModelRow.refusal)}`);
	assert(/^This room's memory model, Claude [^,]+, has no Claude API key saved\. Add the key again in Settings, AI setup, or choose another model in Room settings, Model\.$/.test(keyRows?.memory?.refusal ?? ""), `the memory row says the same, got ${JSON.stringify(keyRows?.memory?.refusal)}`);
	const signInModelRow = (await api(`/api/persistent-agents/${signInRoom}/models`)).body?.models?.conversation;
	assert(signInModelRow?.effective && !signInModelRow.reason && !signInModelRow.keyGone && !signInModelRow.refusal, `the sign-in room runs as before, got ${JSON.stringify(signInModelRow && { reason: signInModelRow.reason, refusal: signInModelRow.refusal })}`);
	pass("after the key is removed its room's rows say the key is gone and how to add it again; the sign-in room runs");

	// Every key-based connection reads the same way once its key is removed: an
	// OpenAI key and a gateway, each on a room of its own.
	const keyGoneLine = (label: string) => new RegExp(`^This room's model, .+ on ${label}, has no key saved\\. Add the key again in Settings, AI setup, or choose another model in Room settings, Model\\.$`);
	const rowAfterRemoval = async (roomName: string, lock: { provider: string; model: string }) => {
		const room = newRoom(roomName);
		const chosen = await api(`/api/persistent-agents/${room}/models`, { method: "PUT", body: JSON.stringify({ conversation: lock }) });
		assert(chosen.status === 200 && sameLock(chosen.body?.models?.conversation?.effective, lock), `${roomName} runs on ${lock.provider} before the removal, got ${chosen.status} ${JSON.stringify(chosen.body?.models?.conversation)}`);
		const gone = await api("/api/auth/logout", { method: "POST", body: JSON.stringify({ provider: lock.provider }) });
		assert(gone.status === 200 && !readAuth()[lock.provider], `${lock.provider}'s key is removed, got ${gone.status}`);
		return (await api(`/api/persistent-agents/${room}/models`)).body?.models?.conversation;
	};
	const { getModels: openAiModels } = await import("@exxeta/exxperts-ai");
	const openAiIds = openAiModels("openai" as any).map((model) => model.id).slice(0, 2);
	assert((await api("/api/auth/api-key", { method: "POST", body: JSON.stringify({ provider: "openai", key: "synthetic-openai-key" }) })).status === 200, "an OpenAI key saves");
	assert((await api("/api/persistent-agent-ai-profiles/custom", { method: "PUT", body: JSON.stringify({ providerId: "openai", label: "OpenAI", roomModels: openAiIds, learnModel: openAiIds[0] }) })).status === 200, "approving OpenAI's models makes its row");
	const openAiRow = await rowAfterRemoval("OpenAI Room", { provider: "openai", model: openAiIds[0] });
	assert(openAiRow?.keyGone === true && keyGoneLine("OpenAI").test(openAiRow.refusal ?? ""), `the OpenAI room's row says the key is gone, got ${JSON.stringify(openAiRow?.refusal)}`);
	const gateway = await api("/api/persistent-agent-ai-profiles/gateways", { method: "POST", body: JSON.stringify({ label: "Synthetic gateway", baseUrl: endpointUrl, key: "synthetic-gateway-key", roomModels: [{ modelId: "gateway-model", vision: false, webSearch: false, reasoning: false, contextWindow: 200000 }], maintenanceModel: "gateway-model" }) });
	assert(gateway.status === 200 && gateway.body?.gateway?.providerId, `a gateway saves, got ${gateway.status} ${JSON.stringify(gateway.body)}`);
	const gatewayRow = await rowAfterRemoval("Gateway Room", { provider: gateway.body.gateway.providerId, model: "gateway-model" });
	assert(gatewayRow?.keyGone === true && keyGoneLine("Synthetic gateway").test(gatewayRow.refusal ?? ""), `the gateway room's row says the key is gone, got ${JSON.stringify(gatewayRow?.refusal)}`);
	pass("an OpenAI key and a gateway read the same once their key is removed: no key saved, add the key again");

	// A sign-in keeps its own words: signed out, sign in again. ChatGPT's, as
	// the environment here holds an Anthropic key that keeps Claude ready.
	fs.writeFileSync(path.join(agentDir, "auth.json"), JSON.stringify({ ...readAuth(), "openai-codex": { type: "oauth", access: "synthetic-codex-access", refresh: "synthetic-codex-refresh", expires: Date.now() + 365 * 24 * 3600 * 1000, accountId: "synthetic-account" } }, null, 2), { mode: 0o600 });
	const signInGoneRow = await rowAfterRemoval("Sign-out Room", { provider: "openai-codex", model: "gpt-6.1-sol" });
	assert(!signInGoneRow?.keyGone && /^This room's model, .+, is signed out\. Sign in again in Settings, AI setup, or choose another model in Room settings, Model\.$/.test(signInGoneRow?.refusal ?? ""), `the ChatGPT sign-in's room says it is signed out, got ${JSON.stringify(signInGoneRow?.refusal)}`);
	pass("a signed-out ChatGPT sign-in still says signed out and sign in again");

	// A refused key names the service, never the row: "Anthropic did not accept the saved key".
	const { providerAccountName } = await import("../src/model-not-on-account.js");
	const { credentialGoneWords } = await import("../src/model-not-offered.js");
	const refusedWords = credentialGoneWords("key-refused");
	assert(`${providerAccountName(KEY_PROVIDER)} ${refusedWords.state}. ${refusedWords.again} to continue this conversation.` === "Anthropic did not accept the saved key. Replace the key to continue this conversation." && refusedWords.button === "Replace key", "the refused key's notice names Anthropic and offers Replace key");
	pass("a refused Claude key names Anthropic, with Replace key");

	console.log("anthropic api key provider smoke passed");
} catch (error) {
	console.error(serverOutput.join("").slice(-6000));
	throw error;
} finally {
	await stopSmokeServer(server);
	endpoint.close();
	fs.rmSync(tempRoot, { recursive: true, force: true });
}
