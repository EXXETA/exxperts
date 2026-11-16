// Arranging the rooms on Home, in the browser: Arrange turns into Done, Done
// keeps the order with one request, and every way out of Home while arranging
// keeps it too, asking nothing; Escape puts the cards back (a carried card
// first, nothing while a save runs); each card's two arrows move it one place
// for a click or a tap and never start a carry; a failed save says it may not
// have been saved, on Done and on the next visit, never in the server's words.
// At desktop width with a mouse and at phone width with a finger.
//
// Offline: no model is called; no room is entered.
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, type Browser, type Page, type Route } from "playwright";
import { SMOKE_AUTH_TOKEN, SMOKE_SERVER_AUTH_ENV, SMOKE_SERVER_SPAWN_TREE_OPTIONS, smokeHomeEnv, stopSmokeServer, freePort } from "./smoke-server-process.js";
import { waitEvery } from "./smoke-wait.js";
import { ROOM_ARRANGE_DONE_FAILED, ROOM_ARRANGE_FAILED_AWAY, ROOM_ARRANGE_HINT_POINTER, ROOM_ARRANGE_HINT_TOUCH, ROOM_ARRANGE_MOVE_EARLIER, ROOM_ARRANGE_MOVE_LATER } from "../../web-ui/src/home-room-arrange.js";
import { ROOM_LONG_PRESS_MS } from "../../web-ui/src/home-room-drag.js";
import { ROOM_ORDER_SAVE_FAILED_SENTENCE } from "../src/room-order-store.js";
import { ROOM_ORDER_MODES } from "../src/room-order.js";

const waitUntil = waitEvery(100);

function assert(condition: unknown, message: string): asserts condition {
	if (!condition) throw new Error(message);
}

{
	const p = typeof chromium?.executablePath === "function" ? chromium.executablePath() : "";
	if (!p || !fs.existsSync(p)) {
		console.log("room-order-arrange-ui smoke skipped (Chromium not installed)");
		process.exit(0);
	}
}

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const webServerDir = path.resolve(scriptDir, "..");
const repoRoot = path.resolve(webServerDir, "..", "..");
const port = await freePort();
const baseUrl = `http://127.0.0.1:${port}`;

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "exxperts-arrange-ui-"));
const tempHome = path.join(tempRoot, "home");
const agentsRoot = path.join(tempHome, ".exxperts", "app", "personalized-agents");
const agentDir = path.join(tempHome, ".exxperts", "agent");
for (const dir of [agentsRoot, agentDir]) fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
process.env.HOME = tempHome;
process.env.USERPROFILE = tempHome;
process.env.EXXPERTS_CODING_AGENT_DIR = agentDir;
process.env.EXXETA_PERSISTENT_AGENTS_ROOT = agentsRoot;

let server: ChildProcessWithoutNullStreams | undefined;
const serverOutput: string[] = [];

const ORDER_ROUTE = "**/api/settings/room-order";
const ROOMS = ["Alpha Room", "Bravo Room", "Charlie Room"];

/** One page on Home, with what it sends to the order's route and every system box it is shown. */
async function openHome(browser: Browser, phone = false) {
	const context = await browser.newContext(phone ? { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true } : { viewport: { width: 1280, height: 900 } });
	const page = await context.newPage();
	const saves: { mode: string; customOrder?: string[] }[] = [];
	const boxes: string[] = [];
	page.on("request", (request) => {
		if (request.method() === "PUT" && request.url().endsWith("/api/settings/room-order")) saves.push(JSON.parse(request.postData() ?? "{}"));
	});
	page.on("dialog", (dialog) => { boxes.push(dialog.message()); void dialog.dismiss(); });
	await page.goto(`${baseUrl}/auth/session?token=${SMOKE_AUTH_TOKEN}`);
	await page.waitForLoadState("networkidle");
	const dismiss = page.locator(".whats-new-close");
	if (await dismiss.count()) await dismiss.click();
	await page.locator(".persistent-agent-card").nth(ROOMS.length - 1).waitFor({ timeout: 20_000 });
	return { page, saves, boxes };
}

const slots = (page: Page) => page.locator("[data-arrange-slot]");
/** The rooms' names in the order on screen, arranging or not. */
const shownOrder = (page: Page) => page.locator(".landing-grid .persistent-agent-card h2").allTextContents();
const slotIds = (page: Page) => slots(page).evaluateAll((all) => all.map((slot) => (slot as HTMLElement).dataset.arrangeSlot ?? ""));
const slotOf = (page: Page, name: string) => slots(page).filter({ has: page.locator("h2", { hasText: name }) });
const doneButton = (page: Page) => page.locator(".room-arrange-done");
const arrangeButton = (page: Page) => page.locator(".room-sort-arrange");
const announced = (page: Page) => page.locator(".room-arrange-live").textContent();
const atRest = async (page: Page) => (await arrangeButton(page).isVisible()) && (await doneButton(page).count()) === 0;
const orderIs = (page: Page, expected: string[], label: string) => waitUntil(async () => (await shownOrder(page)).join() === expected.join(), `${label}: ${expected.join(", ")}`);
/** A thing that must not happen has no state to wait on: the page gets time to do it, and each such check has a neighbour where the same input does it. */
const settleFor = (page: Page) => page.waitForTimeout(400);

async function startArranging(page: Page): Promise<void> {
	await arrangeButton(page).click();
	await doneButton(page).waitFor({ timeout: 10_000 });
}

/** Moves the room one place later with the arrow key, as a person does: focus its card, press. */
async function keyMove(page: Page, name: string, key = "ArrowRight"): Promise<void> {
	const before = (await shownOrder(page)).join();
	await slotOf(page, name).focus();
	await page.keyboard.press(key);
	await waitUntil(async () => (await shownOrder(page)).join() !== before, `${key} moved ${name}`);
}

/** Holds every save to the order's route until the smoke lets it go: on to the server, or answered with a failure. */
async function holdSaves(page: Page) {
	const held: Route[] = [];
	await page.route(ORDER_ROUTE, (route) => (route.request().method() === "PUT" ? void held.push(route) : void route.continue()));
	return {
		held,
		waitHeld: (count: number, label: string) => waitUntil(() => held.length >= count, label),
		pass: async () => { for (const route of held.splice(0)) await route.continue(); await page.unroute(ORDER_ROUTE); },
		fail: async () => { for (const route of held.splice(0)) await route.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ error: ROOM_ORDER_SAVE_FAILED_SENTENCE }) }); },
	};
}

async function sidebar(page: Page, name: "Wallet" | "Memory" | "Rooms"): Promise<void> {
	await page.locator(".product-nav").getByRole("button", { name, exact: true }).click();
}

async function backHome(page: Page): Promise<void> {
	await sidebar(page, "Rooms");
	await page.locator(".persistent-agent-card").nth(ROOMS.length - 1).waitFor({ timeout: 15_000 });
	await arrangeButton(page).waitFor({ timeout: 10_000 });
}

/** The first time: Custom from the menu opens arranging, and Done with no move keeps Custom. */
async function checkFirstCustom(browser: Browser): Promise<void> {
	const { page, saves, boxes } = await openHome(browser);
	await page.locator(".room-sort-btn").first().click();
	await page.getByRole("menuitemradio", { name: /Custom/ }).click();
	await doneButton(page).waitFor({ timeout: 10_000 });
	const entry = await shownOrder(page);
	assert(saves.length < 1, "choosing Custom the first time opens arranging and sends nothing yet");
	await doneButton(page).click();
	await waitUntil(() => atRest(page), "Done with no move returns to Sort and Arrange");
	assert(saves.length === 1 && saves[0].mode === "custom", `Done with no move, the first time, sends Custom once, got ${JSON.stringify(saves)}`);
	await page.reload();
	await arrangeButton(page).waitFor({ timeout: 15_000 });
	assert((await page.locator(".room-sort-btn").first().textContent())?.includes("Custom"), "after a reload the order is still Custom");
	assert((await shownOrder(page)).join() === entry.join(), "with the cards where they were");
	assert(boxes.length === 0, `no system box, got ${JSON.stringify(boxes)}`);
	console.log("  ok  Custom chosen the first time and Done with no move keeps Custom");
	await page.context().close();
}

/** Arranging at desktop width: the hint and Done, Done, Escape, the arrows, what happens while a save runs, and the failures. */
async function checkDesktop(browser: Browser): Promise<void> {
	const { page, saves, boxes } = await openHome(browser);

	// Arrange: the hint and Done, no Cancel, no Save. Done after a move: one request with the whole order, then Sort and Arrange.
	const rest = await shownOrder(page);
	// Arrange turns into Done in the same place: Done's text keeps Arrange's right edge and bottom, and no card moves.
	const firstCard = page.locator(".landing-grid .persistent-agent-card").first();
	const atRestBoxes = { arrange: (await arrangeButton(page).boundingBox())!, card: (await firstCard.boundingBox())! };
	await startArranging(page);
	const arrangingBoxes = { done: (await doneButton(page).boundingBox())!, card: (await firstCard.boundingBox())! };
	const shift = {
		right: arrangingBoxes.done.x + arrangingBoxes.done.width - (atRestBoxes.arrange.x + atRestBoxes.arrange.width),
		bottom: arrangingBoxes.done.y + arrangingBoxes.done.height - (atRestBoxes.arrange.y + atRestBoxes.arrange.height),
		card: arrangingBoxes.card.y - atRestBoxes.card.y,
	};
	assert(Object.values(shift).every((px) => Math.abs(px) <= 1), `Done takes Arrange's place and the cards stay, got ${JSON.stringify(shift)}`);
	assert((await page.locator(".room-arrange-hint").textContent()) === ROOM_ARRANGE_HINT_POINTER, `the pointer's hint, got ${await page.locator(".room-arrange-hint").textContent()}`);
	assert((await doneButton(page).textContent()) === "Done", "the button reads Done");
	assert(await page.getByRole("button", { name: "Cancel", exact: true }).count() === 0 && await page.getByRole("button", { name: "Save", exact: true }).count() === 0, "no Cancel and no Save while arranging");
	await keyMove(page, rest[0]);
	const moved = await shownOrder(page);
	const movedIds = await slotIds(page);
	await doneButton(page).click();
	await waitUntil(() => atRest(page), "Done returns to Sort and Arrange");
	assert(saves.length === 1 && saves[0].mode === "custom" && saves[0].customOrder?.join() === movedIds.join(), `Done sends one request with the whole order, got ${JSON.stringify(saves)}`);
	assert((await shownOrder(page)).join() === moved.join(), "the cards stay where they were put");
	await page.reload();
	await arrangeButton(page).waitFor({ timeout: 15_000 });
	await orderIs(page, moved, "the order holds after a reload");
	console.log("  ok  Arrange shows the hint and Done in Arrange's place, no card moving; Done after a move sends one request with the whole order, and the order holds after a reload");

	// Done with nothing moved: arranging ends, nothing is sent.
	await startArranging(page);
	await doneButton(page).click();
	await waitUntil(() => atRest(page), "Done with no move returns to Sort and Arrange");
	await settleFor(page);
	assert(saves.length === 1, `Done with no move and Custom already kept sends nothing, got ${saves.length} requests`);

	// Escape with moves and nothing carried: the cards go back, nothing is sent.
	await startArranging(page);
	await keyMove(page, moved[0]);
	await page.keyboard.press("Escape");
	await waitUntil(() => atRest(page), "Escape ends arranging");
	await orderIs(page, moved, "Escape puts the cards back");
	await settleFor(page);
	assert(saves.length === 1, `Escape sends nothing, got ${saves.length} requests`);
	console.log("  ok  Escape with moves and nothing carried puts the cards back and sends nothing");

	// Escape while a card is carried ends the carry only: arranging and the earlier moves stay.
	await startArranging(page);
	await keyMove(page, moved[0]);
	const beforeCarry = await shownOrder(page);
	const carriedTitle = slotOf(page, moved[1]).locator("h2");
	const box = (await carriedTitle.boundingBox())!;
	await page.mouse.move(box.x + 5, box.y + 5);
	await page.mouse.down();
	await page.mouse.move(box.x + 205, box.y + 15, { steps: 8 });
	await page.locator(".room-arrange-slot.is-dragging").waitFor({ timeout: 5_000 });
	await page.keyboard.press("Escape");
	await page.locator(".room-arrange-slot.is-dragging").waitFor({ state: "detached", timeout: 5_000 });
	await page.mouse.up();
	await settleFor(page);
	assert(await doneButton(page).isVisible(), "Escape while carrying keeps arranging");
	assert((await shownOrder(page)).join() === beforeCarry.join(), "and the earlier moves");
	console.log("  ok  Escape while a card is carried ends the carry only");

	// The arrows: one click moves one place, with the key's announcement; the first has no earlier, the last no later.
	const current = await shownOrder(page);
	const earlier = (name: string) => slotOf(page, name).getByRole("button", { name: ROOM_ARRANGE_MOVE_EARLIER, exact: true });
	const later = (name: string) => slotOf(page, name).getByRole("button", { name: ROOM_ARRANGE_MOVE_LATER, exact: true });
	assert(await earlier(current[0]).isDisabled() && await later(current[0]).isEnabled(), "the first card has no earlier");
	assert(await later(current[2]).isDisabled() && await earlier(current[2]).isEnabled(), "the last card has no later");
	assert(await earlier(current[1]).isEnabled() && await later(current[1]).isEnabled(), "a card in the middle has both");
	assert((await later(current[0]).getAttribute("title")) === ROOM_ARRANGE_MOVE_LATER && (await earlier(current[1]).getAttribute("title")) === ROOM_ARRANGE_MOVE_EARLIER, "each arrow's tooltip is its name");
	assert(await later(current[0]).getAttribute("tabindex") === "-1" && await earlier(current[1]).getAttribute("tabindex") === "-1", "the arrows are not Tab stops: the card is");
	await later(current[0]).click();
	await orderIs(page, [current[1], current[0], current[2]], "one click on later moves the room one place");
	await waitUntil(async () => (await announced(page)) === `${current[0]}, position 2 of 3`, "the arrow's move is announced as a key's");
	await keyMove(page, current[0], "ArrowLeft");
	await waitUntil(async () => (await announced(page)) === `${current[0]}, position 1 of 3`, "the key's announcement, for the same card");
	await earlier(current[2]).click();
	await orderIs(page, [current[0], current[2], current[1]], "one click on earlier moves the room one place");
	await waitUntil(async () => (await announced(page)) === `${current[2]}, position 2 of 3`, "and is announced");
	const arrowFacing = (name: string, which: "earlier" | "later") => (which === "earlier" ? earlier(name) : later(name)).locator("svg").evaluate((svg) => {
		const { a, b } = new DOMMatrix(getComputedStyle(svg).transform);
		return Math.round(Math.atan2(b, a) * 180 / Math.PI);
	});
	assert(await arrowFacing(current[1], "earlier") === 90 && await arrowFacing(current[1], "later") === -90, "beside each other, the arrows point left and right");
	// A window wider than a phone whose grid still has room for one column only: the cards stack, so the arrows point up and down.
	await page.setViewportSize({ width: 960, height: 900 });
	await waitUntil(async () => new Set(await slots(page).evaluateAll((all) => all.map((slot) => Math.round(slot.getBoundingClientRect().left)))).size === 1, "at 960 px the cards stack in one column");
	assert(await arrowFacing(current[1], "earlier") === 180 && await arrowFacing(current[1], "later") === 0, "in one column, the arrows point up and down at any window width");
	// A short window tightens the grid's gap, so 950 px holds two columns again: side by side, the arrows point left and right.
	await page.setViewportSize({ width: 950, height: 700 });
	await waitUntil(async () => new Set(await slots(page).evaluateAll((all) => all.map((slot) => Math.round(slot.getBoundingClientRect().left)))).size === 2, "at 950 by 700 px the cards sit two to a row");
	await waitUntil(async () => await arrowFacing(current[1], "earlier") === 90 && await arrowFacing(current[1], "later") === -90, "side by side, the arrows point left and right whatever decided the columns");
	await page.setViewportSize({ width: 1280, height: 900 });
	await waitUntil(async () => await arrowFacing(current[1], "earlier") === 90, "back at 1280 px, side by side again");
	// A change in the number of columns slides the cards to their new places: the next press waits for them to stop.
	await waitUntil(() => slots(page).evaluateAll((all) => all.every((slot) => getComputedStyle(slot).transform === "none")), "the cards at rest after the resize");
	console.log("  ok  the arrows: one click moves one place, announced as a key's move; the ends have one arrow each; they point left and right, and up and down wherever the cards stack");

	// A press on an arrow never starts a carry; the same press on the card does.
	const arrowBox = (await later(current[2]).boundingBox())!;
	const orderBeforePress = await shownOrder(page);
	await page.mouse.move(arrowBox.x + arrowBox.width / 2, arrowBox.y + arrowBox.height / 2);
	await page.mouse.down();
	await page.mouse.move(arrowBox.x - 200, arrowBox.y + 10, { steps: 8 });
	await settleFor(page);
	assert(await page.locator(".room-arrange-slot.is-dragging").count() === 0, "a press on an arrow, moved, carries nothing");
	await page.mouse.up();
	await settleFor(page);
	assert((await shownOrder(page)).join() === orderBeforePress.join(), "and moves nothing");
	console.log("  ok  a mouse press on an arrow starts no carry");

	// While a save runs: Escape does nothing, no key, arrow or drop moves a card; then Done lands.
	const hold = await holdSaves(page);
	const whileSaving = await shownOrder(page);
	const savingIds = await slotIds(page);
	await doneButton(page).click();
	await hold.waitHeld(1, "the save is on its way");
	await waitUntil(async () => (await doneButton(page).textContent()) === "Saving…", "Done reads Saving… while the save runs");
	assert(await doneButton(page).isDisabled(), "and cannot be pressed again");
	await page.keyboard.press("Escape");
	await slotOf(page, whileSaving[0]).focus();
	await page.keyboard.press("ArrowRight");
	await settleFor(page);
	assert(await doneButton(page).isVisible() && (await shownOrder(page)).join() === whileSaving.join(), "Escape and a key do nothing while the save runs");
	assert(await later(whileSaving[0]).isDisabled() && await earlier(whileSaving[1]).isDisabled(), "the arrows are off while the save runs");
	await hold.pass();
	await waitUntil(() => atRest(page), "the save lands: Sort and Arrange");
	assert(saves.at(-1)?.customOrder?.join() === savingIds.join(), "what was sent is the order on screen");
	await orderIs(page, whileSaving, "the order stays");
	console.log("  ok  while a save runs, Done reads Saving…, Escape does nothing and nothing moves");

	// Done fails: the moves stay with their line, arranging stays open, Done again succeeds.
	const failing = await holdSaves(page);
	await startArranging(page);
	await keyMove(page, whileSaving[0]);
	const failedOrder = await shownOrder(page);
	const failedIds = await slotIds(page);
	await doneButton(page).click();
	await failing.waitHeld(1, "Done's save is on its way");
	await failing.fail();
	await page.locator(".room-sort-save-error").waitFor({ timeout: 10_000 });
	assert((await page.locator(".room-sort-save-error").textContent()) === ROOM_ARRANGE_DONE_FAILED, `Done that fails says so, got ${await page.locator(".room-sort-save-error").textContent()}`);
	assert(await doneButton(page).isEnabled() && (await doneButton(page).textContent()) === "Done", "arranging stays open, Done ready again");
	assert((await shownOrder(page)).join() === failedOrder.join(), "the moves stay on screen");
	assert(!(await page.locator("body").innerText()).includes("server logs"), "the server's sentence is never shown");
	await failing.pass();
	await doneButton(page).click();
	await waitUntil(() => atRest(page), "Done again succeeds");
	assert(saves.at(-1)?.customOrder?.join() === failedIds.join(), "and sends the same order");
	assert(await page.locator(".room-sort-save-error").count() === 0, "the line goes with the save that landed");
	console.log("  ok  Done that fails keeps the moves with its line, and Done again succeeds");

	// A failed Done, then Escape: the cards go back and the line at rest says the order may not have been saved; Arrange again says nothing until Done is pressed, and Done then keeps the order on screen.
	const escaped = await holdSaves(page);
	await startArranging(page);
	await keyMove(page, failedOrder[0]);
	await doneButton(page).click();
	await escaped.waitHeld(1, "Done's save is on its way");
	await escaped.fail();
	await page.locator(".room-sort-save-error").waitFor({ timeout: 10_000 });
	await page.keyboard.press("Escape");
	await waitUntil(() => atRest(page), "Escape after a failed Done ends arranging");
	await orderIs(page, failedOrder, "Escape puts the cards back");
	assert((await page.locator(".room-sort-save-error").textContent()) === ROOM_ARRANGE_FAILED_AWAY, `at rest, the line says it may not have been saved, got ${await page.locator(".room-sort-save-error").textContent()}`);
	await startArranging(page);
	assert(await page.locator(".room-sort-save-error").count() === 0, `Arrange again shows no line before Done is pressed, got ${await page.locator(".room-sort-save-error").allTextContents()}`);
	await escaped.pass();
	const sentBeforeRetry = saves.length;
	await doneButton(page).click();
	await waitUntil(() => atRest(page), "Done, with nothing moved, after a failure");
	assert(saves.length === sentBeforeRetry + 1 && saves.at(-1)?.customOrder?.join() === failedIds.join(), "while a failure is remembered, Done sends the order on screen");
	assert(await page.locator(".room-sort-save-error").count() === 0, "and the line goes");
	console.log("  ok  after a failed Done and Escape, Arrange again shows no line until Done is pressed");

	// Each way out of Home while arranging with moves keeps the order and asks nothing: the sidebar's Wallet and Memory, a route change.
	let expected = failedOrder;
	for (const [label, leave] of [
		["the sidebar's Wallet", () => sidebar(page, "Wallet")],
		["the sidebar's Memory", () => sidebar(page, "Memory")],
		["a route change", () => page.evaluate(() => { window.location.hash = "#/memory"; })],
	] as const) {
		const sent = saves.length;
		await startArranging(page);
		await keyMove(page, expected[0]);
		expected = await shownOrder(page);
		const ids = await slotIds(page);
		await leave();
		await page.locator(".home-page").waitFor({ state: "detached", timeout: 10_000 });
		await waitUntil(() => saves.length === sent + 1, `${label}: the order is sent once`);
		assert(saves.at(-1)?.mode === "custom" && saves.at(-1)?.customOrder?.join() === ids.join(), `${label}: the whole order is sent, got ${JSON.stringify(saves.at(-1))}`);
		await backHome(page);
		await orderIs(page, expected, `${label}: back on Home, the order is kept`);
		assert(await atRest(page), `${label}: Home is at rest`);
		console.log(`  ok  leaving Home by ${label} while arranging keeps the order and asks nothing`);
	}

	// A save that fails after Home was left is said on the next visit, beside Arrange.
	const away = await holdSaves(page);
	await startArranging(page);
	await keyMove(page, expected[0]);
	await sidebar(page, "Memory");
	await away.waitHeld(1, "the way out's save is on its way");
	await away.fail();
	await page.unroute(ORDER_ROUTE);
	await backHome(page);
	await page.locator(".room-sort-save-error").waitFor({ timeout: 10_000 });
	assert((await page.locator(".room-sort-save-error").textContent()) === ROOM_ARRANGE_FAILED_AWAY, `the next visit says it, got ${await page.locator(".room-sort-save-error").textContent()}`);
	assert(await arrangeButton(page).isVisible() && await doneButton(page).count() === 0, "beside Arrange, at rest");
	assert(!(await page.locator("body").innerText()).includes("server logs"), "never in the server's words");
	await startArranging(page);
	assert(await page.locator(".room-sort-save-error").count() === 0, `Arrange on the next visit shows no line before Done is pressed, got ${await page.locator(".room-sort-save-error").allTextContents()}`);
	await page.keyboard.press("Escape");
	await waitUntil(() => atRest(page), "Escape on the next visit");
	console.log("  ok  a save that failed after Home was left is said on the next visit, beside Arrange, and not again on opening Arrange");

	assert(boxes.length === 0, `no system box at any point, got ${JSON.stringify(boxes)}`);
	await page.context().close();
}

/** A folder where the saved order belongs: at rest, the line that says to remove it wins over a failed save's; while arranging, a failed Done says its own line, since "shown A to Z" is untrue of the cards being moved. */
async function checkBlocked(browser: Browser): Promise<void> {
	const { page, boxes } = await openHome(browser);
	const blocked = { order: { mode: "name-asc", customOrder: [], unreadable: "it is a folder, not a file", saveBlocked: true }, modes: ROOM_ORDER_MODES };
	await page.route(ORDER_ROUTE, (route) => (route.request().method() === "PUT"
		? route.fulfill({ status: 400, contentType: "application/json", body: JSON.stringify({ error: "The order was not saved: a folder was found where the saved order belongs. Remove that folder, then choose the order again." }) })
		: route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(blocked) })));
	await page.reload();
	await page.locator(".room-sort-btn").first().waitFor({ timeout: 15_000 });
	const folderLine = page.locator(".room-sort-problem");
	await waitUntil(async () => (await folderLine.textContent())?.includes("Remove that folder") ?? false, "at rest, the line says to remove the folder");
	await page.locator(".room-sort-btn").first().click();
	await page.getByRole("menuitemradio", { name: /Custom/ }).click();
	await doneButton(page).waitFor({ timeout: 10_000 });
	await doneButton(page).click();
	await waitUntil(async () => (await doneButton(page).isEnabled()) && (await page.locator(".room-arrange-line .room-sort-problem").count()) === 1, "the refused Done is said");
	const arrangingLine = await page.locator(".room-arrange-line .room-sort-problem").textContent();
	assert(arrangingLine === ROOM_ARRANGE_DONE_FAILED, `while arranging, a failed Done says its own line, never "shown A to Z", got ${arrangingLine}`);
	await page.keyboard.press("Escape");
	await waitUntil(async () => (await doneButton(page).count()) === 0, "Escape ends arranging");
	assert((await folderLine.textContent())?.includes("Remove that folder"), `at rest, the folder's line still wins, got ${await folderLine.textContent()}`);
	assert(boxes.length === 0, `no system box, got ${JSON.stringify(boxes)}`);
	console.log("  ok  a folder where the saved order belongs: at rest its line wins over a failed save's; arranging, a failed Done keeps its own");
	await page.context().close();
}

/** At phone width with a finger: the touch hint, the arrows up and down and finger-sized, a tap moves, a hold on an arrow carries nothing. */
async function checkPhone(browser: Browser): Promise<void> {
	const { page, saves, boxes } = await openHome(browser, true);
	await startArranging(page);
	assert((await page.locator(".room-arrange-hint").textContent()) === ROOM_ARRANGE_HINT_TOUCH, `the touch hint, got ${await page.locator(".room-arrange-hint").textContent()}`);
	const current = await shownOrder(page);
	const earlier = (name: string) => slotOf(page, name).getByRole("button", { name: ROOM_ARRANGE_MOVE_EARLIER, exact: true });
	const later = (name: string) => slotOf(page, name).getByRole("button", { name: ROOM_ARRANGE_MOVE_LATER, exact: true });
	for (const arrow of [earlier(current[1]), later(current[1])]) {
		const size = (await arrow.boundingBox())!;
		assert(size.width >= 44 && size.height >= 44, `an arrow at phone width is at least 44 px, got ${size.width}×${size.height}`);
	}
	const facing = (which: ReturnType<typeof earlier>) => which.locator("svg").evaluate((svg) => {
		const { a, b } = new DOMMatrix(getComputedStyle(svg).transform);
		return Math.abs(Math.round(Math.atan2(b, a) * 180 / Math.PI));
	});
	const facings = [await facing(earlier(current[1])), await facing(later(current[1]))];
	assert(facings.join() === "180,0", `in one column, the arrows point up and down, got ${facings.join()} (${await page.evaluate(() => window.innerWidth)} px wide)`);
	await later(current[0]).tap();
	await orderIs(page, [current[1], current[0], current[2]], "a tap on later moves the room one place");
	await waitUntil(async () => (await announced(page)) === `${current[0]}, position 2 of 3`, "and is announced");

	// A finger held on an arrow carries nothing; the same hold on the card's name carries it.
	const cdp = await page.context().newCDPSession(page);
	const hold = async (x: number, y: number) => {
		await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x, y }] });
		await page.waitForTimeout(ROOM_LONG_PRESS_MS + 300);
	};
	const lift = () => cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
	const arrowBox = (await earlier(current[2]).boundingBox())!;
	const before = await shownOrder(page);
	await hold(arrowBox.x + arrowBox.width / 2, arrowBox.y + arrowBox.height / 2);
	assert(await page.locator(".room-arrange-slot.is-dragging").count() === 0, "a finger held on an arrow carries nothing");
	await lift();
	await settleFor(page);
	await orderIs(page, [before[0], before[2], before[1]], "lifted, the hold is the arrow's press: one place earlier, no drop");
	const titleBox = (await slotOf(page, current[2]).locator("h2").boundingBox())!;
	await hold(titleBox.x + 5, titleBox.y + 5);
	await page.locator(".room-arrange-slot.is-dragging").waitFor({ timeout: 3_000 });
	await lift();
	await page.locator(".room-arrange-slot.is-dragging").waitFor({ state: "detached", timeout: 5_000 });
	assert(await doneButton(page).isVisible(), "still arranging");
	await doneButton(page).click();
	await waitUntil(() => atRest(page), "Done on a phone");
	assert(saves.length === 1, `one request, got ${saves.length}`);
	assert(boxes.length === 0, `no system box, got ${JSON.stringify(boxes)}`);
	console.log("  ok  at phone width: the touch hint, arrows up and down and 44 px, a tap moves one place, a hold on an arrow carries nothing");
	await page.context().close();
}

try {
	const agents = await import("../src/persistent-agents.js");
	for (const displayName of ROOMS) agents.createPersistentAgentFromScaffoldInput({ displayName, userName: "Synthetic User", preferredUserAddress: "Synthetic User" });

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
		await checkFirstCustom(browser);
		await checkDesktop(browser);
		await checkBlocked(browser);
		await checkPhone(browser);
	} finally {
		await browser.close();
	}
	console.log("room-order-arrange-ui smoke: ok");
} catch (error) {
	console.error(serverOutput.join("").slice(-4000));
	throw error;
} finally {
	await stopSmokeServer(server);
	fs.rmSync(tempRoot, { recursive: true, force: true });
}
