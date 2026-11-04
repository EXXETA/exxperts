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
import { chromium, type Locator, type Page } from "playwright";
import { authedFetch, SMOKE_AUTH_TOKEN, SMOKE_SERVER_AUTH_ENV, SMOKE_SERVER_SPAWN_TREE_OPTIONS, stopSmokeServer, freePort, waitForServer } from "./smoke-server-process.js";

const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), "exxperts-save-and-close-"));
process.env.HOME = tempHome;
process.env.USERPROFILE = tempHome;

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const webServerDir = path.resolve(scriptDir, "..");
const port = await freePort();
const baseUrl = `http://127.0.0.1:${port}`;

function assert(condition: unknown, message: string): asserts condition {
	if (!condition) throw new Error(message);
}

let server: ChildProcessWithoutNullStreams | null = null;

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

type Rect = { x: number; y: number; width: number; height: number };
const inBoxCorner = (button: Rect, box: Rect): boolean =>
	button.y > box.y && button.y + button.height < box.y + box.height / 2
	&& button.x + button.width < box.x + box.width && button.x + button.width >= box.x + box.width - 16;

// Both Instructions panes, measured in the page: Clear (and its Undo) sits
// in the box's top right corner without moving the box, the text wraps before
// it, the counter under the box reads "N / 8,000" and turns the app's danger
// red only past the limit, and the row under the box stays on one line with
// Save in place as the text crosses the limit. Leaves `keep` in the box.
async function checkInstructionsBox(page: Page, pane: Locator, label: string, keep: string): Promise<void> {
	const box = pane.locator(".room-instructions-textarea");
	const counter = pane.locator(".room-instructions-count [aria-hidden='true']");
	const rect = async (locator: Locator) => {
		const found = await locator.boundingBox();
		assert(found, `${label}: ${locator} is on screen`);
		return found;
	};
	const button = (name: string) => pane.getByRole("button", { name, exact: true });
	const isDanger = async () => counter.evaluate((element) => {
		const probe = document.createElement("span");
		probe.style.color = "var(--error)";
		element.parentElement!.appendChild(probe);
		const danger = getComputedStyle(probe).color;
		probe.remove();
		return getComputedStyle(element).color === danger;
	});
	// Waits for the counter to read `text`; the assertion after it says what was there instead.
	const counterReads = (text: string) => pane.locator(".room-instructions-count [aria-hidden='true']", { hasText: new RegExp(`^${text}$`) }).waitFor({ timeout: 5000 }).catch(() => {});
	const sameLine = async () => {
		const count = await rect(counter);
		const save = await rect(button("Save"));
		return Math.abs((count.y + count.height / 2) - (save.y + save.height / 2)) <= 4;
	};

	await box.fill("");
	await counterReads("0 / 8,000");
	assert((await button("Clear").count()) === 0, `${label}: an empty box offers no Clear`);
	const emptyTop = (await rect(box)).y;
	const cleanCounterTop = (await rect(counter)).y;
	assert(await counter.innerText() === "0 / 8,000" && !(await isDanger()), `${label}: the counter shows "0 / 8,000" under an empty box, got ${JSON.stringify(await counter.innerText())}`);

	await box.fill(keep);
	await button("Clear").waitFor({ timeout: 5000 });
	assert((await rect(box)).y === emptyTop, `${label}: the box stays put when Clear appears`);
	const clear = await rect(button("Clear"));
	const boxRect = await rect(box);
	const toggle = pane.locator(".room-instructions-global-toggle");
	if (await toggle.count()) {
		const shared = await rect(toggle);
		assert(shared.y + shared.height <= boxRect.y, `${label}: "Show the global instructions" sits above the box`);
		// With the global text shown, Clear stays in the room's own box, under that text.
		await toggle.click();
		const globalText = pane.locator(".room-instructions-global-text");
		await globalText.waitFor({ timeout: 5000 });
		const shown = await rect(globalText);
		const clearOpen = await rect(button("Clear"));
		const boxOpen = await rect(box);
		assert(boxOpen.y >= shown.y + shown.height && inBoxCorner(clearOpen, boxOpen), `${label}: with the global text shown, Clear sits in the box under it`);
		await toggle.click();
		await globalText.waitFor({ state: "detached", timeout: 5000 });
		assert((await rect(box)).y === emptyTop, `${label}: hiding the global text puts the box back`);
	}
	assert((await rect(counter)).y === cleanCounterTop, `${label}: the counter stays put when Discard and Save appear`);
	assert(inBoxCorner(clear, boxRect), `${label}: Clear sits in the box's top right corner`);
	const textRight = await box.evaluate((element) => {
		const style = getComputedStyle(element);
		return element.getBoundingClientRect().right - parseFloat(style.paddingRight);
	});
	assert(textRight <= clear.x, `${label}: the text wraps before Clear`);
	assert(await counter.innerText() === `${keep.length} / 8,000` && !(await isDanger()), `${label}: under the limit the counter is plain, got ${JSON.stringify(await counter.innerText())}`);
	assert(await sameLine(), `${label}: the counter and Save share one line`);

	await box.fill("x".repeat(8000));
	await counterReads("8,000 / 8,000");
	const saveAtLimit = await rect(button("Save"));
	assert(await counter.innerText() === "8,000 / 8,000" && !(await isDanger()) && await button("Save").isEnabled(), `${label}: at the limit the counter is plain and Save works`);
	await box.fill("x".repeat(8100));
	await counterReads("8,100 / 8,000");
	assert(await counter.innerText() === "8,100 / 8,000" && await isDanger(), `${label}: past the limit the counter reads "8,100 / 8,000" in the danger red, got ${JSON.stringify(await counter.innerText())}`);
	const spoken = await pane.locator(".room-instructions-count .sr-only").innerText();
	assert(spoken === "8,100 of 8,000 characters, 100 over the limit", `${label}: a screen reader hears the count in words, got ${JSON.stringify(spoken)}`);
	assert(!(await button("Save").isEnabled()), `${label}: past the limit Save waits`);
	assert(await sameLine(), `${label}: past the limit the row under the box stays on one line`);
	const saveOver = await rect(button("Save"));
	assert(saveOver.x === saveAtLimit.x && saveOver.y === saveAtLimit.y, `${label}: Save stays in place as the text crosses the limit`);

	// Clear turns into Undo in the same place, and the box does not move.
	await button("Clear").click();
	await button("Undo").waitFor({ timeout: 5000 });
	const undo = await rect(button("Undo"));
	assert((await rect(box)).y === emptyTop && inBoxCorner(undo, boxRect), `${label}: Undo takes Clear's place in the box`);
	await button("Undo").click();
	assert((await box.inputValue()).length === 8100, `${label}: Undo puts the text back`);
	await box.fill(keep);
}

try {
	server = spawn("npx", ["tsx", "src/index.ts"], {
		shell: process.platform === "win32",
		...SMOKE_SERVER_SPAWN_TREE_OPTIONS,
		cwd: webServerDir,
		env: { ...process.env, PORT: String(port), ...SMOKE_SERVER_AUTH_ENV },
		stdio: ["ignore", "pipe", "pipe"],
	}) as unknown as ChildProcessWithoutNullStreams;
	await waitForServer(server, baseUrl, { tries: 100 });
	const created = await authedFetch(`${baseUrl}/api/persistent-agents`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ displayName: "Draft Room", userName: "Synthetic User", preferredUserAddress: "Synthetic User" }) });
	assert(created.ok, `room create failed: ${created.status}`);
	const roomId = String(((await created.json()) as { agent?: { id?: string } }).agent?.id ?? "");
	assert(roomId, "the new room has an id");
	// A global text, so the room's pane shows its "Show the global instructions" row, the row Clear shares.
	const seeded = await authedFetch(`${baseUrl}/api/settings/instructions`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ text: "Be terse." }) });
	assert(seeded.ok, `global instructions seed failed: ${seeded.status}`);

	const browser = await chromium.launch();
	try {
		// English numbers in the page, so "8,100 / 8,000" reads the same on every machine.
		const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 }, locale: "en-US" });
		const page = await ctx.newPage();
		await page.goto(`${baseUrl}/auth/session?token=${SMOKE_AUTH_TOKEN}`);
		await page.waitForLoadState("networkidle");
		const dismiss = page.locator(".whats-new-close");
		if (await dismiss.count()) await dismiss.click();

		// --- Room settings: a draft in Instructions, then Close from another pane.
		await page.locator(".persistent-agent-card").filter({ hasText: "Draft Room" }).locator(".card-gear-btn").click();
		await page.waitForSelector(".settings-dialog", { timeout: 10000 });
		const nav = (label: string) => page.locator(".settings-dialog-nav-item").filter({ hasText: new RegExp(`^${label}$`) }).first();
		await nav("Instructions").click();
		const box = page.locator(".room-settings-section:not([hidden]) .room-instructions-textarea");
		await box.waitFor({ timeout: 10000 });
		await checkInstructionsBox(page, page.locator(".room-settings-section:not([hidden])"), "room Instructions", "Answer in short sentences.");
		await nav("Skills").click();
		await page.locator(".settings-dialog-close").click();

		const question = page.locator(".confirm-dialog-backdrop");
		await question.waitFor({ timeout: 5000 });
		const buttons = await question.locator("button").allInnerTexts();
		assert(JSON.stringify(buttons) === JSON.stringify(["Keep editing", "Close without saving", "Save and close"]), `the question offers three answers in order, got ${JSON.stringify(buttons)}`);
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
		await checkInstructionsBox(page, page.locator(".settings-overlay .room-instructions-section"), "Settings Instructions", "Write in British English.");
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
