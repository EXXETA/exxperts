// A refused memory budget in Room settings, Memory, in the browser: the red
// line stays only while it is true. Another Memory model picked in Model that
// still cannot hold the refused budget renames it; one that can holds it and
// the line goes; moving the slider again ends it, even when nothing saves.
// The line reads in both themes: at least 4.5:1 against the pane behind it.
// At phone width an info mark never sits alone on a line under its label.
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
		console.log("memory budget refusal ui smoke skipped (Chromium not installed)");
		process.exit(0);
	}
}

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const webServerDir = path.resolve(scriptDir, "..");
const repoRoot = path.resolve(webServerDir, "..", "..");
const port = await freePort();
const baseUrl = `http://127.0.0.1:${port}`;

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "exxperts-budget-refusal-"));
const tempHome = path.join(tempRoot, "home");
const agentsRoot = path.join(tempHome, ".exxperts", "app", "personalized-agents");
const agentDir = path.join(tempHome, ".exxperts", "agent");
const appDir = path.join(tempHome, ".exxperts", "app");
for (const dir of [agentsRoot, agentDir]) fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
process.env.HOME = tempHome;
process.env.USERPROFILE = tempHome;
process.env.EXXPERTS_CODING_AGENT_DIR = agentDir;
process.env.EXXETA_PERSISTENT_AGENTS_ROOT = agentsRoot;

const ROOM = "Budget Room";
const NARROW = { provider: "fake-gpt", model: "narrow-fake" };

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
	// No model is ever called: the provider's address answers nothing. All
	// three hold the 10k budget; Narrow and Mid cannot hold 80k, Wide can.
	fs.writeFileSync(path.join(agentDir, "models.json"), JSON.stringify({
		providers: {
			"fake-gpt": { name: "Fake GPT", baseUrl: "http://127.0.0.1:9/v1", api: "openai-completions", models: [
				{ id: "narrow-fake", name: "Narrow Fake", input: ["text"], contextWindow: 40000, maxTokens: 4000 },
				{ id: "mid-fake", name: "Mid Fake", input: ["text"], contextWindow: 60000, maxTokens: 4000 },
				{ id: "wide-fake", name: "Wide Fake", input: ["text"], contextWindow: 130000, maxTokens: 4000 },
			] },
		},
	}, null, 2), { mode: 0o600 });
	fs.writeFileSync(path.join(agentDir, "auth.json"), JSON.stringify({ "fake-gpt": { type: "api_key", key: "synthetic-gpt" } }, null, 2), { mode: 0o600 });
	fs.writeFileSync(path.join(appDir, "custom-ai-profiles.json"), JSON.stringify({ version: 1, profiles: [
		{ id: "custom-fake-gpt", providerId: "fake-gpt", label: "Fake GPT", roomModels: ["narrow-fake", "mid-fake", "wide-fake"], learnModel: "narrow-fake", reviewMemoryModel: "narrow-fake" },
	] }, null, 2), { mode: 0o600 });
	fs.writeFileSync(path.join(appDir, "persistent-agent-ai-profile.json"), JSON.stringify({ profileId: "custom-fake-gpt" }, null, 2), { mode: 0o600 });

	const agents = await import("../src/persistent-agents.js");
	const roomModels = await import("../src/room-models.js");
	const settings = await import("../src/persistent-room-maintenance-settings.js");
	const agentId = agents.createPersistentAgentFromScaffoldInput({ displayName: ROOM, userName: "Synthetic User", preferredUserAddress: "Synthetic User" }).agent.agentId;
	roomModels.writeRoomModels(agentId, { conversation: NARROW, memory: NARROW });
	settings.writePersistentRoomMaintenanceSettings(agentId, { memoryBudgetTokens: 10_000 });

	server = spawn("npx", ["tsx", "src/index.ts"], {
		shell: process.platform === "win32",
		...SMOKE_SERVER_SPAWN_TREE_OPTIONS,
		cwd: webServerDir,
		env: smokeHomeEnv(tempHome, { PORT: String(port), ...SMOKE_SERVER_AUTH_ENV, EXXETA_HOME: repoRoot, EXXPERTS_CODING_AGENT_DIR: agentDir, EXXETA_PERSISTENT_AGENTS_ROOT: agentsRoot }) as NodeJS.ProcessEnv,
	});
	server.stdout.on("data", (chunk) => serverOutput.push(String(chunk)));
	server.stderr.on("data", (chunk) => serverOutput.push(String(chunk)));
	await waitUntil(() => fetch(`${baseUrl}/healthz`).then((r) => r.ok).catch(() => false), "server ready");

	const roomMemoryModel = async () => ((await (await authedFetch(`${baseUrl}/api/persistent-agents/${agentId}/models`)).json()) as { models: { memory: { stored: { model: string } | null } } }).models.memory.stored?.model;
	const savedBudget = async () => ((await (await authedFetch(`${baseUrl}/api/persistent-agents/${agentId}/maintenance-settings`)).json()) as any)?.settings?.memoryBudgetTokens;

	const browser = await chromium.launch();
	try {
		const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
		const page = await ctx.newPage();
		// The line's contrast against the first painted background behind it, as WCAG reckons it.
		// The checks run as plain source in the page (the transpiler would add helpers the page lacks).
		const lineContrast = () => line.first().evaluate((el, src) => (0, eval)(src)(el), `(el) => {
			// rgb(255, 85, 85) or, from color-mix, color(srgb 1 0.33 0.33 / a).
			const rgb = (c) => { const v = (c.match(/[\\d.]+/g) || []).map(Number); return c.startsWith("color(") ? [v[0] * 255, v[1] * 255, v[2] * 255, v[3]] : v; };
			const lum = (c) => { const [r, g, b] = rgb(c).map((v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; }); return 0.2126 * r + 0.7152 * g + 0.0722 * b; };
			let bg = "rgb(255, 255, 255)";
			for (let node = el; node; node = node.parentElement) { const c = getComputedStyle(node).backgroundColor; const a = rgb(c)[3]; if (c && c !== "transparent" && (a === undefined || a > 0.9)) { bg = c; break; } }
			const [hi, lo] = [lum(getComputedStyle(el).color), lum(bg)].sort((x, y) => y - x);
			return Math.round(((hi + 0.05) / (lo + 0.05)) * 100) / 100;
		}`) as Promise<number>;
		await page.goto(`${baseUrl}/auth/session?token=${SMOKE_AUTH_TOKEN}`);
		await page.waitForLoadState("networkidle");
		const dismiss = page.locator(".whats-new-close");
		if (await dismiss.count()) await dismiss.click();

		await page.locator(".persistent-agent-card").filter({ hasText: ROOM }).getByRole("button", { name: "Enter →" }).click();
		await page.locator("textarea").first().waitFor({ timeout: 15000 });
		await page.getByRole("button", { name: "Room settings" }).click();
		await page.waitForSelector(".settings-dialog", { timeout: 10000 });

		const pane = page.locator(".room-settings-section:not([hidden])");
		const slider = pane.locator(".memory-budget-slider");
		const line = pane.locator(".room-maintenance-error");
		const openPane = (name: string) => page.locator(".settings-dialog-nav-item").filter({ hasText: new RegExp(`^${name}$`) }).first().click();
		const refuse = async (model: string) => {
			await openPane("Memory");
			await slider.waitFor({ timeout: 10000 });
			// The slider is disabled until the pane has read the room's budget.
			await waitUntil(() => slider.isEnabled(), "the slider has the saved budget", 10000);
			await slider.focus();
			await page.keyboard.press("End");
			await line.filter({ hasText: `A memory budget of 80k needs a larger Memory model than ${model}.` }).waitFor({ timeout: 10000 });
			await waitUntil(async () => (await slider.inputValue()) === "10000", "the slider goes back to the saved 10k", 5000);
		};
		const pickMemoryModel = async (name: string, model: string) => {
			await openPane("Model");
			await pane.locator(".room-model-row").nth(1).locator(".room-model-pick").click();
			await page.locator(".room-model-option").filter({ hasText: new RegExp(`^${name}`) }).click();
			await waitUntil(async () => (await roomMemoryModel()) === model, `the room's Memory model is ${name}`);
			await openPane("Memory");
		};

		// 1. Another Memory model that still cannot hold 80k: the line names it, and only it.
		await refuse("Narrow Fake");
		await pickMemoryModel("Mid Fake", "mid-fake");
		await line.filter({ hasText: "A memory budget of 80k needs a larger Memory model than Mid Fake. Choose a larger Memory model in Model first." }).waitFor({ timeout: 10000 });
		assert(await line.count() === 1 && !(await line.innerText()).includes("Narrow Fake"), `one line, naming the new model only, got ${JSON.stringify(await line.allInnerTexts())}`);
		assert(await savedBudget() === 10000, "the check saved nothing");
		for (const theme of ["dark", "light"]) {
			await page.evaluate((value) => { document.documentElement.dataset.theme = value; }, theme);
			const ratio = await lineContrast();
			assert(ratio >= 4.5, `the line reads in the ${theme} theme, got ${ratio}:1`);
		}
		// At phone width an info mark stays on the line of its label's last word, never alone on a line.
		await page.setViewportSize({ width: 390, height: 844 });
		await page.waitForTimeout(400);
		const marks = await pane.locator(".settings-row-label").evaluateAll((labels, src) => (0, eval)(src)(labels), `(labels) => labels.filter((label) => label.querySelector(".rs-info")).map((label) => {
			const walker = document.createTreeWalker(label, NodeFilter.SHOW_TEXT);
			let last = null;
			for (let node = walker.nextNode(); node; node = walker.nextNode()) { if (node.parentElement.closest(".rs-info, .rs-info-tip")) continue; if (node.textContent.trim()) last = node; }
			const range = document.createRange();
			range.setStart(last, Math.max(0, last.textContent.trimEnd().length - 1));
			range.setEnd(last, last.textContent.trimEnd().length);
			const word = range.getBoundingClientRect();
			const mark = label.querySelector(".rs-info").getBoundingClientRect();
			return { label: label.textContent.trim(), together: Math.abs((mark.top + mark.bottom) / 2 - (word.top + word.bottom) / 2) < word.height / 2 };
		})`) as Array<{ label: string; together: boolean }>;
		assert(marks.length >= 2 && marks.every((mark) => mark.together), `every info mark sits on its label's last line at phone width, got ${JSON.stringify(marks)}`);
		await page.setViewportSize({ width: 1280, height: 900 });
		await page.waitForTimeout(300);

		// 2. A Memory model that holds 80k: the line goes.
		await pickMemoryModel("Wide Fake", "wide-fake");
		await waitUntil(async () => (await line.count()) === 0, "the line goes once the Memory model holds the refused budget", 10000);
		assert(await savedBudget() === 10000, "the line going saved nothing either");

		// 3. Refused again on Narrow, then the slider moves and comes back before
		// anything saves: the line goes with the move.
		await pickMemoryModel("Narrow Fake", "narrow-fake");
		await refuse("Narrow Fake");
		await slider.focus();
		await page.keyboard.press("ArrowRight");
		await page.keyboard.press("ArrowLeft");
		await page.waitForTimeout(1200);
		assert(await line.count() === 0, `moving the slider again ends the line, got ${JSON.stringify(await line.allInnerTexts())}`);
		assert(await slider.inputValue() === "10000" && await savedBudget() === 10000, "the slider is back at the saved 10k and nothing saved");
		await ctx.close();
	} finally {
		await browser.close();
	}
	console.log("memory-budget-refusal-ui smoke: ok");
} catch (error) {
	console.error(serverOutput.join("").slice(-6000));
	throw error;
} finally {
	await stopSmokeServer(server);
	fs.rmSync(tempRoot, { recursive: true, force: true });
}
