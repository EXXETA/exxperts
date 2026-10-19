// The room cards on Home, dark theme: a broken room shows its state by its
// badge only, with the same border as a ready room (no tinted border), and so
// does a card whose room is missing. Offline: one synthetic provider.
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
		console.log("home room card look smoke skipped (Chromium not installed)");
		process.exit(0);
	}
}

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const webServerDir = path.resolve(scriptDir, "..");
const repoRoot = path.resolve(webServerDir, "..", "..");
const port = await freePort();
const baseUrl = `http://127.0.0.1:${port}`;

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "exxperts-card-look-"));
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
// Twelve points to keep: the review shows every one of them.
const POINTS = ["The launch moves to May.", ...Array.from({ length: 11 }, (_, i) => `Launch step ${i + 2} is agreed with the team and needs no further review before the launch.`)];
const PAGE = `TITLE:\nThe launch plan\n\nSESSION_ARC:\nWe planned the launch.\n\nBODY:\n${POINTS.map((point) => `- ${point}`).join("\n")}\n\nPARKED:\nNone\n`;
type ProviderRequest = { remember: boolean; aborted: boolean };
const requests: ProviderRequest[] = [];

function sse(res: http.ServerResponse, event: string | null, payload: unknown): void {
	res.write(`${event ? `event: ${event}\n` : ""}data: ${JSON.stringify(payload)}\n\n`);
}

function answer(res: http.ServerResponse, model: string, text: string): void {
	if (res.writableEnded || res.destroyed) return;
	sse(res, "message_start", { type: "message_start", message: { id: `msg_${requests.length}`, type: "message", role: "assistant", model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 100, output_tokens: 1 } } });
	sse(res, "content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } });
	sse(res, "content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text } });
	sse(res, "content_block_stop", { type: "content_block_stop", index: 0 });
	sse(res, "message_delta", { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 20 } });
	sse(res, "message_stop", { type: "message_stop" });
	res.end();
}

// The model's turn on the question: one memory search, held a moment so the
// running step can be seen, then the answer once the result is back.
const QUESTION = "What did we plan for the launch?";
const toolResults: string[] = [];

function searchMemory(res: http.ServerResponse, model: string): void {
	sse(res, "message_start", { type: "message_start", message: { id: `msg_${requests.length}`, type: "message", role: "assistant", model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 100, output_tokens: 1 } } });
	sse(res, "content_block_start", { type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "toolu_recall", name: "memory_recall", input: {} } });
	sse(res, "content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: JSON.stringify({ query: "launch May" }) } });
	setTimeout(() => {
		if (res.writableEnded || res.destroyed) return;
		sse(res, "content_block_stop", { type: "content_block_stop", index: 0 });
		sse(res, "message_delta", { type: "message_delta", delta: { stop_reason: "tool_use", stop_sequence: null }, usage: { output_tokens: 20 } });
		sse(res, "message_stop", { type: "message_stop" });
		res.end();
	}, 2500);
}

// One synthetic Anthropic provider: Remember gets its page, the question gets a
// memory search, and every other turn a plain answer.
const providers = http.createServer((req, res) => {
	let raw = "";
	req.on("data", (chunk) => { raw += chunk; });
	req.on("end", () => {
		const body = JSON.parse(raw || "{}");
		const record: ProviderRequest = { remember: raw.includes("Checkpoint Compression Constitution"), aborted: false };
		requests.push(record);
		res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
		if (record.remember) return answer(res, String(body.model), PAGE);
		const messages: any[] = Array.isArray(body.messages) ? body.messages : [];
		const last = messages[messages.length - 1];
		const results = Array.isArray(last?.content) ? last.content.filter((part: any) => part?.type === "tool_result") : [];
		if (results.length > 0) {
			for (const part of results) toolResults.push(typeof part.content === "string" ? part.content : (part.content ?? []).map((c: any) => c?.text ?? "").join(""));
			return answer(res, String(body.model), "Answer from claude-fake.");
		}
		if (raw.includes(QUESTION)) return searchMemory(res, String(body.model));
		return answer(res, String(body.model), "Answer from claude-fake.");
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
			// An address nothing listens on: a Memory model that is not answering, said at once.
			"fake-dead": { name: "Fake Dead", baseUrl: "http://127.0.0.1:9", api: "anthropic-messages", models: [{ id: "dead-fake", name: "Dead Fake", input: ["text"], contextWindow: 200000, maxTokens: 32000 }] },
		},
	}, null, 2), { mode: 0o600 });
	fs.writeFileSync(path.join(agentDir, "auth.json"), JSON.stringify({ "fake-claude": { type: "api_key", key: "synthetic-claude" }, "fake-dead": { type: "api_key", key: "synthetic-dead" } }, null, 2), { mode: 0o600 });
	fs.writeFileSync(path.join(appDir, "custom-ai-profiles.json"), JSON.stringify({ version: 1, profiles: [
		{ id: "custom-fake-claude", providerId: "fake-claude", label: "Fake Claude", roomModels: ["claude-fake"], learnModel: "claude-fake", reviewMemoryModel: "claude-fake" },
		{ id: "custom-fake-dead", providerId: "fake-dead", label: "Fake Dead", roomModels: ["dead-fake"], learnModel: "dead-fake", reviewMemoryModel: "dead-fake" },
	] }, null, 2), { mode: 0o600 });
	fs.writeFileSync(path.join(appDir, "persistent-agent-ai-profile.json"), JSON.stringify({ profileId: "custom-fake-claude" }, null, 2), { mode: 0o600 });

	const agents = await import("../src/persistent-agents.js");
	const roomModels = await import("../src/room-models.js");
	const agentId = agents.createPersistentAgentFromScaffoldInput({ displayName: "Ready Room", userName: "Synthetic User", preferredUserAddress: "Synthetic User" }).agent.agentId;
	roomModels.writeRoomModels(agentId, { conversation: CLAUDE });
	// A broken room: its own files damaged by hand (the constitution deleted).
	const brokenId = agents.createPersistentAgentFromScaffoldInput({ displayName: "Broken Room", userName: "Synthetic User", preferredUserAddress: "Synthetic User" }).agent.agentId;
	roomModels.writeRoomModels(brokenId, { conversation: CLAUDE });
	fs.rmSync(path.join(agentsRoot, brokenId, "L1a.md"));
	startServer();
	await waitUntil(() => fetch(`${baseUrl}/healthz`).then((r) => r.ok).catch(() => false), "server ready");


	const browser = await chromium.launch();
	try {
		const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, colorScheme: "dark" });
		await ctx.addInitScript(() => { try { localStorage.setItem("exxperts.appearance", "dark"); } catch {} });
		const page = await ctx.newPage();
		await page.goto(`${baseUrl}/auth/session?token=${SMOKE_AUTH_TOKEN}`);
		await page.waitForLoadState("networkidle");
		const dismiss = page.locator(".whats-new-close");
		if (await dismiss.count()) await dismiss.click();
		assert(await page.evaluate(() => document.documentElement.dataset.theme) === "dark", "the page is in the dark theme");
		const ready = page.locator(".persistent-agent-card").filter({ hasText: "Ready Room" });
		const broken = page.locator(".persistent-agent-card.error").filter({ hasText: "Broken Room" });
		await ready.waitFor({ timeout: 15000 });
		await broken.waitFor({ timeout: 15000 });
		const border = (card: typeof ready) => card.evaluate((el) => getComputedStyle(el).borderTopColor);
		const readyBorder = await border(ready);
		assert(await border(broken) === readyBorder, `a broken room's card has the ready card's border, got ${await border(broken)} against ${readyBorder}`);
		// A missing room's card: the same card markup the page draws, read against the page's own styles.
		const missingBorder = await page.evaluate(() => {
			const card = document.createElement("article");
			card.className = "landing-card persistent-agent-card missing";
			document.querySelector(".persistent-agent-card")!.parentElement!.appendChild(card);
			const color = getComputedStyle(card).borderTopColor;
			card.remove();
			return color;
		});
		assert(missingBorder === readyBorder, `a missing room's card has the ready card's border, got ${missingBorder} against ${readyBorder}`);
		console.log("  ok  dark theme: broken and missing room cards keep the ready card's border; the badge carries the state");
		await ctx.close();
	} finally {
		await browser.close();
	}
	console.log("home room card look smoke: ok");
} catch (error) {
	console.error(serverOutput.join("").slice(-6000));
	throw error;
} finally {
	try { (providers as any).closeAllConnections?.(); } catch {}
	try { providers.close(); } catch {}
	await stopSmokeServer(server);
	fs.rmSync(tempRoot, { recursive: true, force: true });
}
