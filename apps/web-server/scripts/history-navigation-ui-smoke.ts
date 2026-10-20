// Back and Forward, in the browser: they move between Home, a room and
// Maintain as on a normal website, each screen has its own address, and a
// reload on a room's address opens that room again.
//
// Offline: no model is called; the room's model points at a closed port.
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { SMOKE_AUTH_TOKEN, SMOKE_SERVER_AUTH_ENV, SMOKE_SERVER_SPAWN_TREE_OPTIONS, smokeHomeEnv, stopSmokeServer, freePort } from "./smoke-server-process.js";

function assert(condition: unknown, message: string): asserts condition {
	if (!condition) throw new Error(message);
}

{
	const p = typeof chromium?.executablePath === "function" ? chromium.executablePath() : "";
	if (!p || !fs.existsSync(p)) {
		console.log("history navigation ui smoke skipped (Chromium not installed)");
		process.exit(0);
	}
}

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const webServerDir = path.resolve(scriptDir, "..");
const repoRoot = path.resolve(webServerDir, "..", "..");
const port = await freePort();
const baseUrl = `http://127.0.0.1:${port}`;

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "exxperts-history-ui-"));
const tempHome = path.join(tempRoot, "home");
const agentsRoot = path.join(tempHome, ".exxperts", "app", "personalized-agents");
const agentDir = path.join(tempHome, ".exxperts", "agent");
const appDir = path.join(tempHome, ".exxperts", "app");
for (const dir of [agentsRoot, agentDir]) fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
process.env.HOME = tempHome;
process.env.USERPROFILE = tempHome;
process.env.EXXPERTS_CODING_AGENT_DIR = agentDir;
process.env.EXXETA_PERSISTENT_AGENTS_ROOT = agentsRoot;

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
	fs.writeFileSync(path.join(agentDir, "models.json"), JSON.stringify({
		providers: { "fake-gpt": { name: "Fake GPT", baseUrl: "http://127.0.0.1:9/v1", api: "openai-completions", models: [{ id: "gpt-fake", name: "GPT Fake", input: ["text"], contextWindow: 128000, maxTokens: 16000 }] } },
	}, null, 2), { mode: 0o600 });
	fs.writeFileSync(path.join(agentDir, "auth.json"), JSON.stringify({ "fake-gpt": { type: "api_key", key: "synthetic-gpt" } }, null, 2), { mode: 0o600 });
	fs.writeFileSync(path.join(appDir, "custom-ai-profiles.json"), JSON.stringify({ version: 1, profiles: [
		{ id: "custom-fake-gpt", providerId: "fake-gpt", label: "Fake GPT", roomModels: ["gpt-fake"], learnModel: "gpt-fake", reviewMemoryModel: "gpt-fake" },
	] }, null, 2), { mode: 0o600 });
	fs.writeFileSync(path.join(appDir, "persistent-agent-ai-profile.json"), JSON.stringify({ profileId: "custom-fake-gpt" }, null, 2), { mode: 0o600 });

	const agents = await import("../src/persistent-agents.js");
	const roomModels = await import("../src/room-models.js");
	const agentId = agents.createPersistentAgentFromScaffoldInput({ displayName: "History Room", userName: "Synthetic User", preferredUserAddress: "Synthetic User" }).agent.agentId;
	roomModels.writeRoomModels(agentId, { conversation: { provider: "fake-gpt", model: "gpt-fake" } });
	// One remembered conversation, so Maintain has something to do.
	const instance = agents.createPersistentAgentInstance(agentId);
	const l1bPath = instance.l1bCurrentPath(instance.readAgentJson());
	const base = fs.readFileSync(l1bPath, "utf-8");
	const at = /^##\s+Recent Context\s*$/m.exec(base);
	assert(at?.index != null, "the scaffold holds Recent Context");
	fs.writeFileSync(l1bPath, `${base.slice(0, at.index + at[0].length)}\n\n### RC-0001 | OPEN | 2026-09-18 | The launch\n\n**Session arc:** We planned the launch.\n\n**Body:**\n- The launch moves to May.\n\n**Parked:**\nNone\n`, "utf-8");

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
		await page.goto(`${baseUrl}/auth/session?token=${SMOKE_AUTH_TOKEN}`);
		await page.waitForLoadState("networkidle");
		const dismiss = page.locator(".whats-new-close");
		if (await dismiss.count()) await dismiss.click();
		const card = page.locator(".persistent-agent-card").filter({ hasText: "History Room" });
		const composer = page.locator("textarea").first();
		const hash = () => page.evaluate(() => window.location.hash);
		const onHome = async () => (await card.count()) > 0 && (await card.isVisible());
		const inRoom = async () => (await composer.count()) > 0 && (await composer.isVisible()) && !(await onHome());

		// Home, then the room: the room has its own address.
		await card.waitFor({ timeout: 20000 });
		await card.getByRole("button", { name: "Enter →" }).click();
		await waitUntil(inRoom, "the room is open");
		assert((await hash()) === `#/room/${agentId}`, `the room's address names it, got ${await hash()}`);
		console.log("  ok  a room has its own address");

		// Back to Home, Forward into the room again.
		await page.goBack();
		await waitUntil(onHome, "Back returns to Home");
		await page.goForward();
		await waitUntil(inRoom, "Forward opens the room again");
		assert((await hash()) === `#/room/${agentId}`, `Forward lands on the room's address, got ${await hash()}`);
		console.log("  ok  Back returns to Home, and Forward opens the room again");

		// A reload on the room's address opens the room, with no Home shown on the way.
		await page.addInitScript(() => {
			(window as any).__homeShown = false;
			(window as any).__openingLines = [];
			new MutationObserver(() => {
				if (document.querySelector(".persistent-agent-card")) (window as any).__homeShown = true;
				const opening = document.querySelector(".app-opening-room");
				if (opening) (window as any).__openingLines.push(opening.textContent ?? "");
			}).observe(document, { childList: true, subtree: true, characterData: true });
		});
		await page.reload({ waitUntil: "domcontentloaded" });
		await waitUntil(inRoom, "a reload on the room's address opens the room");
		assert(!(await page.evaluate(() => (window as any).__homeShown)), "Home is not shown for a moment before the room opens");
		const openingLines: string[] = await page.evaluate(() => (window as any).__openingLines);
		assert(openingLines.length > 0 && openingLines.every((line) => /^Opening (the room|.+)…$/.test(line)), `while the room opens, the page says so, never blank, got ${JSON.stringify(openingLines)}`);
		console.log("  ok  a reload on a room's address opens that room, with no Home on the way");

		// Home, then Maintain, then Back: Maintain closes, as on a website.
		await page.goBack();
		await waitUntil(onHome, "Back from the reloaded room returns to Home");
		await card.getByRole("button", { name: "Maintain", exact: true }).click();
		await waitUntil(async () => (await hash()) === `#/maintain/${agentId}`, "Maintain has its own address");
		const maintainOpen = async () => (await page.locator(".maintain-action-title").count()) > 0;
		assert(await maintainOpen(), "Maintain is open");
		await page.goBack();
		await waitUntil(async () => !(await maintainOpen()) && (await onHome()), "Back closes Maintain and returns to Home");
		await page.goForward();
		await waitUntil(maintainOpen, "Forward opens Maintain again");
		console.log("  ok  Back and Forward close and open Maintain");
		await ctx.close();
	} finally {
		await browser.close();
	}
	console.log("history-navigation-ui smoke: ok");
} catch (error) {
	console.error(serverOutput.join("").slice(-4000));
	throw error;
} finally {
	await stopSmokeServer(server);
	fs.rmSync(tempRoot, { recursive: true, force: true });
}
