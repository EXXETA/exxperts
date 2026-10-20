// A Remember Save that finds its entry already saved, in the browser: when
// another window saved it first, this window goes Home and says so ("Already
// saved in another window."); when this window's own save landed and opening
// the fresh conversation fails, Home keeps the plain "Saved." line; and when
// the first answer to Save was lost on the way back, the page finds it saved
// by itself and shows its saved page. Offline: one synthetic provider.
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
		console.log("remember saved elsewhere smoke skipped (Chromium not installed)");
		process.exit(0);
	}
}

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const webServerDir = path.resolve(scriptDir, "..");
const repoRoot = path.resolve(webServerDir, "..", "..");
const port = await freePort();
const baseUrl = `http://127.0.0.1:${port}`;

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "exxperts-remember-elsewhere-"));
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
let holdRemember = false;
const held: Array<() => void> = [];

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

// One synthetic Anthropic provider. A Remember call waits until the smoke
// releases it, and records whether its stream was closed on it.
const providers = http.createServer((req, res) => {
	let raw = "";
	req.on("data", (chunk) => { raw += chunk; });
	req.on("end", () => {
		const body = JSON.parse(raw || "{}");
		const record: ProviderRequest = { remember: raw.includes("Checkpoint Compression Constitution"), aborted: false };
		requests.push(record);
		res.on("close", () => { if (!res.writableFinished) record.aborted = true; });
		res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
		if (!record.remember) return answer(res, String(body.model), "Answer from claude-fake.");
		if (!holdRemember) return answer(res, String(body.model), PAGE);
		held.push(() => answer(res, String(body.model), PAGE));
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
	const agentId = agents.createPersistentAgentFromScaffoldInput({ displayName: "Remember Room", userName: "Synthetic User", preferredUserAddress: "Synthetic User" }).agent.agentId;
	roomModels.writeRoomModels(agentId, { conversation: CLAUDE });
	const bindId = agents.createPersistentAgentFromScaffoldInput({ displayName: "Bind Room", userName: "Synthetic User", preferredUserAddress: "Synthetic User" }).agent.agentId;
	roomModels.writeRoomModels(bindId, { conversation: CLAUDE });
	const lostId = agents.createPersistentAgentFromScaffoldInput({ displayName: "Lost Room", userName: "Synthetic User", preferredUserAddress: "Synthetic User" }).agent.agentId;
	roomModels.writeRoomModels(lostId, { conversation: CLAUDE });

	startServer();
	await waitUntil(() => fetch(`${baseUrl}/healthz`).then((r) => r.ok).catch(() => false), "server ready");


	const SAVED_HERE = "Saved. Enter the room again from its card.";
	const SAVED_ELSEWHERE = "Already saved in another window. Enter the room again from its card.";
	const browser = await chromium.launch();
	try {
		const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
		const page = await ctx.newPage();
		await page.goto(`${baseUrl}/auth/session?token=${SMOKE_AUTH_TOKEN}`);
		await page.waitForLoadState("networkidle");
		const dismissWhatsNew = async (p: typeof page) => { const dismiss = p.locator(".whats-new-close"); if (await dismiss.count()) await dismiss.click(); };
		await dismissWhatsNew(page);
		const homeLine = page.locator(".home-resume-status");
		const activeConversation = (id: string) => authedFetch(`${baseUrl}/api/persistent-agents/${encodeURIComponent(id)}/status`).then(async (r) => (await r.json()).activeThread?.threadId as string);

		// Enters the room from Home, has one exchange, and opens Remember's review on the entry.
		async function reviewEntry(p: typeof page, room: string): Promise<ReturnType<typeof page.getByRole>> {
			await p.locator(".persistent-agent-card").filter({ hasText: room }).getByRole("button", { name: /^(Enter|Resume) →$/ }).click();
			const composer = p.locator("textarea").first();
			await p.locator('button[title="Send"]').first().waitFor({ timeout: 15000 });
			await p.waitForTimeout(800);
			await composer.fill("We moved the launch to May.");
			await composer.press("Enter");
			await waitUntil(async () => (await p.getByText("Answer from claude-fake.").count()) === 1, `the answer in ${room}`);
			await p.waitForTimeout(800);
			await p.getByRole("button", { name: "Remember", exact: true }).click();
			const dialog = p.getByRole("dialog", { name: "Remember this conversation" });
			await dialog.getByText(POINTS[11]!, { exact: true }).waitFor({ timeout: 20000 });
			return dialog;
		}

		// 1. Two windows show the same entry; the second one saves first.
		const first = await reviewEntry(page, "Remember Room");
		const second = await ctx.newPage();
		await second.goto(page.url());
		await second.waitForLoadState("networkidle");
		await dismissWhatsNew(second);
		const secondDialog = second.getByRole("dialog", { name: "Remember this conversation" });
		if (!(await secondDialog.isVisible().catch(() => false))) {
			await second.locator('button[title="Send"]').first().waitFor({ timeout: 15000 });
			await second.getByRole("button", { name: "Remember", exact: true }).click();
		}
		await secondDialog.getByText(POINTS[11]!, { exact: true }).waitFor({ timeout: 20000 });
		const secondSave = second.waitForResponse((r) => r.url().includes("/checkpoint/approve"));
		await secondDialog.getByRole("button", { name: "Save to memory" }).click();
		assert((await secondSave).ok(), "the second window's Save lands");
		await second.close();
		const firstSave = page.waitForResponse((r) => r.url().includes("/checkpoint/approve"));
		await first.getByRole("button", { name: "Save to memory" }).click();
		assert((await (await firstSave).json()).alreadySaved === true, "the first window's Save finds the entry saved");
		await homeLine.waitFor({ timeout: 15000 });
		assert(await homeLine.innerText() === SAVED_ELSEWHERE, `Home says another window saved it, got ${JSON.stringify(await homeLine.innerText())}`);
		console.log("  ok  a Save that another window made first: Home says it was saved in another window");

		// 2. This window's save lands and only opening the fresh conversation fails.
		const bindDialog = await reviewEntry(page, "Bind Room");
		const bindConversation = await activeConversation(bindId);
		await page.route("**/threads/**", async (route) => {
			const request = route.request();
			if (request.method() === "GET" && !request.url().includes(bindConversation)) return route.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ error: "Synthetic failure." }) });
			return route.continue();
		});
		await bindDialog.getByRole("button", { name: "Save to memory" }).click();
		await homeLine.waitFor({ timeout: 15000 });
		await waitUntil(async () => (await homeLine.innerText()) === SAVED_HERE, `Home keeps the plain saved line when only the fresh conversation failed to open, got ${JSON.stringify(await homeLine.innerText())}`, 10000);
		await page.unroute("**/threads/**");
		console.log("  ok  a save that landed here whose fresh conversation failed to open: Home says Saved");

		// 3. The first answer to this window's Save is lost on the way back; the page finds it saved by itself.
		const lostDialog = await reviewEntry(page, "Lost Room");
		let lost = false;
		await page.route("**/checkpoint/approve", async (route) => {
			if (lost) return route.continue();
			lost = true;
			await route.fetch();
			await route.abort("connectionreset");
		});
		const again = page.waitForResponse((r) => r.url().includes("/checkpoint/approve") && r.status() === 200);
		await lostDialog.getByRole("button", { name: "Save to memory" }).click();
		await waitUntil(() => lost, "the first save reaches the server");
		assert((await (await again).json()).alreadySaved === true, "the page asks again by itself and finds the entry saved");
		// This window's own save: its saved page shows, as after an answer that arrived.
		await lostDialog.getByText("Memory updated").waitFor({ timeout: 15000 });
		await page.unroute("**/checkpoint/approve");
		console.log("  ok  this window's own save whose answer was lost: its saved page shows");
		await ctx.close();
	} finally {
		await browser.close();
	}
	console.log("remember saved elsewhere smoke: ok");
} catch (error) {
	console.error(serverOutput.join("").slice(-6000));
	throw error;
} finally {
	try { (providers as any).closeAllConnections?.(); } catch {}
	try { providers.close(); } catch {}
	await stopSmokeServer(server);
	fs.rmSync(tempRoot, { recursive: true, force: true });
}
