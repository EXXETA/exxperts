// Two windows on one room, in the browser: once one window moves the room to
// a new conversation, the other never shows the engine's refusal. A message
// typed there stays in the box with a plain line and Reload, Remember there
// says the same, and Reload joins the room's new conversation (it does not
// retire it under the window that shows it), where the message goes out.
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { authedFetch, SMOKE_AUTH_TOKEN, SMOKE_SERVER_AUTH_ENV, SMOKE_SERVER_SPAWN_TREE_OPTIONS, smokeHomeEnv, stopSmokeServer, freePort } from "./smoke-server-process.js";

function assert(condition: unknown, message: string): asserts condition {
	if (!condition) throw new Error(message);
}

// A machine without Chromium cannot run a browser assertion at all; skip
// whole, the same way remote-settings-readonly-smoke does.
{
	const p = typeof chromium?.executablePath === "function" ? chromium.executablePath() : "";
	if (!p || !fs.existsSync(p)) {
		console.log("two window room ui smoke skipped (Chromium not installed)");
		process.exit(0);
	}
}

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const webServerDir = path.resolve(scriptDir, "..");
const repoRoot = path.resolve(webServerDir, "..", "..");
const port = await freePort();
const baseUrl = `http://127.0.0.1:${port}`;

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "exxperts-two-window-ui-"));
const tempHome = path.join(tempRoot, "home");
const agentsRoot = path.join(tempHome, ".exxperts", "app", "personalized-agents");
const agentDir = path.join(tempHome, ".exxperts", "agent");
const appDir = path.join(tempHome, ".exxperts", "app");
for (const dir of [agentsRoot, agentDir]) fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
process.env.HOME = tempHome;
process.env.USERPROFILE = tempHome;
process.env.EXXPERTS_CODING_AGENT_DIR = agentDir;
process.env.EXXETA_PERSISTENT_AGENTS_ROOT = agentsRoot;

const CLAUDE = { provider: "fake-claude", model: "claude-fake" };
const requests: Array<{ model: string }> = [];

function sse(res: http.ServerResponse, event: string | null, payload: unknown): void {
	res.write(`${event ? `event: ${event}\n` : ""}data: ${JSON.stringify(payload)}\n\n`);
}

// Two synthetic providers: one speaks the Anthropic stream, one the OpenAI one.
const providers = http.createServer((req, res) => {
	let raw = "";
	req.on("data", (chunk) => { raw += chunk; });
	req.on("end", () => {
		const body = JSON.parse(raw || "{}");
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
const MOVED = "This room went on in another window. Reload to continue there.";

try {
	await new Promise<void>((resolve) => providers.listen(0, "127.0.0.1", resolve));
	const providerPort = (providers.address() as AddressInfo).port;
	fs.writeFileSync(path.join(agentDir, "models.json"), JSON.stringify({
		providers: {
			"fake-claude": { name: "Fake Claude", baseUrl: `http://127.0.0.1:${providerPort}`, api: "anthropic-messages", models: [{ id: "claude-fake", name: "Claude Fake", input: ["text"], contextWindow: 200000, maxTokens: 32000 }] },
		},
	}, null, 2), { mode: 0o600 });
	fs.writeFileSync(path.join(agentDir, "auth.json"), JSON.stringify({ "fake-claude": { type: "api_key", key: "synthetic-claude" } }, null, 2), { mode: 0o600 });
	fs.writeFileSync(path.join(appDir, "custom-ai-profiles.json"), JSON.stringify({ version: 1, profiles: [
		{ id: "custom-fake-claude", providerId: "fake-claude", label: "Fake Claude", roomModels: ["claude-fake"], learnModel: "claude-fake", reviewMemoryModel: "claude-fake" },
	] }, null, 2), { mode: 0o600 });
	fs.writeFileSync(path.join(appDir, "persistent-agent-ai-profile.json"), JSON.stringify({ profileId: "custom-fake-claude" }, null, 2), { mode: 0o600 });

	const agents = await import("../src/persistent-agents.js");
	const roomModels = await import("../src/room-models.js");
	const agentId = agents.createPersistentAgentFromScaffoldInput({ displayName: "Two Window Room", userName: "Synthetic User", preferredUserAddress: "Synthetic User" }).agent.agentId;
	roomModels.writeRoomModels(agentId, { conversation: CLAUDE });

	server = spawn("npx", ["tsx", "src/index.ts"], {
		shell: process.platform === "win32",
		...SMOKE_SERVER_SPAWN_TREE_OPTIONS,
		cwd: webServerDir,
		env: smokeHomeEnv(tempHome, { PORT: String(port), ...SMOKE_SERVER_AUTH_ENV, EXXETA_HOME: repoRoot, EXXPERTS_CODING_AGENT_DIR: agentDir, EXXETA_PERSISTENT_AGENTS_ROOT: agentsRoot }) as NodeJS.ProcessEnv,
	});
	server.stdout.on("data", (chunk) => serverOutput.push(String(chunk)));
	server.stderr.on("data", (chunk) => serverOutput.push(String(chunk)));
	await waitUntil(() => fetch(`${baseUrl}/healthz`).then((r) => r.ok).catch(() => false), "server ready");
	const activeThread = async () => String(((await (await authedFetch(`${baseUrl}/api/persistent-agents/${agentId}/status`)).json()) as { runtime?: { activeThreadId?: string } }).runtime?.activeThreadId ?? "");

	const browser = await chromium.launch();
	try {
		const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
		const a = await ctx.newPage();
		await a.goto(`${baseUrl}/auth/session?token=${SMOKE_AUTH_TOKEN}`);
		await a.waitForLoadState("networkidle");
		const dismiss = a.locator(".whats-new-close");
		if (await dismiss.count()) await dismiss.click();
		await a.locator(".persistent-agent-card").filter({ hasText: "Two Window Room" }).getByRole("button", { name: "Enter →" }).click();
		const composerA = a.locator("textarea").first();
		await composerA.fill("First question.");
		// The title stays quiet during a socket swap; only enabled means this draft can be sent.
		await a.locator('button[aria-label="Send"]:enabled').first().waitFor({ timeout: 15000 });
		await composerA.press("Enter");
		await a.getByText("Answer from claude-fake.").first().waitFor({ timeout: 20000 });
		const first = await activeThread();
		// Window B reads the conversation from disk: wait until the first exchange is saved there.
		await waitUntil(async () => JSON.stringify(await (await authedFetch(`${baseUrl}/api/persistent-agents/${agentId}/threads/${first}`)).json()).includes("Answer from claude-fake."), "the first exchange is saved");

		// Window B opens the room by its address and moves it on: Forget starts a fresh conversation.
		const b = await ctx.newPage();
		await b.goto(`${baseUrl}/#/room/${agentId}`);
		await b.locator('button[title="Send"]').first().waitFor({ timeout: 15000 });
		await b.getByText("First question.").first().waitFor({ timeout: 30000 });
		await b.waitForTimeout(800);
		await b.getByRole("button", { name: "Forget" }).click();
		await b.getByRole("button", { name: "Forget", exact: true }).last().click();
		await waitUntil(async () => { const now = await activeThread(); return !!now && now !== first; }, "the room is on a new conversation");
		const moved = await activeThread();
		await b.waitForTimeout(1500);

		// Window A still shows the old conversation: a message typed there stays in the box with the plain line.
		const typed = "Typed in the old window.";
		await composerA.fill(typed);
		await a.locator('button[aria-label="Send"]:enabled').first().waitFor({ timeout: 15000 });
		await composerA.press("Enter");
		await a.getByText(MOVED).first().waitFor({ timeout: 10000 }).catch(async (error) => { throw new Error(`the plain line did not show; the room reads: ${(await a.locator("main").innerText()).slice(-300)}`, { cause: error }); });
		const pageText = await a.locator("body").innerText();
		assert(!/activeThread|persistent-agent/.test(pageText), `no engine words in the room, got ${pageText.slice(-400)}`);
		assert(await composerA.inputValue() === typed, `the typed message stays in the box, got ${JSON.stringify(await composerA.inputValue())}`);
		const shownAsSent = await a.getByText(typed, { exact: true }).evaluateAll((els) => els.filter((el) => el.tagName !== "TEXTAREA").map((el) => el.outerHTML.slice(0, 200)));
		assert(shownAsSent.length === 0, `the message is not shown as sent, got ${JSON.stringify(shownAsSent)}`);
		assert(await a.getByRole("button", { name: "Reload" }).count() === 1, "the line offers Reload");

		// Reload joins the room's new conversation, keeps the message, and sends it there.
		await a.getByRole("button", { name: "Reload" }).click();
		await waitUntil(async () => (await a.getByText(MOVED).count()) === 0, "the line goes after Reload");
		assert(await activeThread() === moved, "Reload does not retire the conversation the other window shows");
		assert(await a.locator("textarea").first().inputValue() === typed, `the message is still in the box after Reload, got ${JSON.stringify(await a.locator("textarea").first().inputValue())}`);
		assert(await a.getByText("First question.").count() === 0, "window A now shows the room's new conversation");
		await a.locator('button[aria-label="Send"]:enabled').first().waitFor({ timeout: 15000 });
		await a.locator("textarea").first().press("Enter");
		await a.getByText("Answer from claude-fake.").first().waitFor({ timeout: 20000 });
		assert(await activeThread() === moved, "the message went out in the room's new conversation");

		// A third window moves the room on again: Remember in window A says the same line, never that it stopped unexpectedly.
		await waitUntil(async () => JSON.stringify(await (await authedFetch(`${baseUrl}/api/persistent-agents/${agentId}/threads/${moved}`)).json()).includes(typed), "window A's message is saved");
		const c = await ctx.newPage();
		await c.goto(`${baseUrl}/#/room/${agentId}`);
		await c.getByText(typed).first().waitFor({ timeout: 15000 });
		await c.locator('button[title="Send"]').first().waitFor({ timeout: 15000 });
		await c.waitForTimeout(800);
		await c.getByRole("button", { name: "Forget" }).click();
		await c.getByRole("button", { name: "Forget", exact: true }).last().click();
		await waitUntil(async () => { const now = await activeThread(); return !!now && now !== moved; }, "the room is on a third conversation");
		await a.waitForTimeout(1000);
		assert(await a.getByText(MOVED).count() === 0, "window A has not been told yet");
		await a.getByRole("button", { name: "Remember", exact: true }).click();
		await a.getByText(MOVED).first().waitFor({ timeout: 10000 });
		await a.waitForTimeout(1000);
		assert(await a.getByText(/Remember stopped unexpectedly/).count() === 0 && await a.locator(".checkpoint-preview-actions").count() === 0, "Remember in the old window closes with the plain line");
		await ctx.close();
	} finally {
		await browser.close();
	}
	console.log("two-window-room-ui smoke: ok");
} catch (error) {
	console.error(serverOutput.join("").slice(-6000));
	throw error;
} finally {
	try { (providers as any).closeAllConnections?.(); } catch {}
	try { providers.close(); } catch {}
	await stopSmokeServer(server);
	fs.rmSync(tempRoot, { recursive: true, force: true });
}
