// Closing over an unsaved draft offers to save it. Room settings asks Keep
// editing, Close without saving or Save and close; Save and close runs the
// pane's own save, and a save that fails keeps the dialog open on that pane
// with the pane's error. The Settings overlay's global instructions offer
// Save and leave when moving to another section.
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { authedFetch, SMOKE_AUTH_TOKEN, SMOKE_SERVER_AUTH_ENV, SMOKE_SERVER_SPAWN_TREE_OPTIONS, stopSmokeServer } from "./smoke-server-process.js";

const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), "exxperts-save-and-close-"));
process.env.HOME = tempHome;
process.env.USERPROFILE = tempHome;

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const webServerDir = path.resolve(scriptDir, "..");
const port = 24000 + Math.floor(Math.random() * 10000);
const baseUrl = `http://127.0.0.1:${port}`;

function assert(condition: unknown, message: string): asserts condition {
	if (!condition) throw new Error(message);
}

let server: ChildProcessWithoutNullStreams | null = null;

async function waitForServer(): Promise<void> {
	for (let attempt = 0; attempt < 100; attempt += 1) {
		if (server?.exitCode != null) throw new Error(`server exited before startup with code ${server.exitCode}`);
		try {
			const res = await fetch(`${baseUrl}/healthz`);
			if (res.ok) return;
		} catch { /* not up yet */ }
		await new Promise((resolve) => setTimeout(resolve, 150));
	}
	throw new Error("server did not come up");
}

// A machine without Chromium cannot run a browser assertion at all; skip
// whole, the same way remote-settings-readonly-smoke does.
{
	const p = typeof chromium?.executablePath === "function" ? chromium.executablePath() : "";
	if (!p || !fs.existsSync(p)) {
		console.log("settings save-and-close smoke skipped (Chromium not installed)");
		process.exit(0);
	}
}

const BUSY = "The room is busy with a scheduled task. Save again when it has finished.";

try {
	server = spawn("npx", ["tsx", "src/index.ts"], {
		shell: process.platform === "win32",
		...SMOKE_SERVER_SPAWN_TREE_OPTIONS,
		cwd: webServerDir,
		env: { ...process.env, PORT: String(port), ...SMOKE_SERVER_AUTH_ENV },
		stdio: ["ignore", "pipe", "pipe"],
	}) as unknown as ChildProcessWithoutNullStreams;
	await waitForServer();
	const created = await authedFetch(`${baseUrl}/api/persistent-agents`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ displayName: "Draft Room", userName: "Synthetic User", preferredUserAddress: "Synthetic User" }) });
	assert(created.ok, `room create failed: ${created.status}`);
	const roomId = String(((await created.json()) as { agent?: { id?: string } }).agent?.id ?? "");
	assert(roomId, "the new room has an id");

	const browser = await chromium.launch();
	try {
		const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
		const page = await ctx.newPage();
		await page.goto(`${baseUrl}/auth/session?token=${SMOKE_AUTH_TOKEN}`);
		await page.waitForLoadState("networkidle");
		const dismiss = page.locator(".whats-new-foot .btn-primary");
		if (await dismiss.count()) await dismiss.click();

		// --- Room settings: a draft in Instructions, then Close from another pane.
		await page.locator(".persistent-agent-card").filter({ hasText: "Draft Room" }).locator(".card-gear-btn").click();
		await page.waitForSelector(".settings-dialog", { timeout: 10000 });
		const nav = (label: string) => page.locator(".settings-dialog-nav-item").filter({ hasText: new RegExp(`^${label}$`) }).first();
		await nav("Instructions").click();
		const box = page.locator(".room-settings-section:not([hidden]) .room-instructions-textarea");
		await box.waitFor({ timeout: 10000 });
		await box.fill("Answer in short sentences.");
		await nav("Skills").click();
		await page.locator(".settings-dialog-close").click();

		const question = page.locator(".confirm-dialog-backdrop");
		await question.waitFor({ timeout: 5000 });
		const buttons = await question.locator("button").allInnerTexts();
		assert(JSON.stringify(buttons) === JSON.stringify(["Keep editing", "Close without saving", "Save and close"]), `the question offers three answers in order, got ${JSON.stringify(buttons)}`);
		assert((await question.getByText("The instructions have unsaved changes.", { exact: true }).count()) === 1, "the question names the pane that holds the draft");
		assert((await question.locator(".rs-btn-primary").innerText()) === "Save and close", "Save and close is the primary answer");

		// A save that fails keeps the dialog open on the pane, with its error.
		await page.route("**/api/persistent-agents/*/instructions", (route) =>
			route.request().method() === "PUT"
				? route.fulfill({ status: 409, contentType: "application/json", body: JSON.stringify({ error: BUSY }) })
				: route.continue());
		await question.locator(".rs-btn-primary").click();
		await page.waitForTimeout(600);
		assert((await question.count()) === 0, "the question is answered");
		assert((await page.locator(".settings-dialog").count()) === 1, "a failed save keeps Room settings open");
		assert(await box.isVisible(), "a failed save brings the Instructions pane back");
		assert((await page.locator(".room-settings-section:not([hidden])").getByText(BUSY, { exact: true }).count()) === 1, "the pane shows its own error");
		assert((await box.inputValue()) === "Answer in short sentences.", "the draft stays");

		// Keep editing leaves everything as it is.
		await page.unroute("**/api/persistent-agents/*/instructions");
		await page.locator(".settings-dialog-close").click();
		await question.waitFor({ timeout: 5000 });
		await question.getByRole("button", { name: "Keep editing" }).click();
		await page.waitForTimeout(300);
		assert((await page.locator(".settings-dialog").count()) === 1 && (await box.inputValue()) === "Answer in short sentences.", "Keep editing keeps the dialog and the draft");

		// Save and close saves the draft and closes.
		await page.locator(".settings-dialog-close").click();
		await question.waitFor({ timeout: 5000 });
		await question.locator(".rs-btn-primary").click();
		await page.waitForSelector(".settings-dialog", { state: "detached", timeout: 10000 });
		const stored = await authedFetch(`${baseUrl}/api/persistent-agents/${roomId}/instructions`);
		const storedText = ((await stored.json()) as { instructions?: { text?: string } }).instructions?.text ?? "";
		assert(storedText.trim() === "Answer in short sentences.", `Save and close stores the draft, got ${JSON.stringify(storedText)}`);

		// --- Settings overlay: a global draft, then another section.
		await page.locator(".product-sidebar-footer button").first().click();
		await page.locator(".sidebar-config-menu button, .sidebar-config-menu a").filter({ hasText: /Settings/ }).first().click();
		await page.waitForSelector(".settings-overlay", { timeout: 10000 });
		await page.locator(".settings-dialog-nav button").filter({ hasText: "Instructions" }).first().click();
		const globalBox = page.locator(".settings-overlay .room-instructions-textarea");
		await globalBox.waitFor({ timeout: 10000 });
		await globalBox.fill("Write in British English.");
		await page.locator(".settings-dialog-nav button").filter({ hasText: "Web search" }).first().click();
		await question.waitFor({ timeout: 5000 });
		const leaveButtons = await question.locator("button").allInnerTexts();
		assert(JSON.stringify(leaveButtons) === JSON.stringify(["Keep editing", "Leave without saving", "Save and leave"]), `moving away offers Save and leave, got ${JSON.stringify(leaveButtons)}`);
		await question.locator(".rs-btn-primary").click();
		await page.waitForTimeout(800);
		assert((await page.locator(".settings-overlay .settings-web-search").count()) === 1, "Save and leave moves on to the section");
		const globalStored = await authedFetch(`${baseUrl}/api/settings/instructions`);
		const globalText = ((await globalStored.json()) as { instructions?: { text?: string } }).instructions?.text ?? "";
		assert(globalText.trim() === "Write in British English.", `Save and leave stores the global draft, got ${JSON.stringify(globalText)}`);
		await ctx.close();
	} finally {
		await browser.close();
	}

	console.log("settings-save-and-close smoke: ok");
} finally {
	await stopSmokeServer(server);
	fs.rmSync(tempHome, { recursive: true, force: true });
}
