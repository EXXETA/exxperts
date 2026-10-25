// A key the service refused is not "ready" in AI setup.
//
// Against a real spawned server and one synthetic endpoint that speaks both
// Anthropic Messages and OpenAI chat completions (nothing leaves the machine,
// no real key exists), with the Claude API key saved and its models approved:
//
// - after a turn the service refused for its key (a 401), AI setup's row for
//   the key says "not accepted at the last try" and offers Replace key; the
//   profile's message and issue give the full sentence;
// - the next turn the service answers clears it;
// - a Memory model call refused for its key says the same;
// - saving the key again clears it before any call, and a refusal from a call
//   that started before that save does not mark the new key;
// - a key made outside a workspace names that cause;
// - a gateway's key refused is cleared by a new key saved through the gateway
//   route, and a gateway deleted and made again starts clear;
// - the profile status never carries the provider's own text, which can hold
//   part of the key: every person on a shared server reads it;
// - AI setup left open through a restart, which ends the record with the
//   process, reads the profile again once the page reconnects: the row stops
//   saying the key was refused;
// - on a shared server, where only the admin can replace the key, the
//   sentence sends the person to their admin;
// - a Claude sign-in left untouched reads signed in; once a turn finds it gone
//   (its expired token's refresh refused), its row reads signed out and offers
//   Sign in; a new sign-in clears it, and a Memory model call that finds it
//   gone marks it too. The made-up sign-in's token requests go to the same
//   local endpoint (oauth-token-preload.mjs).
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import { fileURLToPath, pathToFileURL } from "node:url";
import { chromium, type Page } from "playwright";
import { authedFetch, SMOKE_AUTH_HEADERS, SMOKE_AUTH_TOKEN, SMOKE_SERVER_AUTH_ENV, SMOKE_SERVER_SPAWN_TREE_OPTIONS, smokeHomeEnv, stopSmokeServer, freePort, type AuthedFetchInit } from "./smoke-server-process.js";

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

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "exxperts-key-refused-setup-"));
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
const PROFILE_ID = "custom-anthropic-api-key";
const GATEWAY_ID = "openai-compatible";
const ON_KEY = { provider: KEY_PROVIDER, model: "claude-haiku-5-5" };
const ON_GATEWAY = { provider: GATEWAY_ID, model: "gateway-model" };
const SIGN_IN_PROVIDER = "anthropic";
const ON_SIGN_IN = { provider: SIGN_IN_PROVIDER, model: "claude-haiku-5-5" };
const SIGN_IN_SENTENCE = "Signed out at the last try. Sign in again to continue.";
// Anthropic's own callback port for its sign-in: the runtime fixes it.
const SIGN_IN_CALLBACK = "http://127.0.0.1:53692/callback";
const SENTENCE = "Not accepted at the last try. Replace the key to continue.";
const WORKSPACE_SENTENCE = "Not accepted at the last try: this key isn't tied to a workspace. Replace the key to continue.";
const ROW_LINE = "not accepted at the last try";
const WORKSPACE_ROW_LINE = "not accepted at the last try: key isn't tied to a workspace";
// What a provider's refusal says, key fragments included: none of it may reach the profile status.
const ANTHROPIC_REFUSAL = "invalid x-api-key";
const OPENAI_REFUSAL = "Incorrect API key provided: sk-proj-****************************wxyz. You can find your API key at https://platform.openai.com/account/api-keys.";
const PROVIDER_WORDS = [ANTHROPIC_REFUSAL, "sk-proj", "wxyz", "Incorrect API key", "x-api-key", "workspace-id"];

const requests: Array<{ raw: string }> = [];
let refuse: false | "key" | "workspace" = false;
// The made-up sign-in's token requests, and whether a refresh is refused.
let tokenCalls = 0;
let refuseRefresh = true;
const calls = () => requests.length + tokenCalls;
// How long a refusal is held back, for a call that is still out when a new key is saved.
let holdMs = 0;

function sse(res: http.ServerResponse, event: string | null, payload: unknown): void {
	res.write(`${event ? `event: ${event}\n` : ""}data: ${JSON.stringify(payload)}\n\n`);
}

const endpoint = http.createServer((req, res) => {
	let raw = "";
	req.on("data", (chunk) => { raw += chunk; });
	req.on("end", () => {
		if (req.method === "GET" && req.url?.includes("/models")) {
			res.writeHead(200, { "content-type": "application/json" });
			res.end(JSON.stringify({ object: "list", data: [{ type: "model", object: "model", id: ON_KEY.model }, { object: "model", id: ON_GATEWAY.model }], has_more: false }));
			return;
		}
		if (req.url?.includes("/oauth/token")) {
			tokenCalls += 1;
			const grant = JSON.parse(raw || "{}").grant_type;
			if (grant === "refresh_token" && refuseRefresh) {
				res.writeHead(400, { "content-type": "application/json" });
				res.end(JSON.stringify({ error: "invalid_grant", error_description: "Refresh token not found or invalid" }));
				return;
			}
			// Spent at once, so every call refreshes and the next refusal is the smoke's to choose.
			res.writeHead(200, { "content-type": "application/json" });
			res.end(JSON.stringify({ access_token: `synthetic-access-${tokenCalls}`, refresh_token: `synthetic-refresh-${tokenCalls}`, expires_in: 0 }));
			return;
		}
		requests.push({ raw });
		const openAi = String(req.url ?? "").includes("/chat/completions");
		const body = JSON.parse(raw || "{}");
		const answer = () => {
			if (refuse === "workspace") {
				res.writeHead(400, { "content-type": "application/json" });
				res.end(JSON.stringify({ type: "error", error: { type: "invalid_request_error", message: "This API key is not scoped to a workspace, so this request must include the anthropic-workspace-id header with the ID of the workspace to use. Add the header, or use an API key that is scoped to a workspace." } }));
				return;
			}
			if (refuse) {
				res.writeHead(401, { "content-type": "application/json" });
				res.end(JSON.stringify(openAi
					? { error: { message: OPENAI_REFUSAL, type: "invalid_request_error", param: null, code: "invalid_api_key" } }
					: { type: "error", error: { type: "authentication_error", message: ANTHROPIC_REFUSAL } }));
				return;
			}
			res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
			const text = `Answer from ${body.model}.`;
			if (openAi) {
				const base = { id: `cmpl_${requests.length}`, object: "chat.completion.chunk", created: Math.floor(Date.now() / 1000), model: body.model };
				sse(res, null, { ...base, choices: [{ index: 0, delta: { role: "assistant", content: text }, finish_reason: null }] });
				sse(res, null, { ...base, choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 } });
				res.write("data: [DONE]\n\n");
				res.end();
				return;
			}
			sse(res, "message_start", { type: "message_start", message: { id: `msg_${requests.length}`, type: "message", role: "assistant", model: body.model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 100, output_tokens: 1 } } });
			sse(res, "content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } });
			sse(res, "content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text } });
			sse(res, "content_block_stop", { type: "content_block_stop", index: 0 });
			sse(res, "message_delta", { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 20 } });
			sse(res, "message_stop", { type: "message_stop" });
			res.end();
		};
		if (refuse && holdMs > 0) setTimeout(answer, holdMs);
		else answer();
	});
});

async function api(pathname: string, init: AuthedFetchInit = {}): Promise<{ status: number; body: any; text: string }> {
	const response = await authedFetch(`${baseUrl}${pathname}`, { ...init, headers: { ...(init.body ? { "content-type": "application/json" } : {}), ...init.headers } });
	const text = await response.text();
	return { status: response.status, body: text ? JSON.parse(text) : null, text };
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

async function turnIn(agentId: string, conversationId: string, text: string): Promise<void> {
	const created = await api(`/api/persistent-agents/${agentId}/threads/${conversationId}`, { method: "PUT", body: JSON.stringify({ state: "active", origin: "home", items: [] }) });
	assert(created.status === 200, `the conversation opens, got ${created.status} ${JSON.stringify(created.body)}`);
	const frames: any[] = [];
	const socket = new WebSocketImpl(`ws://127.0.0.1:${port}/ws?persistentAgentId=${agentId}&conversationId=${conversationId}`, { headers: { ...SMOKE_AUTH_HEADERS } });
	socket.addEventListener("message", (event: { data: unknown }) => { try { frames.push(JSON.parse(String(event.data))); } catch {} });
	await new Promise<void>((resolve, reject) => { socket.addEventListener("open", () => resolve()); socket.addEventListener("error", () => reject(new Error("websocket failed to connect"))); });
	await waitUntil(() => frames.some((frame) => frame.type === "ready"), "ready frame");
	const before = calls();
	socket.send(JSON.stringify({ type: "prompt", text }));
	await waitUntil(async () => calls() > before && (await api(`/api/persistent-agents/${agentId}/status`)).body?.activeThread?.inFlight === false, `the turn "${text}" settled`);
	socket.close();
}

async function profileRow(id: string): Promise<any> {
	const status = await api("/api/persistent-agent-ai-profile");
	const leaked = PROVIDER_WORDS.filter((words) => status.text.includes(words));
	assert(leaked.length === 0, `the profile status carries the provider's own text: ${JSON.stringify(leaked)}`);
	const row = (status.body.profiles as any[]).find((profile) => profile.id === id);
	assert(row, `the row ${id} is listed, got ${JSON.stringify((status.body.profiles as any[]).map((profile) => profile.id))}`);
	return row;
}
const keyRow = () => profileRow(PROFILE_ID);
const signInRow = () => profileRow(SIGN_IN_PROVIDER);
const signedOutRow = (row: any) => row.provider?.keyRefused === "signed-out" && row.message === SIGN_IN_SENTENCE && row.issues?.includes(SIGN_IN_SENTENCE);
const gatewayRow = () => profileRow(GATEWAY_ID);

const said = (row: any) => JSON.stringify({ ready: row.ready, keyRefused: row.provider?.keyRefused, message: row.message, issues: row.issues });
const refusedRow = (row: any, kind: "refused" | "no-workspace" = "refused") => {
	const sentence = kind === "no-workspace" ? WORKSPACE_SENTENCE : SENTENCE;
	return row.provider?.keyRefused === kind && row.message === sentence && row.issues?.includes(sentence);
};
const clearRow = (row: any) => row.ready === true && row.provider?.keyRefused === undefined && row.message === null && !row.issues?.some((issue: string) => issue.startsWith("Not accepted"));

/** AI setup's row for a provider as the page draws it: its line, whether it offers Sign in, and whether Replace key opens the key form. */
async function rowInPage(page: Page, providerId: string): Promise<{ line: string; signInOffered: boolean; replaceOpensForm: boolean }> {
	await page.goto(`${baseUrl}/auth/session?token=${SMOKE_AUTH_TOKEN}`);
	await page.waitForLoadState("networkidle");
	const dismiss = page.locator(".whats-new-close");
	if (await dismiss.count()) await dismiss.click();
	await page.locator(".product-sidebar-footer button").first().click();
	await page.locator(".sidebar-config-menu button, .sidebar-config-menu a").filter({ hasText: /Settings/ }).first().click();
	await page.waitForSelector(".settings-overlay", { timeout: 10_000 });
	await page.locator(".settings-dialog-nav button").filter({ hasText: "AI setup" }).first().click();
	const row = page.locator(`.ai-profile-row-group[data-provider-id="${providerId}"]`);
	await row.waitFor({ timeout: 15_000 });
	const line = (await row.locator(".ai-profile-sub").innerText()).trim();
	const signInOffered = await row.getByRole("button", { name: "Sign in", exact: true }).count() === 1;
	const replace = row.getByRole("button", { name: "Replace key" });
	if (await replace.count() !== 1) return { line, signInOffered, replaceOpensForm: false };
	await replace.click();
	return { line, signInOffered, replaceOpensForm: await row.locator('input[type="password"]').count() >= 1 };
}

let server: ChildProcessWithoutNullStreams | undefined;
const serverOutput: string[] = [];
let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
let tokenUrl = "";

async function startServer(): Promise<void> {
	server = spawn("npx", ["tsx", "src/index.ts"], {
		shell: process.platform === "win32",
		...SMOKE_SERVER_SPAWN_TREE_OPTIONS,
		cwd: webServerDir,
		env: smokeHomeEnv(tempHome, { PORT: String(port), ...SMOKE_SERVER_AUTH_ENV, EXXETA_HOME: repoRoot, EXXPERTS_CODING_AGENT_DIR: agentDir, EXXETA_PERSISTENT_AGENTS_ROOT: agentsRoot, SMOKE_OAUTH_TOKEN_URL: tokenUrl, NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ""} --import=${pathToFileURL(path.join(scriptDir, "oauth-token-preload.mjs")).href}`.trim() }) as NodeJS.ProcessEnv,
	});
	server.stdout.on("data", (chunk) => serverOutput.push(String(chunk)));
	server.stderr.on("data", (chunk) => serverOutput.push(String(chunk)));
	await waitUntil(() => fetch(`${baseUrl}/healthz`).then((r) => r.ok).catch(() => false), "server ready", 60_000);
}

try {
	await new Promise<void>((resolve) => endpoint.listen(0, "127.0.0.1", resolve));
	const endpointUrl = `http://127.0.0.1:${(endpoint.address() as AddressInfo).port}`;
	tokenUrl = `${endpointUrl}/v1/oauth/token`;
	fs.writeFileSync(path.join(agentDir, "models.json"), JSON.stringify({ providers: { [KEY_PROVIDER]: { baseUrl: endpointUrl }, [SIGN_IN_PROVIDER]: { baseUrl: endpointUrl } } }, null, 2), { mode: 0o600 });
	// A made-up Claude sign-in whose token has already run out: its next call asks for a refresh.
	fs.writeFileSync(path.join(agentDir, "auth.json"), JSON.stringify({ [KEY_PROVIDER]: { type: "api_key", key: "synthetic-anthropic-key" }, [SIGN_IN_PROVIDER]: { type: "oauth", access: "synthetic-oauth-access", refresh: "synthetic-oauth-refresh", expires: Date.now() - 60_000 } }, null, 2), { mode: 0o600 });
	fs.writeFileSync(path.join(appDir, "custom-ai-profiles.json"), JSON.stringify({ version: 1, profiles: [
		{ id: PROFILE_ID, providerId: KEY_PROVIDER, label: "Claude API key", roomModels: [ON_KEY.model], learnModel: ON_KEY.model, reviewMemoryModel: ON_KEY.model },
	] }, null, 2), { mode: 0o600 });
	fs.writeFileSync(path.join(appDir, "persistent-agent-ai-profile.json"), JSON.stringify({ profileId: PROFILE_ID }, null, 2), { mode: 0o600 });

	const agents = await import("../src/persistent-agents.js");
	const roomModels = await import("../src/room-models.js");
	const newRoom = (displayName: string) => agents.createPersistentAgentFromScaffoldInput({ displayName, userName: "Synthetic User", preferredUserAddress: "Synthetic User" }).agent.agentId;
	const room = newRoom("Key Room");
	roomModels.writeRoomModels(room, { conversation: ON_KEY, memory: ON_KEY });
	const gatewayRoom = newRoom("Gateway Room");
	const signInRoom = newRoom("Sign-in Room");
	roomModels.writeRoomModels(signInRoom, { conversation: ON_SIGN_IN, memory: ON_SIGN_IN });

	await startServer();

	const chromiumPath = typeof chromium?.executablePath === "function" ? chromium.executablePath() : "";
	const page = chromiumPath && fs.existsSync(chromiumPath) ? await (await (browser = await chromium.launch()).newContext({ viewport: { width: 1280, height: 900 } })).newPage() : null;
	if (!page) console.log("  skip AI setup's row in the page (Chromium not installed)");

	await turnIn(room, "c_key_0001", "A question the key answers.");
	assert(clearRow(await keyRow()), `with the key answering, its row is ready and says nothing more, got ${said(await keyRow())}`);
	pass("a key that answers: its row is ready");

	refuse = "key";
	await turnIn(room, "c_key_0002", "A question the service refuses.");
	refuse = false;
	const afterRefusal = await keyRow();
	assert(refusedRow(afterRefusal), `after the service refused the key, its row says so, got ${said(afterRefusal)}`);
	pass("a turn refused for its key: the profile says it was not accepted at the last try, in our words only");
	if (page) {
		const drawn = await rowInPage(page, KEY_PROVIDER);
		assert(drawn.line === ROW_LINE, `the row's line is "${ROW_LINE}", got "${drawn.line}"`);
		assert(drawn.replaceOpensForm, "the row offers Replace key, which opens the key form");
		pass(`AI setup's row reads "${ROW_LINE}" beside Replace key, which opens the key form`);
	}

	await turnIn(room, "c_key_0003", "A question the key answers again.");
	assert(clearRow(await keyRow()), `a turn the service answered clears it, got ${said(await keyRow())}`);
	pass("the next answered turn clears it");

	refuse = "key";
	const rememberBefore = requests.length;
	const proposed = authedFetch(`${baseUrl}/api/persistent-agents/${room}/checkpoint/propose`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ conversationId: "c_key_0003", density: "standard" }) }).catch(() => null);
	await waitUntil(() => requests.length > rememberBefore, "Remember's call reaches the endpoint");
	await waitUntil(async () => refusedRow(await keyRow()), "a Memory model call refused for its key marks the row", 15_000);
	await proposed;
	refuse = false;
	await api(`/api/persistent-agents/${room}/checkpoint/cancel`, { method: "POST", body: JSON.stringify({ conversationId: "c_key_0003" }) });
	pass("a Memory model call refused for its key: the row says the same");

	const saved = await api("/api/auth/api-key", { method: "POST", body: JSON.stringify({ provider: KEY_PROVIDER, key: "another-synthetic-key" }) });
	assert(saved.status === 200, `the key saves again, got ${saved.status} ${JSON.stringify(saved.body)}`);
	assert(clearRow(await keyRow()), `saving the key again clears it before any call, got ${said(await keyRow())}`);
	pass("saving the key again clears it");

	// A call out with the old key is refused after the new key is saved: that refusal is about the old key.
	refuse = "key";
	holdMs = 1_500;
	const lateBefore = requests.length;
	const lateTurn = turnIn(room, "c_key_0004", "A question still out when the key is replaced.");
	await waitUntil(() => requests.length > lateBefore, "the call with the old key is out");
	const replaced = await api("/api/auth/api-key", { method: "POST", body: JSON.stringify({ provider: KEY_PROVIDER, key: "a-third-synthetic-key" }) });
	assert(replaced.status === 200, `the key saves while the call is out, got ${replaced.status}`);
	await lateTurn;
	refuse = false;
	holdMs = 0;
	assert(clearRow(await keyRow()), `a refusal for a call that started before the save does not mark the new key, got ${said(await keyRow())}`);
	pass("a refusal from a call that started before the new key was saved leaves the new key clear");

	refuse = "workspace";
	await turnIn(room, "c_key_0005", "A question on a key outside a workspace.");
	refuse = false;
	const afterWorkspace = await keyRow();
	assert(refusedRow(afterWorkspace, "no-workspace"), `a key outside a workspace says so, in the room's own cause, got ${said(afterWorkspace)}`);
	if (page) {
		const drawn = await rowInPage(page, KEY_PROVIDER);
		assert(drawn.line === WORKSPACE_ROW_LINE, `the row's line is "${WORKSPACE_ROW_LINE}", got "${drawn.line}"`);
	}
	await turnIn(room, "c_key_0006", "A question the key answers once more.");
	assert(clearRow(await keyRow()), `an answered turn clears that too, got ${said(await keyRow())}`);
	pass("a key outside a workspace: the profile and the row name the cause, and an answered turn clears it");

	// A gateway: its key is replaced through the gateway route, not /api/auth/api-key.
	const gatewayBody = (key?: string) => JSON.stringify({ label: "Synthetic gateway", baseUrl: endpointUrl, ...(key ? { key } : {}), roomModels: [{ modelId: ON_GATEWAY.model, vision: false, webSearch: false, reasoning: false, contextWindow: 200000 }], maintenanceModel: ON_GATEWAY.model });
	const made = await api(`/api/persistent-agent-ai-profiles/gateways/${GATEWAY_ID}`, { method: "PUT", body: gatewayBody("synthetic-gateway-key") });
	assert(made.status === 200, `the gateway is made, got ${made.status} ${JSON.stringify(made.body)}`);
	const picked = await api(`/api/persistent-agents/${gatewayRoom}/models`, { method: "PUT", body: JSON.stringify({ conversation: ON_GATEWAY }) });
	assert(picked.status === 200, `the gateway room picks the gateway's model, got ${picked.status} ${JSON.stringify(picked.body)}`);
	await turnIn(gatewayRoom, "c_gw_0001", "A question the gateway answers.");
	assert(clearRow(await gatewayRow()), `the gateway answers: its row is ready, got ${said(await gatewayRow())}`);

	refuse = "key";
	await turnIn(gatewayRoom, "c_gw_0002", "A question the gateway refuses.");
	refuse = false;
	assert(refusedRow(await gatewayRow()), `the gateway's refused key shows on its row, with none of the provider's text, got ${said(await gatewayRow())}`);
	const replacedGateway = await api(`/api/persistent-agent-ai-profiles/gateways/${GATEWAY_ID}`, { method: "PUT", body: gatewayBody("new-gateway-key") });
	assert(replacedGateway.status === 200, `the gateway's key is replaced, got ${replacedGateway.status} ${JSON.stringify(replacedGateway.body)}`);
	assert(clearRow(await gatewayRow()), `a new key saved through the gateway route clears it, got ${said(await gatewayRow())}`);
	pass("a gateway's refused key: its row says so, and a new key saved through the gateway route clears it");

	refuse = "key";
	await turnIn(gatewayRoom, "c_gw_0003", "A question the gateway refuses again.");
	refuse = false;
	assert(refusedRow(await gatewayRow()), `refused again, got ${said(await gatewayRow())}`);
	const deleted = await api(`/api/persistent-agent-ai-profiles/gateways/${GATEWAY_ID}`, { method: "DELETE" });
	assert(deleted.status === 200, `the gateway is deleted, got ${deleted.status} ${JSON.stringify(deleted.body)}`);
	const remade = await api(`/api/persistent-agent-ai-profiles/gateways/${GATEWAY_ID}`, { method: "PUT", body: gatewayBody("a-fresh-gateway-key") });
	assert(remade.status === 200, `the gateway is made again, got ${remade.status} ${JSON.stringify(remade.body)}`);
	assert(clearRow(await gatewayRow()), `a gateway made again under the same id starts clear, got ${said(await gatewayRow())}`);
	pass("a gateway deleted and made again starts clear");

	// A Claude sign-in: what the last real call learned about it, never a check of its own.
	assert(clearRow(await signInRow()), `a sign-in no call has used reads signed in, got ${said(await signInRow())}`);
	if (page) {
		const drawn = await rowInPage(page, SIGN_IN_PROVIDER);
		assert(drawn.line === "signed in" && !drawn.signInOffered, `an untouched sign-in's row reads "signed in" with no Sign in, got "${drawn.line}" (Sign in offered: ${drawn.signInOffered})`);
	}
	pass("an untouched sign-in still reads signed in");

	await turnIn(signInRoom, "c_sign_0001", "A question on a sign-in whose refresh is refused.");
	const afterGone = await signInRow();
	assert(signedOutRow(afterGone), `after a turn found the sign-in gone, its row says signed out, got ${said(afterGone)}`);
	if (page) {
		const drawn = await rowInPage(page, SIGN_IN_PROVIDER);
		assert(drawn.line === "signed out" && drawn.signInOffered && !drawn.replaceOpensForm, `the row reads "signed out" beside Sign in, got "${drawn.line}" (Sign in offered: ${drawn.signInOffered})`);
	}
	pass("a turn whose sign-in's refresh is refused: AI setup's row reads signed out and offers Sign in");

	// A new sign-in through the app, its code exchanged at the same local endpoint.
	refuseRefresh = false;
	const login = await api("/api/auth/login", { method: "POST", body: JSON.stringify({ provider: SIGN_IN_PROVIDER }) });
	assert(login.status === 200 && typeof login.body?.url === "string", `the sign-in starts, got ${login.status}`);
	const state = new URL(login.body.url).searchParams.get("state");
	const callback = await fetch(`${SIGN_IN_CALLBACK}?code=synthetic-code&state=${encodeURIComponent(String(state))}`);
	assert(callback.ok, `the sign-in's callback takes the code, got ${callback.status}`);
	await waitUntil(async () => (await api("/api/auth/login/status")).body?.pending === false, "the new sign-in completes");
	assert(!(await api("/api/auth/login/status")).body?.error, "the new sign-in completes without an error");
	assert(clearRow(await signInRow()), `a new sign-in clears it, got ${said(await signInRow())}`);
	await turnIn(signInRoom, "c_sign_0002", "A question the new sign-in answers.");
	assert(clearRow(await signInRow()), `a turn the new sign-in answered leaves it clear, got ${said(await signInRow())}`);
	pass("a new sign-in clears it, and its answered turn leaves it clear");

	refuseRefresh = true;
	const signInMemoryBefore = calls();
	const signInProposed = authedFetch(`${baseUrl}/api/persistent-agents/${signInRoom}/checkpoint/propose`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ conversationId: "c_sign_0002", density: "standard" }) }).catch(() => null);
	await waitUntil(() => calls() > signInMemoryBefore, "Remember's call asks for the sign-in's refresh");
	await waitUntil(async () => signedOutRow(await signInRow()), "a Memory model call that finds the sign-in gone marks the row", 15_000);
	await signInProposed;
	await api(`/api/persistent-agents/${signInRoom}/checkpoint/cancel`, { method: "POST", body: JSON.stringify({ conversationId: "c_sign_0002" }) });
	pass("a Memory model call that finds the sign-in gone: the row says signed out too");

	// AI setup open through a restart: the record ends with the process, and the
	// page reads the profile again when it reconnects.
	if (page) {
		refuse = "key";
		await turnIn(room, "c_key_0007", "A question refused before a restart.");
		refuse = false;
		assert(refusedRow(await keyRow()), `refused before the restart, got ${said(await keyRow())}`);
		const drawn = await rowInPage(page, KEY_PROVIDER);
		assert(drawn.line === ROW_LINE, `before the restart the open row reads "${ROW_LINE}", got "${drawn.line}"`);
		await page.locator(".ai-profile-key-form").getByRole("button", { name: "Cancel" }).click();
		const line = async () => (await page.locator(`.ai-profile-row-group[data-provider-id="${KEY_PROVIDER}"] .ai-profile-sub`).innerText().catch(() => "")).trim();
		await stopSmokeServer(server);
		server = undefined;
		await startServer();
		assert(clearRow(await keyRow()), `the restart ended the record, got ${said(await keyRow())}`);
		await waitUntil(async () => (await line()) === "key saved", "the open AI setup reads the profile again once the page reconnects", 45_000).catch(async (error) => {
			throw new Error(`${(error as Error).message}; the row reads "${await line()}"`);
		});
		pass("AI setup open through a restart reads the profile again on the reconnect: the row no longer says the key was refused");
	}

	// This process as a shared server: the words for a refused key there.
	const { registerServerHooks } = await import("../src/server-hooks.js");
	const { keyRefusedSetupSentence } = await import("../src/model-call-causes.js");
	assert(keyRefusedSetupSentence("refused") === SENTENCE, `on the desktop: "${keyRefusedSetupSentence("refused")}"`);
	registerServerHooks({});
	const shared = [keyRefusedSetupSentence("refused"), keyRefusedSetupSentence("no-workspace")];
	const sharedWanted = ["Not accepted at the last try. Tell your admin.", "Not accepted at the last try: this key isn't tied to a workspace. Tell your admin."];
	assert(JSON.stringify(shared) === JSON.stringify(sharedWanted), `on a shared server the sentences send the person to their admin, got ${JSON.stringify(shared)}`);
	pass("on a shared server a refused key's sentence says to tell the admin");

	console.log("key-refused-setup smoke: ok");
} catch (error) {
	console.error(serverOutput.join("").slice(-6000));
	throw error;
} finally {
	await browser?.close().catch(() => {});
	try { (endpoint as any).closeAllConnections?.(); } catch {}
	try { endpoint.close(); } catch {}
	await stopSmokeServer(server);
	fs.rmSync(tempRoot, { recursive: true, force: true });
}
