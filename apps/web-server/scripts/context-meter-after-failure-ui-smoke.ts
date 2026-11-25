// The context meter in a room's page after an answer that moved no usage, in
// the browser against a real spawned server and a synthetic gateway: the pill
// and its popover show one reading, the conversation's current one.
// - After an answer that fails part way, and after one the person stops, the
//   message that stays above is in it.
// - A message handed back to the box has left it: the number before it stays.
// - An unknown reading is a dash, never the old number.
// In none of them does the popover count a turn or a cost, and after a good
// answer it counts one.
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import { fileURLToPath } from "node:url";
import { chromium, type Browser, type Page } from "playwright";
import { routePageSocket, type PageSocket } from "./page-socket.js";
import { closeBrowser } from "./smoke-close-context.js";
import { SMOKE_AUTH_TOKEN, SMOKE_SERVER_AUTH_ENV, SMOKE_SERVER_SPAWN_TREE_OPTIONS, smokeHomeEnv, stopSmokeServer, freePort } from "./smoke-server-process.js";
import { sendFromBox, waitEvery } from "./smoke-wait.js";

const waitUntil = waitEvery(100, 15_000);

function assert(condition: unknown, message: string): asserts condition {
	if (!condition) throw new Error(message);
}

// A machine without Chromium cannot run a browser assertion at all; skip whole.
{
	const p = typeof chromium?.executablePath === "function" ? chromium.executablePath() : "";
	if (!p || !fs.existsSync(p)) {
		console.log("context meter after failure ui smoke skipped (Chromium not installed)");
		process.exit(0);
	}
}

const webServerDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = path.resolve(webServerDir, "..", "..");
const port = await freePort();
const baseUrl = `http://127.0.0.1:${port}`;
const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "exxperts-meter-ui-"));
const tempHome = path.join(tempRoot, "home");
const appDir = path.join(tempHome, ".exxperts", "app");
const agentsRoot = path.join(appDir, "personalized-agents");
const agentDir = path.join(tempHome, ".exxperts", "agent");
for (const dir of [agentsRoot, agentDir]) fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
process.env.HOME = tempHome;
process.env.USERPROFILE = tempHome;
process.env.EXXPERTS_CODING_AGENT_DIR = agentDir;
process.env.EXXETA_PERSISTENT_AGENTS_ROOT = agentsRoot;

const MODEL = { provider: "fake-gpt", model: "gpt-fake" };
// 1,240 tokens of the 80,000 recommended for a 200K window.
const GOOD_PERCENT = "2%";
// 60,000 characters, counted as 15,000 tokens: with the good answer's, 20% and a little.
const LONG_TEXT = "word ".repeat(12_000);

const gateway = http.createServer((req, res) => {
	let raw = "";
	req.on("data", (chunk) => { raw += chunk; });
	req.on("end", () => {
		const body = JSON.parse(raw || "{}");
		const last = [...(body.messages ?? [])].reverse().find((message: any) => message.role === "user");
		const asked = JSON.stringify(last?.content ?? "");
		if (asked.includes("FAILS-AT-ONCE")) {
			res.writeHead(400, { "content-type": "application/json" });
			res.end(JSON.stringify({ error: { message: "the request is odd", type: "invalid_request_error" } }));
			return;
		}
		const sse = (payload: unknown) => res.write(`data: ${JSON.stringify(payload)}\n\n`);
		res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
		const base = { id: "cmpl_smoke", object: "chat.completion.chunk", created: Math.floor(Date.now() / 1000), model: body.model };
		const partial = asked.includes("FAILS-MIDWAY") || asked.includes("STOPPED");
		sse({ ...base, choices: [{ index: 0, delta: { role: "assistant", content: partial ? "Some words." : "A short answer." }, finish_reason: null }] });
		if (asked.includes("FAILS-MIDWAY")) {
			sse({ error: { message: "the request is odd", type: "invalid_request_error" } });
			res.end();
			return;
		}
		// Stopped by the person: the connection closes with the answer still open.
		if (asked.includes("STOPPED")) return;
		sse({ ...base, choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 1_200, completion_tokens: 40, total_tokens: 1_240 } });
		res.write("data: [DONE]\n\n");
		res.end();
	});
});

let server: ChildProcessWithoutNullStreams | undefined;
let browser: Browser | undefined;
const serverOutput: string[] = [];
const failures: string[] = [];
let passes = 0;

try {
	await new Promise<void>((resolve) => gateway.listen(0, "127.0.0.1", resolve));
	const write = (file: string, value: unknown) => fs.writeFileSync(file, JSON.stringify(value), { mode: 0o600 });
	write(path.join(agentDir, "models.json"), { providers: { "fake-gpt": { name: "Fake GPT", baseUrl: `http://127.0.0.1:${(gateway.address() as AddressInfo).port}/v1`, api: "openai-completions", models: [{ id: "gpt-fake", name: "GPT Fake", input: ["text"], contextWindow: 200_000, maxTokens: 16_000, cost: { input: 10, output: 10, cacheRead: 10, cacheWrite: 10 } }] } } });
	write(path.join(agentDir, "auth.json"), { "fake-gpt": { type: "api_key", key: "synthetic-gpt" } });
	write(path.join(appDir, "custom-ai-profiles.json"), { version: 1, profiles: [{ id: "custom-fake-gpt", providerId: "fake-gpt", label: "Fake GPT", roomModels: ["gpt-fake"], learnModel: "gpt-fake", reviewMemoryModel: "gpt-fake" }] });
	write(path.join(appDir, "persistent-agent-ai-profile.json"), { profileId: "custom-fake-gpt" });
	const agents = await import("../src/persistent-agents.js");
	const roomModels = await import("../src/room-models.js");
	const names = ["Midway Room", "Stopped Room", "Returned Room", "Unknown Room"];
	for (const displayName of names) roomModels.writeRoomModels(agents.createPersistentAgentFromScaffoldInput({ displayName, userName: "Synthetic User", preferredUserAddress: "Synthetic User" }).agent.agentId, { conversation: MODEL });

	server = spawn("npx", ["tsx", "src/index.ts"], {
		shell: process.platform === "win32",
		...SMOKE_SERVER_SPAWN_TREE_OPTIONS,
		cwd: webServerDir,
		env: smokeHomeEnv(tempHome, { PORT: String(port), ...SMOKE_SERVER_AUTH_ENV, EXXETA_HOME: repoRoot, EXXPERTS_CODING_AGENT_DIR: agentDir, EXXETA_PERSISTENT_AGENTS_ROOT: agentsRoot }) as NodeJS.ProcessEnv,
	});
	server.stdout.on("data", (chunk) => serverOutput.push(String(chunk)));
	server.stderr.on("data", (chunk) => serverOutput.push(String(chunk)));
	await waitUntil(() => fetch(`${baseUrl}/healthz`).then((r) => r.ok).catch(() => false), "server ready", 25_000);
	browser = await chromium.launch();

	const pill = (page: Page) => page.locator(".composer-context-pill");
	const pillText = async (page: Page) => (await pill(page).innerText()).trim();
	const typeAndSend = async (page: Page, text: string) => {
		await page.locator("textarea").first().fill(text);
		await sendFromBox(page);
	};
	/** The popover's rows by their label, and its first line; it is closed again after. */
	const popover = async (page: Page): Promise<Record<string, string>> => {
		await pill(page).click();
		const dialog = page.getByRole("dialog", { name: "Context and model details" });
		const rows: Record<string, string> = {};
		for (const line of await dialog.locator(".composer-context-popover-row").all()) rows[(await line.locator("span").innerText()).trim()] = (await line.locator("strong").innerText()).trim();
		if (await dialog.locator(".composer-context-popover-lead").count()) rows.lead = (await dialog.locator(".composer-context-popover-lead").innerText()).trim();
		await page.keyboard.press("Escape");
		return rows;
	};
	/** A room with one good answer said, its pill on the good reading. */
	const openRoom = async (name: string): Promise<{ page: Page; socket: PageSocket; cost: string }> => {
		const context = await browser!.newContext({ viewport: { width: 1280, height: 900 } });
		const page = await context.newPage();
		const socket = await routePageSocket(page);
		await page.goto(`${baseUrl}/auth/session?token=${SMOKE_AUTH_TOKEN}`);
		await page.waitForLoadState("networkidle");
		const dismiss = page.locator(".whats-new-close");
		if (await dismiss.count()) await dismiss.click();
		await page.locator(".persistent-agent-card").filter({ hasText: name }).getByRole("button", { name: "Enter" }).click();
		await page.locator("textarea").first().waitFor({ timeout: 15000 });
		await typeAndSend(page, "A first question.");
		await page.getByText("A short answer.").first().waitFor({ timeout: 20000 });
		await waitUntil(async () => (await pillText(page)) === GOOD_PERCENT, "the pill shows the good answer's reading");
		const rows = await popover(page);
		assert(rows.turns === "1" && rows.context === "1,240 tokens" && rows.cost !== "$0", `the good answer counts one turn and a cost, got ${JSON.stringify(rows)}`);
		return { page, socket, cost: rows.cost! };
	};
	const row = async (label: string, name: string, check: (room: { page: Page; socket: PageSocket; cost: string }) => Promise<void>) => {
		try {
			await check(await openRoom(name));
			passes += 1;
			console.log(`  ok  ${label}`);
		} catch (error) {
			failures.push(label);
			console.error(`  FAILED ${label}: ${(error as Error).message}`);
		}
	};
	/** The pill moved off the good reading, and the popover says the same number, with no turn and no cost more. */
	const assertMessageCounted = async (page: Page, cost: string) => {
		await waitUntil(async () => (await pillText(page)) === "20%", `the pill holds the message, got ${await pillText(page)}`);
		const rows = await popover(page);
		assert(rows.lead === "20% of recommended context" && /^16,\d{3} tokens$/.test(rows.context ?? ""), `the popover shows the pill's reading, got ${JSON.stringify(rows)}`);
		assert(rows.turns === "1" && rows.cost === cost, `no turn and no cost more, got ${JSON.stringify(rows)}`);
	};

	await row("an answer that fails part way: pill and popover hold its message", "Midway Room", async ({ page, cost }) => {
		await typeAndSend(page, `FAILS-MIDWAY ${LONG_TEXT}`);
		await page.locator(".system-line.error").first().waitFor({ timeout: 20000 });
		await assertMessageCounted(page, cost);
	});

	await row("an answer the person stops: pill and popover hold its message", "Stopped Room", async ({ page, cost }) => {
		await typeAndSend(page, `STOPPED ${LONG_TEXT}`);
		await page.getByText("Some words.").first().waitFor({ timeout: 20000 });
		await page.locator(".stop-btn").first().click();
		await assertMessageCounted(page, cost);
	});

	await row("a message handed back to the box: the number before it stays", "Returned Room", async ({ page }) => {
		await typeAndSend(page, `FAILS-AT-ONCE ${LONG_TEXT}`);
		await waitUntil(async () => (await page.locator("textarea").first().inputValue()).startsWith("FAILS-AT-ONCE"), "the message is back in the box");
		await page.locator(".system-line.error").first().waitFor({ timeout: 20000 });
		assert((await pillText(page)) === GOOD_PERCENT, `the pill keeps the number before it, got ${await pillText(page)}`);
		const rows = await popover(page);
		assert(rows.context === "1,240 tokens" && rows.turns === "1", `the popover too, got ${JSON.stringify(rows)}`);
	});

	await row("an unknown reading is a dash in the pill and no number in the popover", "Unknown Room", async ({ page, socket }) => {
		socket.send({ type: "usage_turn", agent: "unknown-room", contextHealth: { tokens: null, contextWindow: 200_000, checkpointTokens: 80_000, checkpointPercent: null, zone: "unknown", source: "runtime-context-usage" } });
		await waitUntil(async () => (await pillText(page)) === "–", "the pill shows the dash");
		const rows = await popover(page);
		assert(rows.context === "appears after the next response" && rows.lead === undefined && rows.turns === "1", `no number and no turn more, got ${JSON.stringify(rows)}`);
	});

	if (failures.length > 0) throw new Error(`${failures.length} of ${names.length} rows failed`);
	console.log(`context-meter-after-failure-ui-smoke: ${passes} checks passed`);
} catch (error) {
	console.error(`context-meter-after-failure-ui-smoke FAILED: ${(error as Error).message}`);
	console.error(serverOutput.join("").slice(-3000));
	process.exitCode = 1;
} finally {
	if (browser) await closeBrowser(browser);
	if (server) await stopSmokeServer(server);
	gateway.closeAllConnections();
	await new Promise<void>((resolve) => gateway.close(() => resolve()));
	fs.rmSync(tempRoot, { recursive: true, force: true });
}
