// A conversation whose provider is signed out, in the browser (it carries
// the red refusal line an older build saved into it, which is not shown
// again): resuming it
// says so in one notice above the composer, which names the signed-out
// provider and offers Sign in (Settings, AI setup) and Choose another model
// (Room settings, Model); no Reconnect, no offline chip, no second sentence,
// and the room stops dialing. Once the provider is signed in again (noticed
// when the window comes back to the front), the room dials again by itself
// and Send is back, without leaving the room. Then the key stops working
// while the catalog still counts it (an expired sign-in, the provider answers
// 401): the next turn fails on it, and the room shows the same one notice
// instead of the raw error, and once the person signs in again the next send
// runs on the new sign-in, in the same room,
// with the message back in the composer to send again after signing in.
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { authedFetch, SMOKE_AUTH_TOKEN, SMOKE_SERVER_AUTH_ENV, SMOKE_SERVER_SPAWN_TREE_OPTIONS, smokeHomeEnv, stopSmokeServer } from "./smoke-server-process.js";

function assert(condition: unknown, message: string): asserts condition {
	if (!condition) throw new Error(message);
}

// A machine without Chromium cannot run a browser assertion at all; skip
// whole, the same way remote-settings-readonly-smoke does.
{
	const p = typeof chromium?.executablePath === "function" ? chromium.executablePath() : "";
	if (!p || !fs.existsSync(p)) {
		console.log("room signed out reconnect smoke skipped (Chromium not installed)");
		process.exit(0);
	}
}

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const webServerDir = path.resolve(scriptDir, "..");
const repoRoot = path.resolve(webServerDir, "..", "..");
const port = 27000 + Math.floor(Math.random() * 10000);
const baseUrl = `http://127.0.0.1:${port}`;

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "exxperts-signed-out-ui-"));
const tempHome = path.join(tempRoot, "home");
const agentsRoot = path.join(tempHome, ".exxperts", "app", "personalized-agents");
const agentDir = path.join(tempHome, ".exxperts", "agent");
const appDir = path.join(tempHome, ".exxperts", "app");
for (const dir of [agentsRoot, agentDir]) fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
process.env.HOME = tempHome;
process.env.USERPROFILE = tempHome;
process.env.EXXPERTS_CODING_AGENT_DIR = agentDir;
process.env.EXXETA_PERSISTENT_AGENTS_ROOT = agentsRoot;

// Which turn errors count as a sign-in that cannot be used; the rest keep the
// ordinary error line.
{
	const { isSignInFailure } = await import("../../web-ui/src/sign-in-failure.js");
	for (const detail of ["No API key for provider: anthropic", "No API key found for anthropic.", 'Authentication failed for "anthropic". Credentials may have expired or network is unavailable.', '401 {"type":"error","error":{"type":"authentication_error","message":"invalid x-api-key"}}', "401 Incorrect API key provided", "OpenAI Codex token refresh failed (401): expired"]) {
		if (!isSignInFailure(detail)) throw new Error(`a sign-in failure is recognised: ${detail}`);
	}
	for (const detail of ["429 rate_limit_error: slow down", "529 overloaded_error", "400 invalid_request_error: max_tokens", "403 permission_error: this key cannot use this model", "prompt is too long: 200401 tokens > 200000 maximum", "the request exceeds the limit by 401 tokens"]) {
		if (isSignInFailure(detail)) throw new Error(`an ordinary model error keeps its line: ${detail}`);
	}
	console.log("  ok  sign-in failures are told apart from rate limits, overload, bad requests, 403 and token counts");
}

const CLAUDE = { provider: "fake-claude", model: "claude-fake" };
const requests: Array<{ model: string }> = [];
// The one key the OpenAI-style provider takes; changing it retires the stored one.
let acceptedGptKey = "synthetic-gpt";

function sse(res: http.ServerResponse, event: string | null, payload: unknown): void {
	res.write(`${event ? `event: ${event}\n` : ""}data: ${JSON.stringify(payload)}\n\n`);
}

// Two synthetic providers: one speaks the Anthropic stream, one the OpenAI one.
const providers = http.createServer((req, res) => {
	let raw = "";
	req.on("data", (chunk) => { raw += chunk; });
	req.on("end", () => {
		const body = JSON.parse(raw || "{}");
		if (!String(req.url ?? "").includes("/messages") && req.headers.authorization !== `Bearer ${acceptedGptKey}`) {
			res.writeHead(401, { "content-type": "application/json" });
			res.end(JSON.stringify({ error: { message: "Incorrect API key provided", type: "invalid_request_error", code: "invalid_api_key" } }));
			return;
		}
		requests.push({ model: String(body.model) });
		res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
		const text = `Answer from ${body.model}.`;
		if (String(req.url ?? "").includes("/messages")) {
			sse(res, "message_start", { type: "message_start", message: { id: `msg_${requests.length}`, type: "message", role: "assistant", model: body.model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 100, output_tokens: 1 } } });
			sse(res, "content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } });
			sse(res, "content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text } });
			sse(res, "content_block_stop", { type: "content_block_stop", index: 0 });
			sse(res, "message_delta", { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 20 } });
			sse(res, "message_stop", { type: "message_stop" });
			res.end();
			return;
		}
		const base = { id: `cmpl_${requests.length}`, object: "chat.completion.chunk", created: Math.floor(Date.now() / 1000), model: body.model };
		sse(res, null, { ...base, choices: [{ index: 0, delta: { role: "assistant", content: text }, finish_reason: null }] });
		sse(res, null, { ...base, choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 } });
		res.write("data: [DONE]\n\n");
		res.end();
	});
});

async function waitUntil(predicate: () => Promise<boolean> | boolean, label: string, timeoutMs = 25_000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (await predicate()) return;
		await new Promise((resolve) => setTimeout(resolve, 150));
	}
	throw new Error(`timed out waiting until ${label}`);
}

let server: ChildProcessWithoutNullStreams | undefined;
const serverOutput: string[] = [];

try {
	await new Promise<void>((resolve) => providers.listen(0, "127.0.0.1", resolve));
	const providerPort = (providers.address() as AddressInfo).port;
	fs.writeFileSync(path.join(agentDir, "models.json"), JSON.stringify({
		providers: {
			"fake-claude": { name: "Fake Claude", baseUrl: `http://127.0.0.1:${providerPort}`, api: "anthropic-messages", models: [{ id: "claude-fake", name: "Claude Fake", input: ["text"], contextWindow: 200000, maxTokens: 32000 }] },
			"fake-gpt": { name: "Fake GPT", baseUrl: `http://127.0.0.1:${providerPort}/v1`, api: "openai-completions", models: [{ id: "gpt-fake", name: "GPT Fake", input: ["text"], contextWindow: 128000, maxTokens: 16000 }] },
		},
	}, null, 2), { mode: 0o600 });
	const authFile = path.join(agentDir, "auth.json");
	fs.writeFileSync(authFile, JSON.stringify({ "fake-claude": { type: "api_key", key: "synthetic-claude" } }, null, 2), { mode: 0o600 });
	fs.writeFileSync(path.join(appDir, "custom-ai-profiles.json"), JSON.stringify({ version: 1, profiles: [
		{ id: "custom-fake-claude", providerId: "fake-claude", label: "Fake Claude", roomModels: ["claude-fake"], learnModel: "claude-fake", reviewMemoryModel: "claude-fake" },
		{ id: "custom-fake-gpt", providerId: "fake-gpt", label: "Fake GPT", roomModels: ["gpt-fake"], learnModel: "gpt-fake", reviewMemoryModel: "gpt-fake" },
	] }, null, 2), { mode: 0o600 });
	fs.writeFileSync(path.join(appDir, "persistent-agent-ai-profile.json"), JSON.stringify({ profileId: "custom-fake-claude" }, null, 2), { mode: 0o600 });

	const agents = await import("../src/persistent-agents.js");
	const roomModels = await import("../src/room-models.js");
	const GPT = { provider: "fake-gpt", model: "gpt-fake" };
	const agentId = agents.createPersistentAgentFromScaffoldInput({ displayName: "Signed Out Room", userName: "Synthetic User", preferredUserAddress: "Synthetic User" }).agent.agentId;
	roomModels.writeRoomModels(agentId, { conversation: CLAUDE });
	// A standby conversation locked to GPT, whose provider is not signed in.
	const conversationId = "c_signed_out_0001";
	const threadCwd = path.join(tempRoot, "cwd");
	fs.mkdirSync(threadCwd, { recursive: true });
	const created = agents.writePersistentAgentThread(agentId, conversationId, { state: "standby", origin: "home", model: GPT, items: [{ kind: "user", id: "u1", text: "Earlier question." }, { kind: "assistant", id: "a1", text: "Earlier answer." }, { kind: "system", id: "s1", level: "error", text: "Fake GPT is signed out, so this conversation cannot continue on GPT Fake. Sign in again in Settings, AI setup, or continue it on another model in Room settings, Model." }] }, {
		createRuntime: ({ model }) => agents.createPersistentAgentPiSessionJsonlThreadRuntime({ agentId, threadId: conversationId, model, cwd: threadCwd }),
	});
	const seed = agents.openPersistentAgentPiSessionManager(agentId, created.thread.runtime as any, threadCwd);
	const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
	seed.appendMessage({ role: "user", content: [{ type: "text", text: "Earlier question." }], timestamp: Date.now() } as any);
	seed.appendMessage({ role: "assistant", content: [{ type: "text", text: "Earlier answer." }], api: "openai-completions", provider: GPT.provider, model: GPT.model, usage, stopReason: "stop", timestamp: Date.now() } as any);

	server = spawn("npx", ["tsx", "src/index.ts"], {
		shell: process.platform === "win32",
		...SMOKE_SERVER_SPAWN_TREE_OPTIONS,
		cwd: webServerDir,
		env: smokeHomeEnv(tempHome, { PORT: String(port), ...SMOKE_SERVER_AUTH_ENV, EXXETA_HOME: repoRoot, EXXPERTS_CODING_AGENT_DIR: agentDir, EXXETA_PERSISTENT_AGENTS_ROOT: agentsRoot }) as NodeJS.ProcessEnv,
	});
	server.stdout.on("data", (chunk) => serverOutput.push(String(chunk)));
	server.stderr.on("data", (chunk) => serverOutput.push(String(chunk)));
	await waitUntil(() => fetch(`${baseUrl}/healthz`).then((r) => r.ok).catch(() => false), "server ready");

	const browser = await chromium.launch();
	try {
		const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
		const page = await ctx.newPage();
		const roomDials: string[] = [];
		page.on("websocket", (ws) => { if (ws.url().includes("persistentAgentId=")) roomDials.push(ws.url()); });
		await page.goto(`${baseUrl}/auth/session?token=${SMOKE_AUTH_TOKEN}`);
		await page.waitForLoadState("networkidle");
		const dismiss = page.locator(".whats-new-foot .btn-primary");
		if (await dismiss.count()) await dismiss.click();

		await page.locator(".persistent-agent-card").filter({ hasText: "Signed Out Room" }).getByRole("button", { name: "Resume →" }).click();
		const banner = page.locator(".room-model-notice");
		await banner.waitFor({ timeout: 15000 });
		assert((await banner.innerText()).includes("Fake GPT is signed out. Sign in again to continue this conversation."), `the notice names the signed-out provider, got ${JSON.stringify(await banner.innerText())}`);
		assert((await banner.getByRole("button").allInnerTexts()).join("|") === "Choose another model|Sign in", "the buttons read in the app's order, Sign in last");
		assert((await banner.getByRole("button", { name: "Sign in" }).count()) === 1 && (await banner.getByRole("button", { name: "Choose another model" }).count()) === 1, "the notice offers Sign in and Choose another model");
		const dialsWhileOut = roomDials.length;
		await page.waitForTimeout(6000);
		assert(roomDials.length === dialsWhileOut, `the room stops dialing a signed-out provider, got ${roomDials.length - dialsWhileOut} more dials`);
		assert((await page.getByText(/so this conversation cannot continue on/).count()) === 0, "the notice is the only place that says it");
		assert((await page.getByRole("button", { name: "Reconnect" }).count()) === 0 && (await page.locator(".composer-connection").count()) === 0, "no Reconnect and no offline chip: reconnecting cannot help");
		assert((await page.locator('button[title="Waiting for the connection"]').count()) === 1, "Send waits");
		await banner.getByRole("button", { name: "Choose another model" }).click();
		await page.locator(".room-model-section").waitFor({ timeout: 10000 });
		await page.keyboard.press("Escape");
		await page.locator(".room-model-section").waitFor({ state: "detached", timeout: 10000 });
		await banner.getByRole("button", { name: "Sign in" }).click();
		await page.locator("[data-provider-id=\"fake-gpt\"]").waitFor({ timeout: 10000 });
		await page.keyboard.press("Escape");
		await page.locator("[data-provider-id=\"fake-gpt\"]").waitFor({ state: "detached", timeout: 10000 });
		console.log("  ok  Choose another model opens Room settings, Model, and Sign in opens AI setup at the provider's row");

		// Signed in again elsewhere; the room notices when the window is back.
		fs.writeFileSync(authFile, JSON.stringify({ "fake-claude": { type: "api_key", key: "synthetic-claude" }, "fake-gpt": { type: "api_key", key: "synthetic-gpt" } }, null, 2), { mode: 0o600 });
		await page.evaluate(() => window.dispatchEvent(new Event("focus")));
		await page.locator('button[title="Send"]').first().waitFor({ timeout: 15000 });
		await banner.waitFor({ state: "detached", timeout: 10000 });
		assert(roomDials.length > dialsWhileOut, "the room dialed again by itself");
		await page.waitForTimeout(800);
		const composer = page.locator("textarea").first();
		await composer.fill("Back on GPT.");
		await composer.press("Enter");
		await page.getByText("Answer from gpt-fake.").waitFor({ timeout: 20000 });
		assert(requests[requests.length - 1]?.model === "gpt-fake", "the conversation continues on its provider");

		// The key stops working while the catalog still counts it: the provider
		// refuses it and the turn fails at request time on the sign-in.
		const warnings: string[] = [];
		page.on("console", (message) => { if (message.type() === "warning") warnings.push(message.text()); });
		acceptedGptKey = "synthetic-gpt-renewed";
		const requestsBefore = requests.length;
		await composer.fill("Still there?");
		await composer.press("Enter");
		await banner.waitFor({ timeout: 20000 });
		assert((await banner.innerText()).includes("Fake GPT is signed out.") && (await banner.getByRole("button", { name: "Sign in" }).count()) === 1 && (await banner.getByRole("button", { name: "Choose another model" }).count()) === 1, `a turn that fails on the sign-in shows the one notice, got ${JSON.stringify(await banner.innerText())}`);
		assert((await page.getByText(/could not respond|Incorrect API key/).count()) === 0, "no raw error on the face");
		assert(warnings.some((text) => /the turn failed on the provider's sign-in:.*401/.test(text)), `the raw error goes to the log, got ${JSON.stringify(warnings)}`);
		assert(requests.length === requestsBefore, "the provider refused the key, and nothing answered");
		assert((await composer.inputValue()) === "Still there?", `the message is back in the composer, to send after signing in, got ${JSON.stringify(await composer.inputValue())}`);
		assert((await page.getByRole("button", { name: "Reconnect" }).count()) === 0 && (await page.locator(".composer-connection").count()) === 0, "no Reconnect and no offline chip");
		console.log("  ok  a turn that fails on the sign-in shows the one notice with Sign in, logs the raw error, and keeps the message");

		// The person signs in again (the new key lands in the sign-in store):
		// the next send runs on it, without leaving the room, and the notice goes.
		fs.writeFileSync(authFile, JSON.stringify({ "fake-claude": { type: "api_key", key: "synthetic-claude" }, "fake-gpt": { type: "api_key", key: "synthetic-gpt-renewed" } }, null, 2), { mode: 0o600 });
		// The failed turn has settled on the server before the person sends
		// again (signing in takes a person longer than that).
		await waitUntil(async () => (await (await authedFetch(`${baseUrl}/api/persistent-agents/${agentId}/status`)).json())?.activeThread?.inFlight === false, "the failed turn settled");
		await composer.press("Enter");
		await page.getByText("Answer from gpt-fake.").nth(1).waitFor({ timeout: 20000 });
		assert(requests.length === requestsBefore + 1, "the message was answered on the new sign-in");
		await banner.waitFor({ state: "detached", timeout: 10000 });
		console.log("  ok  after the sign-in the next send answers on it, in the same room, and the notice is gone");
		await ctx.close();
	} finally {
		await browser.close();
	}
	console.log("room-signed-out-reconnect smoke: ok");
} catch (error) {
	console.error(serverOutput.join("").slice(-6000));
	throw error;
} finally {
	try { (providers as any).closeAllConnections?.(); } catch {}
	try { providers.close(); } catch {}
	await stopSmokeServer(server);
	fs.rmSync(tempRoot, { recursive: true, force: true });
}
