// The Memory model picker, in the browser: a model too small for this room's
// memory stays in the list, greyed out and not pickable, with its reason and
// one plain line under the list; picking it sends nothing. The defaults for
// new rooms grey out a model too small for a room on the default, naming the
// room. "Default (<model>)" clears the room's own Memory model.
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { authedFetch, SMOKE_AUTH_TOKEN, SMOKE_SERVER_AUTH_ENV, SMOKE_SERVER_SPAWN_TREE_OPTIONS, smokeHomeEnv, stopSmokeServer, freePort } from "./smoke-server-process.js";

function assert(condition: unknown, message: string): asserts condition {
	if (!condition) throw new Error(message);
}

{
	const p = typeof chromium?.executablePath === "function" ? chromium.executablePath() : "";
	if (!p || !fs.existsSync(p)) {
		console.log("memory model picker ui smoke skipped (Chromium not installed)");
		process.exit(0);
	}
}

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const webServerDir = path.resolve(scriptDir, "..");
const repoRoot = path.resolve(webServerDir, "..", "..");
const port = await freePort();
const baseUrl = `http://127.0.0.1:${port}`;

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "exxperts-memory-picker-"));
const tempHome = path.join(tempRoot, "home");
const agentsRoot = path.join(tempHome, ".exxperts", "app", "personalized-agents");
const agentDir = path.join(tempHome, ".exxperts", "agent");
const appDir = path.join(tempHome, ".exxperts", "app");
for (const dir of [agentsRoot, agentDir]) fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
process.env.HOME = tempHome;
process.env.USERPROFILE = tempHome;
process.env.EXXPERTS_CODING_AGENT_DIR = agentDir;
process.env.EXXETA_PERSISTENT_AGENTS_ROOT = agentsRoot;

const ROOM = "Picker Room";
const TOO_SMALL_LINE = "Too small for this room's memory";
const PICKER_LINE = "A Memory model must read all of this room's memory at once. To use a smaller one, lower the memory budget in Memory.";

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
	// No model is ever called: the providers' address answers nothing.
	fs.writeFileSync(path.join(agentDir, "models.json"), JSON.stringify({
		providers: {
			"fake-claude": { name: "Fake Claude", baseUrl: "http://127.0.0.1:9", api: "anthropic-messages", models: [{ id: "claude-fake", name: "Claude Fake", input: ["text"], contextWindow: 200000, maxTokens: 32000 }, { id: "claude-wide", name: "Claude Wide", input: ["text"], contextWindow: 400000, maxTokens: 32000 }] },
			"fake-small": { name: "Fake Small", baseUrl: "http://127.0.0.1:9/v1", api: "openai-completions", models: [{ id: "small-fake", name: "Small Fake", input: ["text"], contextWindow: 16000, maxTokens: 4000 }, { id: "medium-fake", name: "Medium Fake", input: ["text"], contextWindow: 36000, maxTokens: 4000 }] },
		},
	}, null, 2), { mode: 0o600 });
	fs.writeFileSync(path.join(agentDir, "auth.json"), JSON.stringify({ "fake-claude": { type: "api_key", key: "synthetic-claude" }, "fake-small": { type: "api_key", key: "synthetic-small" } }, null, 2), { mode: 0o600 });
	fs.writeFileSync(path.join(appDir, "custom-ai-profiles.json"), JSON.stringify({ version: 1, profiles: [
		{ id: "custom-fake-claude", providerId: "fake-claude", label: "Fake Claude", roomModels: ["claude-fake", "claude-wide"], learnModel: "claude-fake", reviewMemoryModel: "claude-fake" },
		{ id: "custom-fake-small", providerId: "fake-small", label: "Fake Small", roomModels: ["small-fake", "medium-fake"], learnModel: "small-fake", reviewMemoryModel: "small-fake" },
	] }, null, 2), { mode: 0o600 });
	fs.writeFileSync(path.join(appDir, "persistent-agent-ai-profile.json"), JSON.stringify({ profileId: "custom-fake-claude" }, null, 2), { mode: 0o600 });

	const agents = await import("../src/persistent-agents.js");
	const roomModels = await import("../src/room-models.js");
	const agentId = agents.createPersistentAgentFromScaffoldInput({ displayName: ROOM, userName: "Synthetic User", preferredUserAddress: "Synthetic User" }).agent.agentId;
	roomModels.writeRoomModels(agentId, { conversation: { provider: "fake-claude", model: "claude-fake" } });
	roomModels.writeAiDefaults({ memory: { provider: "fake-claude", model: "claude-fake" } });

	server = spawn("npx", ["tsx", "src/index.ts"], {
		shell: process.platform === "win32",
		...SMOKE_SERVER_SPAWN_TREE_OPTIONS,
		cwd: webServerDir,
		env: smokeHomeEnv(tempHome, { PORT: String(port), ...SMOKE_SERVER_AUTH_ENV, EXXETA_HOME: repoRoot, EXXPERTS_CODING_AGENT_DIR: agentDir, EXXETA_PERSISTENT_AGENTS_ROOT: agentsRoot }) as NodeJS.ProcessEnv,
	});
	server.stdout.on("data", (chunk) => serverOutput.push(String(chunk)));
	server.stderr.on("data", (chunk) => serverOutput.push(String(chunk)));
	await waitUntil(() => fetch(`${baseUrl}/healthz`).then((r) => r.ok).catch(() => false), "server ready");

	const roomMemory = async () => ((await (await authedFetch(`${baseUrl}/api/persistent-agents/${agentId}/models`)).json()) as { models: { memory: { stored: { model: string } | null } } }).models.memory;

	const browser = await chromium.launch();
	try {
		const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
		const page = await ctx.newPage();
		const puts: string[] = [];
		page.on("request", (request) => { if (request.method() === "PUT" && /\/models$|\/ai\/defaults$/.test(request.url())) puts.push(request.postData() ?? ""); });
		await page.goto(`${baseUrl}/auth/session?token=${SMOKE_AUTH_TOKEN}`);
		await page.waitForLoadState("networkidle");
		const dismiss = page.locator(".whats-new-close");
		if (await dismiss.count()) await dismiss.click();

		await page.locator(".persistent-agent-card").filter({ hasText: ROOM }).getByRole("button", { name: "Enter →" }).click();
		await page.locator("textarea").first().waitFor({ timeout: 15000 });
		await page.getByRole("button", { name: "Room settings" }).click();
		await page.waitForSelector(".settings-dialog", { timeout: 10000 });
		await page.locator(".settings-dialog-nav-item").filter({ hasText: /^Model$/ }).first().click();
		const memoryRow = page.locator(".room-settings-section:not([hidden]) .room-model-row").nth(1);
		await memoryRow.locator(".room-model-pick").click();

		// 1. The small model stays in the list, greyed out, with its reason and the line.
		const small = page.locator(".room-model-option").filter({ hasText: "Small Fake" });
		await small.waitFor({ timeout: 10000 });
		assert(await small.getAttribute("aria-disabled") === "true", "a model too small for this room's memory is not pickable");
		assert((await small.textContent())?.includes(TOO_SMALL_LINE), `its reason is under its name, got "${await small.textContent()}"`);
		assert(await page.locator(".room-model-menu").getByText(PICKER_LINE, { exact: true }).count() === 1, "the plain line is under the list");
		assert(await page.locator(".room-model-option").filter({ hasText: "Claude Wide" }).getAttribute("aria-disabled") !== "true", "a model that holds the memory is pickable");
		await small.click({ force: true });
		await page.waitForTimeout(500);
		assert(puts.length === 0, `picking a greyed-out model sends nothing, got ${JSON.stringify(puts)}`);

		// 2. The defaults for new rooms: the small model names the room it cannot hold.
		await page.goto(baseUrl);
		await page.waitForLoadState("networkidle");
		await page.locator(".product-sidebar-footer button").first().click();
		await page.locator(".sidebar-config-menu button, .sidebar-config-menu a").filter({ hasText: /Settings/ }).first().click();
		await page.waitForSelector(".settings-overlay", { timeout: 10000 });
		await page.locator(".settings-dialog-nav button").filter({ hasText: "AI setup" }).first().click();
		await page.locator(".settings-overlay .ai-defaults-group .room-model-row").nth(1).locator(".room-model-pick").click();
		const defaultSmall = page.locator(".room-model-option").filter({ hasText: "Small Fake" });
		await defaultSmall.waitFor({ timeout: 10000 });
		assert(await defaultSmall.getAttribute("aria-disabled") === "true", "the defaults grey out a model too small for a room on the default");
		assert((await defaultSmall.textContent())?.includes(`Too small for ${ROOM}'s memory`), `the reason names the room, got "${await defaultSmall.textContent()}"`);
		await defaultSmall.click({ force: true });
		await page.waitForTimeout(500);
		assert(puts.length === 0, `picking a greyed-out default sends nothing, got ${JSON.stringify(puts)}`);
		await page.keyboard.press("Escape");
		assert((await roomMemory()).stored === null, "the room still follows the default");

		// 3. A room with its own Memory model goes back to the default from the picker.
		const own = await authedFetch(`${baseUrl}/api/persistent-agents/${agentId}/models`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ memory: { provider: "fake-claude", model: "claude-wide" } }) });
		assert(own.ok && (await roomMemory()).stored?.model === "claude-wide", `the room has its own Memory model, got ${own.status}`);
		await page.goto(baseUrl);
		await page.waitForLoadState("networkidle");
		await page.locator(".persistent-agent-card").filter({ hasText: ROOM }).getByRole("button", { name: /^(Enter|Resume) →$/ }).click();
		await page.locator("textarea").first().waitFor({ timeout: 15000 });
		await page.getByRole("button", { name: "Room settings" }).click();
		await page.waitForSelector(".settings-dialog", { timeout: 10000 });
		await page.locator(".settings-dialog-nav-item").filter({ hasText: /^Model$/ }).first().click();
		await page.locator(".room-settings-section:not([hidden]) .room-model-row").nth(1).locator(".room-model-pick").click();
		await page.locator(".room-model-option").filter({ hasText: "Default (Claude Fake)" }).click();
		await waitUntil(async () => (await roomMemory()).stored === null, "picking Default clears the room's own Memory model");

		// 4. A raise the room's Memory model cannot hold is refused, and the slider goes back to the saved budget.
		roomModels.writeRoomModels(agentId, { memory: { provider: "fake-small", model: "small-fake" } });
		await page.keyboard.press("Escape");
		await page.waitForSelector(".settings-dialog", { state: "detached", timeout: 10000 });
		await page.getByRole("button", { name: "Room settings" }).click();
		await page.waitForSelector(".settings-dialog", { timeout: 10000 });
		await page.locator(".settings-dialog-nav-item").filter({ hasText: /^Memory$/ }).first().click();
		// The slider is visible but disabled until its saved budget has loaded.
		const slider = page.locator(".room-settings-section:not([hidden]) .memory-budget-slider:enabled");
		await slider.waitFor({ timeout: 10000 });
		const saved = await slider.inputValue();
		assert(saved === "20000", `the fixture's saved budget has loaded, got ${saved}`);
		const refusedSave = page.waitForResponse((response) => response.request().method() === "PUT" && response.url().endsWith(`/api/persistent-agents/${agentId}/maintenance-settings`), { timeout: 10000 });
		await slider.focus();
		await page.keyboard.press("End");
		assert((await refusedSave).status() === 400, "raising the budget beyond the Memory model's capacity is refused");
		await page.locator(".room-settings-section:not([hidden])").getByText(/needs a larger Memory model/).waitFor({ timeout: 10000 });
		await waitUntil(async () => (await slider.inputValue()) === saved, `the slider goes back to the saved ${saved} after the refusal`, 5000);

		// 5. Lowering the budget in the same Room settings: the Model pane's list follows at once (Medium Fake holds 10k, not 20k).
		roomModels.writeRoomModels(agentId, { memory: null });
		await page.keyboard.press("Escape");
		await page.waitForSelector(".settings-dialog", { state: "detached", timeout: 10000 });
		await page.getByRole("button", { name: "Room settings" }).click();
		await page.waitForSelector(".settings-dialog", { timeout: 10000 });
		const openMemoryPicker = async () => {
			await page.locator(".settings-dialog-nav-item").filter({ hasText: /^Model$/ }).first().click();
			await page.locator(".room-settings-section:not([hidden]) .room-model-row").nth(1).locator(".room-model-pick").click();
			const medium = page.locator(".room-model-option").filter({ hasText: "Medium Fake" });
			await medium.waitFor({ timeout: 10000 });
			const disabled = await medium.getAttribute("aria-disabled") === "true";
			await page.locator(".room-settings-section:not([hidden]) .room-model-row").nth(1).locator(".room-model-pick").click();
			return disabled;
		};
		assert(await openMemoryPicker(), "at the 20k budget the medium model is too small");
		await page.locator(".settings-dialog-nav-item").filter({ hasText: /^Memory$/ }).first().click();
		await slider.waitFor({ timeout: 10000 });
		await slider.focus();
		await page.keyboard.press("Home");
		const settingsBudget = async () => ((await (await authedFetch(`${baseUrl}/api/persistent-agents/${agentId}/maintenance-settings`)).json()) as any)?.settings?.memoryBudgetTokens;
		await waitUntil(async () => (await settingsBudget()) === 10000, "the 10k budget is saved", 10000);
		await page.waitForTimeout(800);
		assert(!(await openMemoryPicker()), "after lowering the budget in the same Room settings, the medium model is pickable");
		await ctx.close();
	} finally {
		await browser.close();
	}
	console.log("memory-model-picker-ui smoke: ok");
} catch (error) {
	console.error(serverOutput.join("").slice(-6000));
	throw error;
} finally {
	await stopSmokeServer(server);
	fs.rmSync(tempRoot, { recursive: true, force: true });
}
