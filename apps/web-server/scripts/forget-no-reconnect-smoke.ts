// Forget in the room, in the browser: the server closes the room's socket as
// part of Forget, and that close is deliberate. No "Connected again." toast
// follows it, and nothing is saved into the forgotten conversation (which the
// server refuses with a 400 once it is closed). A Forget that fails after the
// socket closed reconnects, and a real drop (the server restarts) still
// reconnects and says "Connected again.".
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
		console.log("forget no reconnect smoke skipped (Chromium not installed)");
		process.exit(0);
	}
}

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const webServerDir = path.resolve(scriptDir, "..");
const repoRoot = path.resolve(webServerDir, "..", "..");
const port = 27000 + Math.floor(Math.random() * 10000);
const baseUrl = `http://127.0.0.1:${port}`;

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "exxperts-forget-toast-"));
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

function startServer(): void {
	server = spawn("npx", ["tsx", "src/index.ts"], {
		shell: process.platform === "win32",
		...SMOKE_SERVER_SPAWN_TREE_OPTIONS,
		cwd: webServerDir,
		env: smokeHomeEnv(tempHome, { PORT: String(port), ...SMOKE_SERVER_AUTH_ENV, EXXETA_HOME: repoRoot, EXXPERTS_CODING_AGENT_DIR: agentDir, EXXETA_PERSISTENT_AGENTS_ROOT: agentsRoot }) as NodeJS.ProcessEnv,
	});
	server.stdout.on("data", (chunk) => serverOutput.push(String(chunk)));
	server.stderr.on("data", (chunk) => serverOutput.push(String(chunk)));
}

try {
	await new Promise<void>((resolve) => providers.listen(0, "127.0.0.1", resolve));
	const providerPort = (providers.address() as AddressInfo).port;
	fs.writeFileSync(path.join(agentDir, "models.json"), JSON.stringify({
		providers: {
			"fake-claude": { name: "Fake Claude", baseUrl: `http://127.0.0.1:${providerPort}`, api: "anthropic-messages", models: [{ id: "claude-fake", name: "Claude Fake", input: ["text"], contextWindow: 200000, maxTokens: 32000 }] },
			"fake-gpt": { name: "Fake GPT", baseUrl: `http://127.0.0.1:${providerPort}/v1`, api: "openai-completions", models: [{ id: "gpt-fake", name: "GPT Fake", input: ["text"], contextWindow: 128000, maxTokens: 16000 }] },
		},
	}, null, 2), { mode: 0o600 });
	fs.writeFileSync(path.join(agentDir, "auth.json"), JSON.stringify({ "fake-claude": { type: "api_key", key: "synthetic-claude" }, "fake-gpt": { type: "api_key", key: "synthetic-gpt" } }, null, 2), { mode: 0o600 });
	fs.writeFileSync(path.join(appDir, "custom-ai-profiles.json"), JSON.stringify({ version: 1, profiles: [
		{ id: "custom-fake-claude", providerId: "fake-claude", label: "Fake Claude", roomModels: ["claude-fake"], learnModel: "claude-fake", reviewMemoryModel: "claude-fake" },
		{ id: "custom-fake-gpt", providerId: "fake-gpt", label: "Fake GPT", roomModels: ["gpt-fake"], learnModel: "gpt-fake", reviewMemoryModel: "gpt-fake" },
	] }, null, 2), { mode: 0o600 });
	fs.writeFileSync(path.join(appDir, "persistent-agent-ai-profile.json"), JSON.stringify({ profileId: "custom-fake-claude" }, null, 2), { mode: 0o600 });

	const agents = await import("../src/persistent-agents.js");
	const roomModels = await import("../src/room-models.js");
	const agentId = agents.createPersistentAgentFromScaffoldInput({ displayName: "Forget Room", userName: "Synthetic User", preferredUserAddress: "Synthetic User" }).agent.agentId;
	roomModels.writeRoomModels(agentId, { conversation: CLAUDE });

	startServer();
	await waitUntil(() => fetch(`${baseUrl}/healthz`).then((r) => r.ok).catch(() => false), "server ready");

	const browser = await chromium.launch();
	try {
		const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
		const page = await ctx.newPage();
		const failedSaves: string[] = [];
		page.on("response", async (r) => {
			if (r.request().method() === "PUT" && /\/threads\//.test(r.url()) && r.status() >= 400) failedSaves.push(`${r.status()} ${await r.text().catch(() => "")}`);
		});
		// Keep a handle on the page's sockets, so a Forget that fails after its
		// socket closed can be staged.
		await page.addInitScript(() => {
			const Native = window.WebSocket;
			(window as any).__sockets = [] as WebSocket[];
			(window as any).WebSocket = class extends Native {
				constructor(url: string | URL, protocols?: string | string[]) {
					super(url, protocols);
					(window as any).__sockets.push(this);
				}
			};
		});
		await page.goto(`${baseUrl}/auth/session?token=${SMOKE_AUTH_TOKEN}`);
		await page.waitForLoadState("networkidle");
		const dismiss = page.locator(".whats-new-foot .btn-primary");
		if (await dismiss.count()) await dismiss.click();
		// Every appearance of the toast counts, however briefly it shows.
		await page.evaluate(() => {
			(window as any).__connectedAgain = 0;
			new MutationObserver(() => {
				if (document.body.innerText.includes("Connected again.")) (window as any).__connectedAgain += 1;
			}).observe(document.body, { childList: true, subtree: true, characterData: true });
		});
		const connectedAgain = () => page.evaluate(() => (window as any).__connectedAgain as number);

		await page.locator(".persistent-agent-card").filter({ hasText: "Forget Room" }).getByRole("button", { name: "Enter →" }).click();
		const composer = page.locator("textarea").first();
		await composer.waitFor({ timeout: 15000 });
		await page.locator('button[title="Send"]').first().waitFor({ timeout: 15000 });
		await page.waitForTimeout(800);

		for (let round = 1; round <= 2; round += 1) {
			await composer.fill(`Question ${round}.`);
			await composer.press("Enter");
			await waitUntil(async () => (await page.getByText("Answer from claude-fake.").count()) === 1, `answer ${round}`);
			await page.waitForTimeout(800);
			await page.getByRole("button", { name: "Forget", exact: true }).first().click();
			await page.getByRole("alertdialog").getByRole("button", { name: "Forget", exact: true }).click();
			// The fresh conversation is open and its socket ready.
			await waitUntil(async () => (await page.getByText("Answer from claude-fake.").count()) === 0, `forget ${round} clears the transcript`);
			await page.locator('button[title="Send"]').first().waitFor({ timeout: 15000 });
			await page.waitForTimeout(2500);
			assert(await connectedAgain() === 0, `Forget ${round} shows no "Connected again."`);
			assert(failedSaves.length === 0, `Forget ${round} saves nothing into the forgotten conversation, got ${JSON.stringify(failedSaves)}`);
		}

		// A Forget that fails after the room's socket closed: the room is not
		// left without its reconnect, it dials again and says so.
		await composer.fill("Question 3.");
		await composer.press("Enter");
		await waitUntil(async () => (await page.getByText("Answer from claude-fake.").count()) === 1, "answer 3");
		await page.waitForTimeout(800);
		await page.route("**/memento", async (route) => {
			await page.evaluate(() => { const sockets = (window as any).__sockets as WebSocket[]; sockets[sockets.length - 1]?.close(); });
			await new Promise((resolve) => setTimeout(resolve, 300));
			await route.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ error: "Forgetting failed because of a server error." }) });
		});
		await page.getByRole("button", { name: "Forget", exact: true }).first().click();
		await page.getByRole("alertdialog").getByRole("button", { name: "Forget", exact: true }).click();
		await page.getByText("Forgetting failed because of a server error.").waitFor({ timeout: 10000 });
		await waitUntil(async () => await connectedAgain() > 0, "a failed Forget on a closed socket reconnects", 20_000);
		await page.unroute("**/memento");
		assert(await page.getByText("Answer from claude-fake.").count() === 1, "the conversation is still there after the failed Forget");
		await page.waitForTimeout(6000);
		await page.evaluate(() => { (window as any).__connectedAgain = 0; });

		// A real drop: the server goes away and comes back on the same port.
		await stopSmokeServer(server);
		server = undefined;
		await page.waitForTimeout(1500);
		startServer();
		await waitUntil(() => fetch(`${baseUrl}/healthz`).then((r) => r.ok).catch(() => false), "server back");
		await waitUntil(async () => await connectedAgain() > 0, "a real drop says Connected again.", 40_000);
		await ctx.close();
	} finally {
		await browser.close();
	}
	console.log("forget-no-reconnect smoke: ok");
} catch (error) {
	console.error(serverOutput.join("").slice(-6000));
	throw error;
} finally {
	try { (providers as any).closeAllConnections?.(); } catch {}
	try { providers.close(); } catch {}
	await stopSmokeServer(server);
	fs.rmSync(tempRoot, { recursive: true, force: true });
}
