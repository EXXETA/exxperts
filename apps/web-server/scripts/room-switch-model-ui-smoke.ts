// Switching the open conversation's model from inside the room, in the
// browser: the room keeps its one socket (no second dial when the model
// changes), the transcript shows the server's "Continued on" line once, and
// the conversation saved on disk holds exactly one such line. The next
// message goes out on the new model over the same socket.
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
		console.log("room switch model ui smoke skipped (Chromium not installed)");
		process.exit(0);
	}
}

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const webServerDir = path.resolve(scriptDir, "..");
const repoRoot = path.resolve(webServerDir, "..", "..");
const port = 27000 + Math.floor(Math.random() * 10000);
const baseUrl = `http://127.0.0.1:${port}`;

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "exxperts-switch-ui-"));
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
	const agentId = agents.createPersistentAgentFromScaffoldInput({ displayName: "Switch UI Room", userName: "Synthetic User", preferredUserAddress: "Synthetic User" }).agent.agentId;
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

		await page.locator(".persistent-agent-card").filter({ hasText: "Switch UI Room" }).getByRole("button", { name: "Enter →" }).click();
		const composer = page.locator("textarea").first();
		await composer.waitFor({ timeout: 15000 });
		// Send waits for the room's socket; its title says when it is there.
		await page.locator('button[title="Send"]').first().waitFor({ timeout: 15000 });
		await page.waitForTimeout(800);
		await composer.fill("First question on Claude.");
		await composer.press("Enter");
		await page.getByText("Answer from claude-fake.").waitFor({ timeout: 20000 });
		const status = await (await authedFetch(`${baseUrl}/api/persistent-agents/${agentId}/status`)).json() as { runtime?: { activeThreadId?: string } };
		const conversationId = String(status.runtime?.activeThreadId ?? "");
		assert(conversationId, "the room has an open conversation");
		// Entering dials (and may dial once more as the new conversation is
		// saved); what counts is that nothing after this point dials again.
		await page.waitForTimeout(1200);
		const dialsBefore = roomDials.length;
		assert(dialsBefore >= 1, "the room has its socket");

		// Room settings, Model: pick GPT, then carry the open conversation over.
		await page.getByRole("button", { name: "Room settings" }).click();
		await page.waitForSelector(".settings-dialog", { timeout: 10000 });
		await page.locator(".settings-dialog-nav-item").filter({ hasText: /^Model$/ }).first().click();
		await page.locator(".room-settings-section:not([hidden]) .room-model-row").first().locator(".room-model-pick").click();
		await page.locator(".room-model-option").filter({ hasText: "GPT Fake" }).click();
		const switchButton = page.getByRole("button", { name: "Switch the open conversation too" });
		await switchButton.waitFor({ timeout: 10000 });
		await switchButton.click();
		await page.waitForSelector(".settings-dialog", { state: "detached", timeout: 10000 });
		await page.getByText("Continued on GPT Fake", { exact: true }).waitFor({ timeout: 10000 });
		await page.waitForTimeout(1500);
		assert(roomDials.length === dialsBefore, `the switch keeps the room's socket, got ${roomDials.length - dialsBefore} new dials`);
		assert((await page.getByText(/^Continued on /).count()) === 1, `the transcript shows the line once, got ${await page.getByText(/^Continued on /).count()}`);

		// The next message goes out on GPT over the same socket.
		await composer.fill("Second question, now on GPT.");
		await composer.press("Enter");
		await page.getByText("Answer from gpt-fake.").waitFor({ timeout: 20000 });
		assert(requests[requests.length - 1]?.model === "gpt-fake", `the next turn runs on GPT, got ${requests[requests.length - 1]?.model}`);
		assert(roomDials.length === dialsBefore, `still the same socket after the next answer, got ${roomDials.length - dialsBefore} new dials`);

		// The saved conversation holds the line exactly once.
		let saved: Array<{ kind?: string; text?: string }> = [];
		await waitUntil(async () => {
			const body = await (await authedFetch(`${baseUrl}/api/persistent-agents/${agentId}/threads/${conversationId}`)).json() as { thread?: { items?: Array<{ kind?: string; text?: string }> } };
			saved = body.thread?.items ?? [];
			return saved.some((item) => item.kind === "assistant" && /Answer from gpt-fake/.test(String(item.text)));
		}, "the conversation is saved with the second answer");
		const lines = saved.filter((item) => item.kind === "system" && /^Continued on /.test(String(item.text)));
		assert(lines.length === 1 && lines[0]!.text === "Continued on GPT Fake", `the saved conversation holds the server's line once, got ${JSON.stringify(lines)}`);
		await ctx.close();
	} finally {
		await browser.close();
	}
	console.log("room-switch-model-ui smoke: ok");
} catch (error) {
	console.error(serverOutput.join("").slice(-6000));
	throw error;
} finally {
	try { (providers as any).closeAllConnections?.(); } catch {}
	try { providers.close(); } catch {}
	await stopSmokeServer(server);
	fs.rmSync(tempRoot, { recursive: true, force: true });
}
