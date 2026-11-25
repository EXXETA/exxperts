// What a person sees of an answer ended by force (turn-forced-end.ts), in a
// browser on the detached-turn rig, with a model call that never hears its
// abort (smoke-ignores-stop-preload.mjs). Proves:
//   1. after Stop the words on screen stay, the line says once that the person
//      stopped it, no line in the conversation says the connection was lost,
//      and Send is back once the page has opened the room again (meanwhile it
//      says, as for any reconnect, that it reconnects);
//   2. the next message, typed there, is answered, and a reload reads the same;
//   3. Remember, refused while the room was stopping, reads and saves;
//   4. a message sent while the room was stopping waits above the box, once,
//      and goes out once, when the person sends it;
//   5. words typed while the page opens the room again stay in the box, and go
//      out once, when the person sends them;
//   6. a page reloaded while the room was stopping, which loads the
//      conversation before the answer ended: its next message is answered, its
//      saves keep the line the end left, and the next time it opens the room
//      the line is there once.
// At desktop and phone width, a room each.
import fs from "node:fs";
import path from "node:path";
import { chromium, type Page } from "playwright";
import { assert, baseUrl, createRoom, DEAF_MARKER, FAST_ANSWER_CHUNKS, gatewayRequests, getStatus, LATE_TEXT, reportDetachedFailure, scriptDir, startDetachedServer, stopDetachedServer, waitUntil } from "./persistent-room-detached-turn-setup.js";
import { STOP_CUT_ANSWER_SENTENCE } from "../src/turn-ended-by.js";
import { SMOKE_AUTH_TOKEN } from "./smoke-server-process.js";

const executable = typeof chromium?.executablePath === "function" ? chromium.executablePath() : "";
if (!executable || !fs.existsSync(executable)) {
	console.log("stop always ends ui smoke skipped (Chromium not installed)");
	process.exit(0);
}

const STOPPED_WORDS = "You stopped this answer.";
const FAST = FAST_ANSWER_CHUNKS.join("");
const WIDTHS = [{ name: "Desktop", viewport: { width: 1280, height: 900 } }, { name: "Phone", viewport: { width: 390, height: 844 } }];

/** The stopped answer as the conversation shows it: its line once, its words once, and no other word on why. */
async function readsStopped(page: Page, label: string): Promise<void> {
	const said = async (text: string) => page.getByText(text, { exact: false }).filter({ visible: true }).count();
	await waitUntil(async () => (await said(STOPPED_WORDS)) === 1, `${label}: the line says once that it was stopped`);
	assert((await said("Words before the stop.")) === 1, `${label}: the words on screen are there once`);
	const text = await page.locator("body").innerText();
	assert(!/connection (was )?lost|exxperts stopped|interrupted/i.test(text) && !text.includes(LATE_TEXT), `${label}: nothing else is said of it, got ${text.slice(-600)}`);
}

async function send(page: Page, text: string): Promise<void> {
	await page.locator("textarea").first().fill(text);
	await page.locator('.send-btn:enabled[title="Send"]').first().click();
}

async function enter(page: Page, name: string): Promise<void> {
	await page.goto(`${baseUrl}/`);
	const dismiss = page.locator(".whats-new-close");
	const card = page.locator(".persistent-agent-card").filter({ hasText: name });
	await card.getByRole("button", { name: /^(Enter|Resume)$/ }).waitFor({ timeout: 15_000 });
	if (await dismiss.count()) await dismiss.click();
	await card.getByRole("button", { name: /^(Enter|Resume)$/ }).click();
	await page.locator('button[title="Send"]').first().waitFor({ timeout: 15_000 });
}

const preload = new URL(`file://${path.join(scriptDir, "smoke-ignores-stop-preload.mjs")}`).href;
let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
try {
	await startDetachedServer(undefined, { env: { NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ""} --import=${preload}`.trim() } });
	browser = await chromium.launch();
	for (const { name, viewport } of WIDTHS) {
		const roomId = await createRoom(`Stop ${name} Room`);
		const context = await browser.newContext({ viewport });
		const page = await context.newPage();
		await page.goto(`${baseUrl}/auth/session?token=${SMOKE_AUTH_TOKEN}`);
		await enter(page, `Stop ${name} Room`);

		await send(page, `Never stop. ${DEAF_MARKER}:ui${name}`);
		await page.getByText("Words before the stop.").first().waitFor({ timeout: 15_000 });
		await page.locator(".stop-btn").first().click();
		await waitUntil(async () => (await getStatus(roomId)).activeThread?.cancelling === true, `${name}: the Stop is taken`);
		await waitUntil(async () => (await getStatus(roomId)).activeThread?.inFlight !== true, `${name}: the room is idle`);
		assert(!gatewayRequests.find((row) => row.played === `${DEAF_MARKER}:ui${name}`)!.finished, `${name}: the model call still hangs`);
		await page.locator('button[title="Send"]').first().waitFor({ timeout: 15_000 });
		await readsStopped(page, name);
		console.log(`ok 1 ${name}: the stopped answer reads as stopped, and Send is back`);

		await send(page, "And now?");
		await page.getByText(FAST).first().waitFor({ timeout: 20_000 });
		await waitUntil(async () => (await getStatus(roomId)).activeThread?.inFlight !== true, `${name}: the next answer settled`);
		await readsStopped(page, `${name}, after the next answer`);
		await page.reload();
		await enter(page, `Stop ${name} Room`);
		await page.getByText(FAST).first().waitFor({ timeout: 15_000 });
		await readsStopped(page, `${name}, after a reload`);
		console.log(`ok 2 ${name}: the next message is answered, and a reload reads the same`);

		await page.getByRole("button", { name: "Remember", exact: true }).first().click();
		const dialog = page.getByRole("dialog", { name: "Remember this conversation" });
		await dialog.getByRole("button", { name: "Save to memory" }).click({ timeout: 20_000 });
		await dialog.getByText("Memory updated").waitFor({ timeout: 15_000 });
		console.log(`ok 3 ${name}: Remember reads and saves`);
		await context.close();

		const queuedId = await createRoom(`Queued ${name} Room`);
		const queuedContext = await browser.newContext({ viewport });
		const queued = await queuedContext.newPage();
		const shown = (text: string) => queued.getByText(text, { exact: true }).filter({ visible: true }).count();
		const box = queued.locator("textarea").first();
		const boxSays = (placeholder: string) => queued.waitForFunction((words) => document.querySelector("textarea")?.placeholder === words, placeholder, { polling: 20, timeout: 15_000 });
		await queued.goto(`${baseUrl}/auth/session?token=${SMOKE_AUTH_TOKEN}`);
		await enter(queued, `Queued ${name} Room`);
		await send(queued, `Never stop. ${DEAF_MARKER}:queued${name}`);
		await queued.getByText("Words before the stop.").first().waitFor({ timeout: 15_000 });
		await queued.locator(".stop-btn").first().click();
		await boxSays("Stopping current response…");
		await send(queued, "Sent while stopping");
		await boxSays("Waiting for the connection…");
		await box.fill("Typed while it reconnects");
		const heard = gatewayRequests.length;
		await queued.locator('.send-btn:enabled[title="Send"]').first().waitFor({ timeout: 15_000 });
		// The room's own word that it caught up: everything it opens with is on screen by now.
		await queued.getByText("Connected again.").first().waitFor({ timeout: 15_000 });
		assert((await shown("Sent while stopping")) === 1 && gatewayRequests.length === heard, `${name}: the message sent while stopping waits above the box, once, and went nowhere, got ${await shown("Sent while stopping")} on screen and ${gatewayRequests.length - heard} calls`);
		assert((await box.inputValue()) === "Typed while it reconnects", `${name}: the words typed while it reconnected are still in the box, got ${await box.inputValue()}`);
		await queued.getByRole("button", { name: "Send now" }).first().click();
		await waitUntil(async () => gatewayRequests.length === heard + 1 && (await getStatus(queuedId)).activeThread?.inFlight !== true, `${name}: the message sent while stopping is answered`);
		await queued.locator('.send-btn:enabled[title="Send"]').first().click();
		await waitUntil(async () => gatewayRequests.length === heard + 2 && (await getStatus(queuedId)).activeThread?.inFlight !== true, `${name}: the typed words are answered`);
		await enter(queued, `Queued ${name} Room`);
		await queued.getByText("Typed while it reconnects", { exact: true }).first().waitFor({ timeout: 15_000 });
		assert((await shown("Sent while stopping")) === 1 && (await shown("Typed while it reconnects")) === 1 && (await queued.getByRole("button", { name: "Send now" }).count()) === 0, `${name}: after a reload each is there once and nothing waits`);
		assert(gatewayRequests.length === heard + 2, `${name}: each went out once, got ${gatewayRequests.length - heard} calls`);
		console.log(`ok 4 ${name}: a message sent while stopping waits, and goes out once`);
		console.log(`ok 5 ${name}: words typed while it reconnects stay, and go out once`);
		await queuedContext.close();

		const reloadedId = await createRoom(`Reloaded ${name} Room`);
		const reloadedContext = await browser.newContext({ viewport });
		const reloaded = await reloadedContext.newPage();
		const line = () => reloaded.getByText(STOP_CUT_ANSWER_SENTENCE.split(". ")[0]!, { exact: false }).filter({ visible: true }).count();
		await reloaded.goto(`${baseUrl}/auth/session?token=${SMOKE_AUTH_TOKEN}`);
		await enter(reloaded, `Reloaded ${name} Room`);
		await send(reloaded, `Never stop. ${DEAF_MARKER} QUIET_STREAM_MARKER:reloaded${name}`);
		await waitUntil(() => gatewayRequests.some((row) => row.played === `QUIET_STREAM_MARKER:reloaded${name}`), `${name}: the call reached the gateway`);
		await reloaded.locator(".stop-btn").first().click();
		await waitUntil(async () => (await getStatus(reloadedId)).activeThread?.cancelling === true, `${name}: the Stop is taken`);
		await reloaded.reload();
		await waitUntil(async () => (await getStatus(reloadedId)).activeThread?.inFlight !== true, `${name}: the room is idle`);
		await reloaded.locator("textarea").first().fill("And after the reload?");
		await reloaded.locator('.send-btn:enabled[title="Send"]').first().click({ timeout: 15_000 });
		await reloaded.getByText(FAST).first().waitFor({ timeout: 20_000 });
		await waitUntil(async () => (await getStatus(reloadedId)).activeThread?.inFlight !== true, `${name}: the reloaded page's answer settled`);
		await enter(reloaded, `Reloaded ${name} Room`);
		await reloaded.getByText(FAST).first().waitFor({ timeout: 15_000 });
		assert((await line()) === 1, `${name}: the line the end left is there once, got ${await line()}`);
		console.log(`ok 6 ${name}: a page reloaded while the room was stopping keeps the line the end left`);
		await reloadedContext.close();
	}
} catch (error) {
	reportDetachedFailure(error);
} finally {
	for (const request of gatewayRequests) request.release();
	await browser?.close();
	await stopDetachedServer();
}
