// What a person sees when a request is refused for its size, in the browser:
// - nothing, where it is sent again by itself and answered: no failure line, not
//   even for a moment;
// - where it can't be made smaller, one line that says so and how to go on, with
//   no Try again and no Choose another model, since the same request would be
//   refused again; after a reload too, and the room answers the next message;
// - a refusal that is not for size, beside it, keeps its two buttons.
import fs from "node:fs";
import { chromium, type Page } from "playwright";
import { ANTHROPIC_TOO_LARGE, assert, REQUEST_TOO_LARGE, SizeLimitRooms, waitUntil } from "./size-limit-setup.js";

if (!fs.existsSync(chromium.executablePath())) {
	console.log("request too large ui smoke skipped (Chromium not installed)");
	process.exit(0);
}

const CAUSE = "Room Model can't take this much at once.";
const NEXT = "Your message is still above. Ask for fewer pictures or files at a time.";
const rooms = new SizeLimitRooms();
const { gateway } = rooms;
let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;

function pass(label: string): void {
	console.log(`  ok  ${label}`);
}

const newest = (page: Page) => page.locator(".failure-line:not(.is-folded)");

async function enter(page: Page, name: string): Promise<void> {
	await page.evaluate(() => { window.location.hash = "#/"; });
	await page.locator(".persistent-agent-card").filter({ hasText: name }).getByRole("button", { name: /^(Enter|Resume)$/ }).click();
	await page.locator('button[title="Send"]').first().waitFor();
}

async function say(page: Page, text: string): Promise<void> {
	await page.locator("textarea").first().fill(text);
	// The room takes a message once it is connected.
	await page.locator('button[title="Send"]:enabled').first().waitFor();
	await page.locator("textarea").first().press("Enter");
}

async function sized(page: Page, when: string): Promise<void> {
	await newest(page).waitFor();
	const line = newest(page);
	const said = [await line.locator(".failure-cause").innerText(), await line.locator(".failure-next").innerText()].map((text) => text.trim());
	assert(said[0] === CAUSE && said[1] === NEXT, `${when}: the line says what happened and how to go on, got ${JSON.stringify(said)}`);
	assert((await line.locator(".rs-btn").count()) === 0, `${when}: it has no Try again and no Choose another model, got ${JSON.stringify(await line.locator(".rs-btn").allInnerTexts())}`);
	assert((await line.locator(".failure-details-toggle").count()) === 1, `${when}: the provider's words are under its Details`);
}

try {
	await rooms.open();
	rooms.addPictures("big", 6, 900, 700);
	rooms.addPictures("small", 25, 610, 600);
	for (const name of ["Sent Again", "At Once", "Something Else"]) await rooms.makeRoom(name);
	browser = await chromium.launch();
	const page = await (await browser.newContext({ viewport: { width: 1280, height: 900 } })).newPage();
	// Every failure line the page ever draws, however briefly.
	await page.addInitScript({ content: 'window.__lines = 0; var seen = new WeakSet(); new MutationObserver(function () { document.querySelectorAll(".failure-line").forEach(function (el) { if (!seen.has(el)) { seen.add(el); window.__lines++; } }); }).observe(document, { childList: true, subtree: true });' });
	const linesDrawn = () => page.evaluate(() => (window as any).__lines as number);
	await page.goto(rooms.signInUrl);
	await page.locator(".persistent-agent-card").first().waitFor();
	const dismiss = page.locator(".whats-new-close");
	if (await dismiss.count()) await dismiss.click();

	{
		gateway.limitBytes = 14 * 1024 * 1024;
		gateway.refusal = REQUEST_TOO_LARGE;
		await enter(page, "Sent Again");
		const before = gateway.requests.length;
		for (let i = 1; i <= 6; i++) {
			await say(page, `read big-0${i}.png`);
			await page.getByText(`Answered: read big-0${i}.png`).waitFor();
			await page.locator('button[title="Send"]').first().waitFor();
		}
		assert(gateway.requests.slice(before).some((request) => request.refused), "a request was refused for its size");
		assert((await linesDrawn()) === 0, `no failure line shows while the room goes on by itself, got ${await linesDrawn()}`);
		pass("a refused request that is sent again and answered draws no failure line");
	}

	{
		gateway.limitBytes = 20 * 1024 * 1024;
		gateway.refusal = ANTHROPIC_TOO_LARGE;
		await enter(page, "At Once");
		await say(page, "read small-01..25");
		await sized(page, "refused");
		assert((await linesDrawn()) === 1, `it is drawn once, got ${await linesDrawn()}`);
		await page.locator('button[title="Send"]').first().waitFor();
		await page.reload();
		await sized(page, "after a reload");
		await say(page, "hello");
		await page.getByText("Answered: hello").waitFor();
		pass("a refusal that can't be made smaller is one line with no buttons, after a reload too, and the next message is answered");
	}

	{
		gateway.refuseChats = Infinity;
		gateway.refusal = { status: 400, body: { error: { message: "Something unusual happened." } } } as typeof REQUEST_TOO_LARGE;
		await enter(page, "Something Else");
		await say(page, "hello");
		await newest(page).waitFor();
		const buttons = async () => (await newest(page).locator(".rs-btn").allInnerTexts()).map((text) => text.trim()).join("|");
		await waitUntil(async () => (await buttons()) === "Try again|Choose another model", `a refusal that is not for size keeps its buttons, got ${await buttons()}`);
		pass("a refusal that is not for size keeps Try again and Choose another model");
	}
	console.log("request-too-large ui smoke passed");
} catch (error) {
	console.error(`request-too-large-ui-smoke FAILED: ${(error as Error).message}`);
	console.error(rooms.output.join("").slice(-3000));
	process.exitCode = 1;
} finally {
	await browser?.close();
	await rooms.close();
}
