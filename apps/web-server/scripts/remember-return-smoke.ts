// Remember when the person is not looking: a read that finished while the tab
// was closed shows its entry on return, with no second read; a restart during
// the read says so with Generate again; and a line that asks to Generate again
// has the button for it.
//
// Browser smoke: a real server, a synthetic provider, Chromium.

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
		console.log("remember return smoke skipped (Chromium not installed)");
		process.exit(0);
	}
}

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const webServerDir = path.resolve(scriptDir, "..");
const repoRoot = path.resolve(webServerDir, "..", "..");
const port = 27000 + Math.floor(Math.random() * 10000);
const baseUrl = `http://127.0.0.1:${port}`;

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "exxperts-remember-return-"));
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
let holdRemember = true;
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
		providers: { "fake-claude": { name: "Fake Claude", baseUrl: `http://127.0.0.1:${providerPort}`, api: "anthropic-messages", models: [{ id: "claude-fake", name: "Claude Fake", input: ["text"], contextWindow: 200000, maxTokens: 32000 }] } },
	}, null, 2), { mode: 0o600 });
	fs.writeFileSync(path.join(agentDir, "auth.json"), JSON.stringify({ "fake-claude": { type: "api_key", key: "synthetic-claude" } }, null, 2), { mode: 0o600 });
	fs.writeFileSync(path.join(appDir, "custom-ai-profiles.json"), JSON.stringify({ version: 1, profiles: [
		{ id: "custom-fake-claude", providerId: "fake-claude", label: "Fake Claude", roomModels: ["claude-fake"], learnModel: "claude-fake", reviewMemoryModel: "claude-fake" },
	] }, null, 2), { mode: 0o600 });
	fs.writeFileSync(path.join(appDir, "persistent-agent-ai-profile.json"), JSON.stringify({ profileId: "custom-fake-claude" }, null, 2), { mode: 0o600 });

	const agents = await import("../src/persistent-agents.js");
	const roomModels = await import("../src/room-models.js");
	const agentId = agents.createPersistentAgentFromScaffoldInput({ displayName: "Return Room", userName: "Synthetic User", preferredUserAddress: "Synthetic User" }).agent.agentId;
	roomModels.writeRoomModels(agentId, { conversation: CLAUDE });

	startServer();
	await waitUntil(() => fetch(`${baseUrl}/healthz`).then((r) => r.ok).catch(() => false), "server ready");
	const rememberCalls = () => requests.filter((request) => request.remember).length;

	const browser = await chromium.launch();
	try {
		const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
		let page = await ctx.newPage();
		const open = async (target: typeof page) => {
			await target.goto(`${baseUrl}/auth/session?token=${SMOKE_AUTH_TOKEN}`);
			await target.waitForLoadState("networkidle");
			const dismiss = target.locator(".whats-new-foot .btn-primary");
			if (await dismiss.count()) await dismiss.click();
		};
		const enterRoom = async (target: typeof page) => {
			const card = target.locator(".persistent-agent-card").filter({ hasText: "Return Room" });
			if (!(await target.evaluate(() => window.location.hash)).startsWith("#/room/")) await card.getByRole("button", { name: /^(Enter|Resume) →$/ }).click();
			await waitUntil(async () => (await target.locator("textarea").first().isVisible().catch(() => false)) && !(await card.count()), "the room is open");
			await target.waitForTimeout(800);
		};
		const say = async (target: typeof page, text: string) => {
			const before = await target.getByText("Answer from claude-fake.").count();
			await target.locator("textarea").first().fill(text);
			await target.locator("textarea").first().press("Enter");
			await waitUntil(async () => (await target.getByText("Answer from claude-fake.").count()) > before, "the answer");
			await target.waitForTimeout(800);
		};
		const dialogOf = (target: typeof page) => target.getByRole("dialog", { name: "Remember this conversation" });
		// After a restart the open tab reconnects and takes the room on the new server. A tab closed before that
		// leaves the stopped server's lock, which Home counts as open elsewhere for 90 s, so a step that closes the
		// tab after a restart waits for the reconnect first, read through the list Home reads.
		const reconnectedSince = (restartedAt: number) => waitUntil(async () => {
			const rooms = await authedFetch(`${baseUrl}/api/persistent-agents`).then((r) => r.json()).catch(() => []);
			const lock = (rooms as Array<{ id: string; activeLock?: { acquiredAt: number } | null }>).find((room) => room.id === agentId)?.activeLock;
			return !!lock && lock.acquiredAt >= restartedAt;
		}, "the open tab has reconnected to the restarted server");
		const discard = async (target: typeof page) => {
			await dialogOf(target).getByRole("button", { name: "Discard" }).click();
			await target.getByRole("alertdialog").getByRole("button", { name: "Discard" }).click();
			await dialogOf(target).waitFor({ state: "detached", timeout: 10000 });
		};
		await open(page);
		await enterRoom(page);
		await page.locator('button[title="Send"]').first().waitFor({ timeout: 15000 });
		await say(page, "We moved the launch to May.");

		// 1. The tab closes while Remember reads; the read ends; on return the entry waits, with no second read.
		holdRemember = true;
		await page.getByRole("button", { name: "Remember", exact: true }).click();
		await waitUntil(() => rememberCalls() === 1, "the Remember call reaches the provider");
		await page.close();
		holdRemember = false;
		for (const release of held.splice(0)) release();
		await page.waitForTimeout(0).catch(() => {});
		await new Promise((resolve) => setTimeout(resolve, 2500));
		page = await ctx.newPage();
		await open(page);
		await enterRoom(page);
		await dialogOf(page).getByText("The launch moves to May.").first().waitFor({ timeout: 15000 }).catch(() => { throw new Error("on return the finished entry shows in the room"); });
		assert(rememberCalls() === 1, `the entry kept is shown, with no second read, got ${rememberCalls()} Remember calls`);
		// The editor's Still open is empty when the entry has nothing open, never a raw "None".
		await dialogOf(page).getByRole("button", { name: "Edit", exact: true }).click();
		const stillOpen = dialogOf(page).locator("label").filter({ hasText: "Still open" }).locator("textarea");
		assert(await stillOpen.inputValue() === "", `the editor's Still open is empty, got ${JSON.stringify(await stillOpen.inputValue())}`);
		await dialogOf(page).getByRole("button", { name: "Done editing" }).click();
		console.log("  ok  a Remember that finished while the tab was closed shows on return");

		// 2. The conversation changes after Remember read it: the line has its Generate again, which reads again.
		const other = await ctx.newPage();
		await open(other);
		await other.evaluate((id) => { window.location.hash = `#/room/${id}`; }, agentId);
		await enterRoom(other);
		await say(other, "One more thing: dinner on Saturday.");
		await other.close();
		await dialogOf(page).getByRole("button", { name: "Save to memory" }).click();
		await dialogOf(page).getByText("This conversation changed after Remember read it. Generate again.", { exact: true }).waitFor({ timeout: 15000 });
		const generateAgain = dialogOf(page).getByRole("button", { name: "Generate again" });
		assert(await generateAgain.count() === 1, "the line that says Generate again has its button");
		await generateAgain.click();
		await waitUntil(() => rememberCalls() === 2, "Generate again reads the conversation again");
		await dialogOf(page).getByRole("button", { name: "Save to memory" }).waitFor({ timeout: 15000 });
		await discard(page);
		console.log("  ok  a conversation that changed after the read offers Generate again");

		// 3. The app restarts while Remember reads: the tab that was open, and a room entered afresh, say so with Generate again.
		holdRemember = true;
		await page.getByRole("button", { name: "Remember", exact: true }).click();
		await waitUntil(() => rememberCalls() === 3, "the third Remember call reaches the provider");
		await stopSmokeServer(server);
		held.splice(0);
		const restartedAt = Date.now();
		startServer();
		await waitUntil(() => fetch(`${baseUrl}/healthz`).then((r) => r.ok).catch(() => false), "server ready again");
		holdRemember = false;
		const restarted = "The app restarted while Remember was reading. Generate again to finish.";
		await dialogOf(page).getByText(restarted, { exact: true }).waitFor({ timeout: 30000 }).catch(() => { throw new Error("the open tab says the app restarted while Remember was reading"); });
		assert(await dialogOf(page).getByRole("button", { name: "Generate again" }).count() === 1, "the restart line has its Generate again");
		await reconnectedSince(restartedAt);
		await page.close();
		const fresh = await ctx.newPage();
		await open(fresh);
		await enterRoom(fresh);
		await dialogOf(fresh).getByText(restarted, { exact: true }).waitFor({ timeout: 15000 }).catch(() => { throw new Error("a room entered afresh after the restart says so too"); });
		await dialogOf(fresh).getByRole("button", { name: "Generate again" }).click();
		await dialogOf(fresh).getByRole("button", { name: "Save to memory" }).waitFor({ timeout: 20000 });
		console.log("  ok  a restart during Remember says so, with Generate again, in the open tab and on return");

		// 4. At phone width the sidebar never covers the review, even after "Show sidebar" was chosen on a wide screen.
		await discard(fresh);
		await say(fresh, "We moved the launch to June.");
		await fresh.evaluate(() => localStorage.setItem("exxperts.sidebarCollapsed", "0"));
		await fresh.setViewportSize({ width: 390, height: 844 });
		await fresh.reload({ waitUntil: "domcontentloaded" });
		await fresh.waitForTimeout(1500);
		const dismissPhone = fresh.locator(".whats-new-foot .btn-primary");
		if (await dismissPhone.count()) await dismissPhone.click();
		await fresh.getByRole("button", { name: "Remember", exact: true }).click();
		const save = dialogOf(fresh).getByRole("button", { name: "Save to memory" });
		await save.waitFor({ timeout: 20000 });
		await fresh.waitForTimeout(500);
		const onTop = await save.evaluate((button) => {
			const rect = button.getBoundingClientRect();
			const hit = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
			return hit === button || button.contains(hit);
		});
		assert(onTop, "at 390 px wide the review's Save is on top, not under the sidebar");
		await discard(fresh);
		console.log("  ok  at phone width the review is usable without hiding the sidebar by hand");

		// 5. An entry kept while the tab was closed, and the conversation went on in another tab: entering says so, with
		// Generate again and Discard, never an empty dialog.
		await fresh.setViewportSize({ width: 1280, height: 900 });
		await say(fresh, "We moved the launch to July.");
		holdRemember = true;
		const before5 = rememberCalls();
		await fresh.getByRole("button", { name: "Remember", exact: true }).click();
		await waitUntil(() => rememberCalls() === before5 + 1, "the fifth step's Remember call reaches the provider");
		await fresh.close();
		holdRemember = false;
		for (const release of held.splice(0)) release();
		await new Promise((resolve) => setTimeout(resolve, 2500));
		const writer = await ctx.newPage();
		await open(writer);
		await enterRoom(writer);
		await dialogOf(writer).getByRole("button", { name: "Save to memory" }).waitFor({ timeout: 15000 });
		await writer.keyboard.press("Escape");
		await dialogOf(writer).waitFor({ state: "detached", timeout: 10000 });
		await say(writer, "And the venue moved too.");
		await writer.close();
		const back = await ctx.newPage();
		await open(back);
		await enterRoom(back);
		const changed = "This conversation changed after Remember read it. Generate again.";
		await dialogOf(back).getByText(changed, { exact: true }).waitFor({ timeout: 15000 }).catch(() => { throw new Error("a kept entry the conversation moved past says so on entry"); });
		assert(await dialogOf(back).getByRole("button", { name: "Generate again" }).count() === 1 && await dialogOf(back).getByRole("button", { name: "Discard" }).count() === 1, "its line has Generate again and Discard");
		await dialogOf(back).getByRole("button", { name: "Discard" }).click();
		await dialogOf(back).waitFor({ state: "detached", timeout: 10000 });
		console.log("  ok  a kept entry the conversation moved past says so on entry, with its ways out");

		// 6. The restart line can be let go without a paid read: Discard clears it, and the next entry opens nothing.
		holdRemember = true;
		const before6 = rememberCalls();
		await back.getByRole("button", { name: "Remember", exact: true }).click();
		await waitUntil(() => rememberCalls() === before6 + 1, "the sixth step's Remember call reaches the provider");
		await stopSmokeServer(server);
		held.splice(0);
		const restartedAgainAt = Date.now();
		startServer();
		await waitUntil(() => fetch(`${baseUrl}/healthz`).then((r) => r.ok).catch(() => false), "server ready after the second restart");
		holdRemember = false;
		await dialogOf(back).getByText(restarted, { exact: true }).waitFor({ timeout: 30000 });
		const discardRestart = dialogOf(back).getByRole("button", { name: "Discard" });
		assert(await discardRestart.count() === 1, "the restart line has Discard");
		await discardRestart.click();
		await dialogOf(back).waitFor({ state: "detached", timeout: 10000 });
		await reconnectedSince(restartedAgainAt);
		await back.close();
		const after = await ctx.newPage();
		await open(after);
		await enterRoom(after);
		await after.waitForTimeout(2500);
		assert(await dialogOf(after).count() === 0, "after Discard the next entry opens no dialog");
		assert(rememberCalls() === before6 + 1, `Discard costs no read, got ${rememberCalls() - before6} calls`);
		console.log("  ok  the restart line's Discard lets it go");
		await ctx.close();
	} finally {
		await browser.close();
	}
	console.log("remember return smoke: ok");
} catch (error) {
	console.error(serverOutput.join("").slice(-6000));
	throw error;
} finally {
	for (const release of held.splice(0)) release();
	try { (providers as any).closeAllConnections?.(); } catch {}
	try { providers.close(); } catch {}
	await stopSmokeServer(server);
	fs.rmSync(tempRoot, { recursive: true, force: true });
}
