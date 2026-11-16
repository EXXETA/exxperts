// Back and Forward, in the browser: they move between Home, a room and
// Maintain as on a normal website, each screen has its own address, and a
// reload on a room's address opens that room again. Both desktop apps' arrows
// and keys make the same moves: room to Home to Memory and back, grey at each
// end, the Windows app's by clicks at 80%, 100% and 125% zoom and in a narrow
// window; nothing moves behind Settings, the Shortcuts window or
// text being composed; Home's arrangement is kept on a history move, with no
// question; a slow Forward into a room followed by
// Back ends on Home and deletes nothing, a slow leave followed by Back keeps
// every entry, and a screen the person picks meanwhile is the later move. A
// browser shows no arrows and adds no key.
//
// Offline: no model is called; the room's model points at a closed port.
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, type Browser, type Page, type Request, type Route } from "playwright";
import { SMOKE_AUTH_TOKEN, SMOKE_SERVER_AUTH_ENV, SMOKE_SERVER_SPAWN_TREE_OPTIONS, smokeHomeEnv, stopSmokeServer, freePort } from "./smoke-server-process.js";
import { waitEvery } from "./smoke-wait.js";

const MAC_APP = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/138.0.0.0 Safari/537.36 ExxpertsDesktop/0.14.3";
const WINDOWS_APP = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/138.0.0.0 Safari/537.36 ExxpertsDesktop/0.14.3";

const waitUntil = waitEvery(150);

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

let server: ChildProcessWithoutNullStreams | undefined;
const serverOutput: string[] = [];

async function openApp(browser: Browser, userAgent: string, viewport = { width: 1280, height: 900 }, deviceScaleFactor = 1): Promise<Page> {
	const page = await (await browser.newContext({ viewport, deviceScaleFactor, userAgent })).newPage();
	await page.goto(`${baseUrl}/auth/session?token=${SMOKE_AUTH_TOKEN}`);
	await page.waitForLoadState("networkidle");
	const dismiss = page.locator(".whats-new-close");
	if (await dismiss.count()) await dismiss.click();
	await page.locator(".persistent-agent-card").first().waitFor({ timeout: 20_000 });
	return page;
}

/** The first entry has no hash at all: it is Home's address too. */
const shownHash = (page: Page) => page.evaluate(() => window.location.hash || "#/");

/** A move that must not happen has no state to wait on: the page gets time to make it, and each such check has a neighbour where the same input moves. */
const notMoved = async (page: Page, hash: string, label: string) => {
	await page.waitForTimeout(300);
	const now = await shownHash(page);
	assert(now === hash, `${label}: the page stays on ${hash}, got ${now}`);
};
const atHash = (page: Page, hash: string, label: string) => waitUntil(async () => (await shownHash(page)) === hash, `${label} (${hash})`);

const [HOME, ROOM, MEMORY] = [".home-page", ".sidebar-home-btn", '.product-nav .list-btn.active:text-is("Memory")'];

/** The arrows on a desktop app's page, and the waits on where it is. */
function arrowControls(page: Page, agentId: string) {
	const back = page.locator(".history-arrows").getByRole("button", { name: "Back", exact: true });
	const forward = page.locator(".history-arrows").getByRole("button", { name: "Forward", exact: true });
	const state = async () => [await back.isEnabled(), await forward.isEnabled()].join();
	return {
		room: `#/room/${agentId}`,
		back,
		forward,
		card: page.locator(".persistent-agent-card").filter({ hasText: "History Room" }),
		arrows: (expected: string, label: string) => waitUntil(async () => (await state()) === expected, `${label}: the arrows' state ${expected}`),
		on: async (hash: string, shown: string, label: string) => {
			await atHash(page, hash, label);
			await page.locator(shown).first().waitFor({ timeout: 15_000 });
		},
	};
}

/** From a fresh start, room to Home to Memory, then Back twice and Forward twice by clicks: it ends on Memory. The room's way home marks the room: the sidebar's, or in a narrow window the top bar's. */
async function walkRoomHomeMemory({ room, back, forward, card, arrows, on }: ReturnType<typeof arrowControls>, page: Page, homeButton = ROOM): Promise<void> {
	// Room to Home to Memory: entries Home, the room, Home, Memory.
	await arrows("false,false", "a fresh start has nowhere to go");
	// Enter while the room has no conversation yet, Resume once an earlier check left one.
	await card.getByRole("button", { name: /^(Enter|Resume)$/ }).click();
	await on(room, homeButton, "the room opens");
	await arrows("true,false", "in the room");
	await page.locator(homeButton).click();
	await on("#/", HOME, "Home");
	await page.locator(".product-nav").getByRole("button", { name: "Memory", exact: true }).click();
	await on("#/memory", MEMORY, "Memory");
	await arrows("true,false", "on Memory, Forward is grey");
	await back.click();
	await on("#/", HOME, "the first Back lands on Home");
	await arrows("true,true", "in the middle");
	await back.click();
	await on(room, homeButton, "the second Back lands in the room");
	await forward.click();
	await on("#/", HOME, "the first Forward lands on Home");
	await forward.click();
	await on("#/memory", MEMORY, "the second Forward lands on Memory");
	await arrows("true,false", "at the end, Forward is grey");
}

/** The mac app: arrows and keys, in the moves a person makes. */
async function checkMacApp(browser: Browser, agentId: string): Promise<void> {
	const page = await openApp(browser, MAC_APP);
	const controls = arrowControls(page, agentId);
	const { room, back, forward, card, arrows, on } = controls;
	await walkRoomHomeMemory(controls, page);
	console.log("  ok  the arrows go room to Home to Memory and back, Forward grey at its end");

	// The keys make the same moves, Back grey at the first entry.
	for (const [hash, shown] of [["#/", HOME], [room, ROOM], ["#/", HOME]] as const) {
		await page.keyboard.press("Meta+[");
		await on(hash, shown, "⌘[ moves back");
	}
	await arrows("false,true", "at the first entry, Back is grey");
	await page.keyboard.press("Meta+[");
	await notMoved(page, "#/", "⌘[ at the first entry");
	for (const [hash, shown] of [[room, ROOM], ["#/", HOME], ["#/memory", MEMORY]] as const) {
		await page.keyboard.press("Meta+]");
		await on(hash, shown, "⌘] moves forward");
	}
	await page.keyboard.press("Alt+ArrowLeft");
	await notMoved(page, "#/memory", "the Windows keys on the mac app");
	console.log("  ok  ⌘[ and ⌘] make the same moves, and Back is grey at the first entry");

	// Nothing moves behind a dialog or during text composition; the same key moves once they are gone.
	await page.keyboard.press("Meta+,");
	const settings = page.locator('.settings-dialog[aria-modal="true"], [aria-modal="true"]:has(.settings-dialog)').first();
	await settings.waitFor({ timeout: 10_000 });
	await page.keyboard.press("Meta+[");
	await notMoved(page, "#/memory", "⌘[ with Settings open");
	await back.evaluate((button) => (button as HTMLButtonElement).click());
	await notMoved(page, "#/memory", "the Back button pressed behind Settings");
	const onTop = await back.evaluate((button) => {
		const box = button.getBoundingClientRect();
		return button.contains(document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2));
	});
	assert(!onTop, "Settings' backdrop covers the arrows");
	await page.keyboard.press("Escape");
	await settings.waitFor({ state: "detached", timeout: 10_000 });
	const composedKey = (composing: boolean) => page.evaluate((isComposing) => document.body.dispatchEvent(new KeyboardEvent("keydown", { key: "[", metaKey: true, isComposing, bubbles: true, cancelable: true })), composing);
	await composedKey(true);
	await notMoved(page, "#/memory", "⌘[ during text composition");
	await composedKey(false);
	await on("#/", HOME, "⌘[ once composition is over");
	await page.keyboard.press("Meta+/");
	const keys = page.getByRole("dialog", { name: "Shortcuts" });
	await keys.waitFor({ timeout: 10_000 });
	const row = await keys.locator("tr").filter({ hasText: "Back, Forward" }).locator("kbd").allTextContents();
	assert(row.join() === "⌘[,⌘]", `the keys list names the mac keys, got ${JSON.stringify(row)}`);
	await page.keyboard.press("Meta+]");
	await notMoved(page, "#/", "⌘] with the keys list open");
	await page.keyboard.press("Escape");
	await keys.waitFor({ state: "detached", timeout: 10_000 });
	console.log("  ok  the keys and the arrows do nothing behind Settings or the keys list, or during text composition, and the keys are listed");

	// Home's arrangement is kept on a history move, Back or Forward, and nothing is asked.
	const boxes: string[] = [];
	page.on("dialog", (dialog) => { boxes.push(dialog.message()); void dialog.dismiss(); });
	const orderSaves: { mode: string; customOrder?: string[] }[] = [];
	page.on("request", (request) => {
		if (request.method() === "PUT" && request.url().endsWith("/api/settings/room-order")) orderSaves.push(JSON.parse(request.postData() ?? "{}"));
	});
	const slotIds = () => page.locator("[data-arrange-slot]").evaluateAll((slots) => slots.map((slot) => (slot as HTMLElement).dataset.arrangeSlot ?? ""));
	const names = () => page.locator(".landing-grid .persistent-agent-card h2").allTextContents();
	const arrangeAndMove = async (): Promise<{ ids: string[]; shown: string[] }> => {
		const before = (await slotIds()).join();
		await page.locator("[data-arrange-slot]").first().focus();
		await page.keyboard.press("ArrowRight");
		await waitUntil(async () => (await slotIds()).join() !== before, "the arrangement moved");
		return { ids: await slotIds(), shown: await names() };
	};
	await page.locator(".room-sort-btn").first().click();
	await page.getByRole("menuitemradio", { name: /Custom/ }).click();
	await page.locator(".room-arrange-done").waitFor({ timeout: 10_000 });
	for (const [arrow, name, there, shown] of [[forward, "Forward", "#/memory", MEMORY], [back, "Back", room, ROOM]] as const) {
		if (name === "Back") {
			await page.locator(".room-sort-arrange").click();
			await page.locator(".room-arrange-done").waitFor({ timeout: 10_000 });
		}
		const arranged = await arrangeAndMove();
		const sent = orderSaves.length;
		await arrow.click();
		await on(there, shown, `${name} leaves Home while arranging`);
		await waitUntil(() => orderSaves.length === sent + 1, `${name} keeps the order: one request`);
		assert(orderSaves.at(-1)?.mode === "custom" && orderSaves.at(-1)?.customOrder?.join() === arranged.ids.join(), `${name} sends the whole order, got ${JSON.stringify(orderSaves.at(-1))}`);
		await (name === "Back" ? forward : back).click();
		await on("#/", HOME, `back on Home after ${name}`);
		await page.locator(".room-sort-arrange").waitFor({ timeout: 10_000 });
		await waitUntil(async () => (await names()).join() === arranged.shown.join(), `after ${name}, Home shows the order kept`);
	}
	assert(boxes.length === 0, `a history move while arranging asks nothing, got ${JSON.stringify(boxes)}`);
	const sentAtRest = orderSaves.length;
	await back.click();
	await on(room, ROOM, "at rest, Back just goes");
	assert(orderSaves.length === sentAtRest, "at rest, leaving sends nothing");
	console.log("  ok  Home's arrangement is kept on a history move, Back or Forward, and nothing is asked");

	// A slow Forward into a room, then Back: Home stays, on a fresh conversation and on a waiting one.
	await back.click();
	await on("#/", HOME, "Home again");
	const roomStatus = () => page.evaluate(async (id) => (await (await fetch(`/api/persistent-agents/${encodeURIComponent(id)}/status`)).json()) as { runtime: { state: string; activeThreadId: string | null } }, agentId);
	const threadSave = /\/api\/persistent-agents\/[^/]+\/threads\/[^/]+$/;
	const slowForward = async (label: string) => {
		let held: Route | undefined;
		await page.route(threadSave, (route) => {
			if (route.request().method() === "PUT" && !held) held = route;
			else void route.continue();
		});
		await forward.click();
		await waitUntil(() => !!held, `${label}: the room's opening reaches the server`);
		await back.click();
		await atHash(page, "#/", `${label}: Back is on Home`);
		await held!.continue();
		await page.unroute(threadSave);
		await notMoved(page, "#/", `${label}: the slow opening finishing`);
		assert(await page.locator(HOME).isVisible() && await page.locator(ROOM).count() === 0, `${label}: Home stays on screen`);
		await arrows("false,true", `${label}: back on the first entry`);
	};
	// A move that made a request and was overtaken before it answered: the room is not taken up.
	const overtakenAfter = async (label: string, held: (request: Request) => boolean) => {
		let waiting: Route | undefined;
		const opened: string[] = [];
		await page.route(threadSave, (route) => {
			if (route.request().method() === "PUT" && route.request().postData()?.includes('"state":"active"')) opened.push(route.request().url());
			void route.fallback();
		});
		await page.route(/\/api\/persistent-agents\//, (route) => {
			if (!waiting && held(route.request())) waiting = route;
			else void route.fallback();
		});
		await forward.click();
		await waitUntil(() => !!waiting, `${label}: the request reaches the server`);
		await back.click();
		await atHash(page, "#/", `${label}: Back is on Home`);
		await waiting!.continue();
		await notMoved(page, "#/", `${label}: its answer arriving`);
		await page.unrouteAll();
		assert(opened.length === 0, `${label}: the room is not taken up, got ${opened.join()}`);
		assert(await page.locator(HOME).isVisible(), `${label}: Home stays on screen`);
	};
	let deletes = 0;
	const countDelete = (request: Request) => { if (request.method() === "DELETE" && threadSave.test(request.url())) deletes += 1; };
	page.on("request", countDelete);
	await slowForward("a fresh conversation");
	await waitUntil(async () => !!(await roomStatus()).runtime.activeThreadId, "the conversation the overtaken opening made waits in the room");
	await notMoved(page, "#/", "the overtaken opening let go");
	page.off("request", countDelete);
	assert(deletes === 0, `nothing deletes what an overtaken opening made, got ${deletes}`);
	await forward.click();
	await on(room, ROOM, "Forward, now not overtaken, opens the room");
	await back.click();
	await on("#/", HOME, "Home again");
	await waitUntil(async () => (await roomStatus()).runtime.state === "idle", "leaving the empty conversation discards it");
	console.log("  ok  an overtaken opening deletes nothing, and a normal leave discards the empty conversation it left");

	// An empty conversation a save prepared is retired on the way in: a Back during that leaves the room alone.
	await page.evaluate(async (id) => {
		const res = await fetch(`/api/persistent-agents/${encodeURIComponent(id)}/threads/postcp_overtaken`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ state: "standby", origin: "checkpoint", model: { provider: "fake-gpt", model: "gpt-fake", label: "GPT Fake" }, items: [] }) });
		if (!res.ok) throw new Error(`seeding the prepared conversation: ${res.status}`);
	}, agentId);
	await page.reload();
	await page.locator(HOME).waitFor({ timeout: 15_000 });
	await arrows("false,true", "the prepared conversation seeded");
	await overtakenAfter("retiring a prepared conversation", (request) => request.url().endsWith("/runtime/discard-empty-prepared-boundary"));
	await waitUntil(async () => (await roomStatus()).runtime.state === "idle", "the prepared conversation is retired");
	console.log("  ok  a Back while a prepared conversation is retired opens nothing");

	// The server took the opening, but its answer comes late: a Forward after the Back takes that conversation up, and the late answer leaves it alone.
	let lateAnswer: (() => Promise<void>) | undefined;
	let saves = 0;
	await page.route(threadSave, async (route) => {
		if (route.request().method() === "PUT") saves += 1;
		if (route.request().method() === "PUT" && !lateAnswer) {
			const response = await route.fetch();
			lateAnswer = () => route.fulfill({ response });
		} else await route.continue();
	});
	await forward.click();
	await waitUntil(() => !!lateAnswer, "the opening reaches the server");
	await back.click();
	await on("#/", HOME, "Back while its answer is late");
	await waitUntil(() => saves >= 2, "the page's own save of the opening lands");
	await forward.click();
	await on(room, ROOM, "Forward takes the conversation up");
	const takenUp = (await roomStatus()).runtime.activeThreadId;
	await lateAnswer!();
	await page.unroute(threadSave);
	await notMoved(page, room, "the late answer");
	assert(await page.locator(ROOM).isVisible() && (await roomStatus()).runtime.activeThreadId === takenUp && takenUp, `the late answer leaves the room and its conversation, got ${JSON.stringify((await roomStatus()).runtime)}, had ${takenUp}`);
	console.log("  ok  a late answer to an overtaken opening leaves the conversation a later Forward took up");
	await back.click();
	await on("#/", HOME, "Home again");
	await page.evaluate(async (id) => {
		const res = await fetch(`/api/persistent-agents/${encodeURIComponent(id)}/threads/waiting-conversation`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ state: "standby", origin: "home", model: { provider: "fake-gpt", model: "gpt-fake", label: "GPT Fake" }, items: [{ kind: "user", id: "u1", text: "Plan the launch." }, { kind: "assistant", id: "a1", text: "Noted." }] }) });
		if (!res.ok) throw new Error(`seeding the conversation: ${res.status}`);
	}, agentId);
	await page.reload();
	await card.getByRole("button", { name: "Resume" }).waitFor({ timeout: 15_000 });
	await slowForward("a waiting conversation");
	await overtakenAfter("reading a waiting conversation", (request) => request.method() === "GET" && threadSave.test(request.url()));
	await forward.click();
	await on(room, ROOM, "Forward, now not overtaken, opens the waiting conversation");
	await page.getByText("Plan the launch.").first().waitFor({ timeout: 10_000 });
	console.log("  ok  a slow Forward into a room followed by Back ends on Home, and the next Forward opens the room");

	// An overtaken opening that fails stays quiet: the screen the person went on to keeps them.
	await back.click();
	await on("#/", HOME, "Home again");
	let failing: Route | undefined;
	await page.route(threadSave, (route) => {
		if (route.request().method() === "PUT" && !failing) failing = route;
		else void route.continue();
	});
	await forward.click();
	await waitUntil(() => !!failing, "the opening reaches the server");
	await back.click();
	await on("#/", HOME, "Back while the opening waits");
	await page.locator(".product-nav").getByRole("button", { name: "Memory", exact: true }).click();
	await on("#/memory", MEMORY, "Memory, while the opening still waits");
	await failing!.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ error: "synthetic failure" }) });
	await page.unroute(threadSave);
	await notMoved(page, "#/memory", "the overtaken opening failing");
	await page.locator(MEMORY).first().waitFor({ timeout: 5_000 });
	console.log("  ok  an overtaken opening that fails leaves the screen the person went on to");
	await back.click();
	await on("#/", HOME, "Home again");
	await page.reload();
	await card.getByRole("button", { name: "Resume" }).waitFor({ timeout: 15_000 });
	await card.getByRole("button", { name: "Resume" }).click();
	await on(room, ROOM, "the room again");

	// Leaving a room slowly for Memory, then Back again: the later move wins, so Home stays when the leave finishes.
	await back.click();
	await on("#/", HOME, "Home again");
	await page.locator(".product-nav").getByRole("button", { name: "Memory", exact: true }).click();
	await on("#/memory", MEMORY, "Memory");
	await page.evaluate((address) => { window.location.hash = address; }, room);
	await on(room, ROOM, "the room's address followed from Memory");
	let heldLeave: Route | undefined;
	await page.route(threadSave, (route) => {
		if (!heldLeave && route.request().postData()?.includes('"state":"standby"')) heldLeave = route;
		else void route.continue();
	});
	await back.click();
	await waitUntil(() => !!heldLeave, "the room's leave reaches the server");
	await back.click();
	await atHash(page, "#/", "the later Back's address");
	await heldLeave!.continue();
	await page.unroute(threadSave);
	await on("#/", HOME, "the later Back lands on Home once the leave is done");
	await notMoved(page, "#/", "the slow leave finishing");
	assert(await page.locator(HOME).isVisible(), "the slow leave does not take the screen to Memory");
	console.log("  ok  a slow leave for Memory followed by Back ends on Home");

	// Leaving a room slowly, then Back into it: the later move wins here too, and the room is open again.
	await forward.click();
	await on("#/memory", MEMORY, "Memory");
	await forward.click();
	await on(room, ROOM, "the room again");
	await page.locator(".sidebar-home-btn").click();
	await on("#/", HOME, "Home, a new entry after the room");
	await back.click();
	await on(room, ROOM, "Back into the room");
	let heldReturn: Route | undefined;
	await page.route(threadSave, (route) => {
		if (!heldReturn && route.request().postData()?.includes('"state":"standby"')) heldReturn = route;
		else void route.continue();
	});
	await forward.click();
	await waitUntil(() => !!heldReturn, "the room's leave reaches the server");
	await back.click();
	await atHash(page, room, "Back while the leave waits");
	await heldReturn!.continue();
	await page.unroute(threadSave);
	await on(room, ROOM, "the room opens again once the leave is done");
	await page.getByText("Plan the launch.").first().waitFor({ timeout: 10_000 });
	await notMoved(page, room, "after the slow leave");
	await arrows("true,true", "the entry after the room is kept");
	await forward.click();
	await on("#/", HOME, "Forward to the entry after the room");
	await back.click();
	await on(room, ROOM, "Back into the room again");
	console.log("  ok  a slow leave followed by Back into the same room ends in the room, every entry kept");

	// A screen the person goes to while a move passes Home is the later move: it gets an entry of its own, and the move stops.
	let heldPassing: Route | undefined;
	const passingLists: Route[] = [];
	let holdingPassing = true;
	await page.route(threadSave, (route) => {
		if (!heldPassing && route.request().postData()?.includes('"state":"standby"')) heldPassing = route;
		else void route.continue();
	});
	await forward.click();
	await waitUntil(() => !!heldPassing, "the room's leave reaches the server");
	await back.click();
	await atHash(page, room, "Back while the leave waits");
	await page.route(/\/api\/persistent-agents(\?.*)?$/, (route) => {
		if (holdingPassing && route.request().method() === "GET") passingLists.push(route);
		else void route.continue();
	});
	await heldPassing!.continue();
	await waitUntil(() => passingLists.length > 0, "the move back reads the room list");
	await page.locator(HOME).waitFor({ timeout: 10_000 });
	await page.locator(".product-nav").getByRole("button", { name: "Memory", exact: true }).click();
	await atHash(page, "#/memory", "Memory's address, with the move still reading the list");
	holdingPassing = false;
	for (const list of passingLists) await list.continue();
	await page.unrouteAll();
	await notMoved(page, "#/memory", "the move's late room list");
	assert(await page.locator(MEMORY).first().isVisible(), "Memory stays on screen");
	await back.click();
	await on(room, ROOM, "Back to the room the person was going to");
	await page.getByText("Plan the launch.").first().waitFor({ timeout: 10_000 });
	await arrows("true,true", "Memory's entry follows the room's");
	await forward.click();
	await on("#/memory", MEMORY, "Forward to Memory");
	await back.click();
	await on(room, ROOM, "Back to the room again");
	console.log("  ok  a screen the person goes to while a move passes Home has its own entry, and the move stops");

	// An older read settling says nothing of a newer move still reading: the newer move opens the room, every entry kept.
	await page.locator(".sidebar-home-btn").click();
	await on("#/", HOME, "Home before the room");
	await card.getByRole("button", { name: "Resume" }).click();
	await on(room, ROOM, "the room");
	await page.locator(".sidebar-home-btn").click();
	await on("#/", HOME, "Home after the room");
	await page.locator(".product-nav").getByRole("button", { name: "Memory", exact: true }).click();
	await on("#/memory", MEMORY, "Memory after that");
	await back.click();
	await on("#/", HOME, "Back to Home");
	await back.click();
	await on(room, ROOM, "Back to the room");
	await back.click();
	await on("#/", HOME, "Back to Home before the room");
	await notMoved(page, "#/", "Home settled");
	const heldReads: Route[] = [];
	let holdingReads = true;
	await page.route(threadSave, (route) => {
		if (holdingReads && route.request().method() === "GET") heldReads.push(route);
		else void route.continue();
	});
	await forward.click();
	await waitUntil(() => heldReads.length === 1, "the first Forward reads the conversation");
	await back.click();
	await atHash(page, "#/", "Back while it reads");
	await forward.click();
	await waitUntil(() => heldReads.length === 2, "the next Forward reads it too");
	await heldReads[0].continue();
	await notMoved(page, room, "the older read settling");
	holdingReads = false;
	for (const read of heldReads.slice(1)) await read.continue();
	await page.unrouteAll();
	await on(room, ROOM, "the newer Forward opens the room");
	await page.getByText("Plan the launch.").first().waitFor({ timeout: 10_000 });
	await arrows("true,true", "the entries after the room are kept");
	await forward.click();
	await on("#/", HOME, "Forward to the Home after the room");
	await forward.click();
	await on("#/memory", MEMORY, "Forward to Memory, the last entry");
	await back.click();
	await on("#/", HOME, "Back to Home");
	await back.click();
	await on(room, ROOM, "Back to the room");
	console.log("  ok  an older read settling leaves a newer Forward to open the room, every entry kept");

	// Two quick Backs out of a room run one leave: the room is closed once.
	await page.locator(".sidebar-home-btn").click();
	await on("#/", HOME, "Home");
	await page.locator(".product-nav").getByRole("button", { name: "Memory", exact: true }).click();
	await on("#/memory", MEMORY, "Memory");
	await page.evaluate(() => { window.location.hash = "#/"; });
	await on("#/", HOME, "Home by its address");
	await page.locator(".persistent-agent-card").filter({ hasText: "Other Room" }).getByRole("button", { name: "Enter" }).click();
	await waitUntil(async () => (await shownHash(page)).startsWith("#/room/other"), "the empty room opens");
	await page.locator(ROOM).waitFor({ timeout: 15_000 });
	const leaves: string[] = [];
	page.on("response", (response) => { if (response.request().method() === "DELETE" && threadSave.test(response.url())) leaves.push(String(response.status())); });
	await page.evaluate(() => { window.history.back(); window.history.back(); });
	await on("#/memory", MEMORY, "two quick Backs land two entries back");
	await waitUntil(() => leaves.length > 0, "the empty conversation is discarded");
	await notMoved(page, "#/memory", "after the two Backs");
	assert(leaves.join() === "200", `one leave, which worked, got ${leaves.join()}`);
	console.log("  ok  two quick Backs out of an empty room run one leave");

	// A move overtaken while it reads the room list after a leave never opens its room over the one the person went on to.
	await page.evaluate((address) => { window.location.hash = address; }, room);
	await on(room, ROOM, "the room with a conversation");
	await page.locator(".sidebar-home-btn").click();
	await on("#/", HOME, "Home");
	await page.locator(".persistent-agent-card").filter({ hasText: "Other Room" }).getByRole("button", { name: "Enter" }).click();
	await waitUntil(async () => (await shownHash(page)).startsWith("#/room/other"), "the empty room opens");
	await page.locator(ROOM).waitFor({ timeout: 15_000 });
	const other = await shownHash(page);
	await page.locator(".sidebar-home-btn").click();
	await on("#/", HOME, "Home after the empty room");
	await back.click();
	await on(other, ROOM, "Back into the empty room");
	let heldDiscard: Route | undefined;
	const heldLists: Route[] = [];
	let holdingLists = true;
	await page.route(threadSave, (route) => {
		if (!heldDiscard && route.request().method() === "DELETE") heldDiscard = route;
		else void route.continue();
	});
	await forward.click();
	await waitUntil(() => !!heldDiscard, "the empty room's leave reaches the server");
	await back.click();
	await atHash(page, other, "Back while the leave waits");
	await page.route(/\/api\/persistent-agents(\?.*)?$/, (route) => {
		if (holdingLists && route.request().method() === "GET") heldLists.push(route);
		else void route.continue();
	});
	await heldDiscard!.continue();
	await waitUntil(() => heldLists.length > 0, "the returning move reads the room list");
	await back.click();
	await on("#/", HOME, "on through Home");
	await back.click();
	await on(room, ROOM, "on to the room with a conversation");
	await page.getByText("Plan the launch.").first().waitFor({ timeout: 10_000 });
	holdingLists = false;
	for (const list of heldLists) await list.continue();
	await page.unrouteAll();
	await notMoved(page, room, "the late room list");
	assert(await page.getByText("Plan the launch.").first().isVisible(), "the late room list leaves the room's conversation on screen");
	console.log("  ok  a late room list from an overtaken move leaves the room the person went on to");
	await page.context().close();
}

/** The Windows app: the arrows by clicks at each zoom, a 1280x900 window's page in CSS px, then the keys. */
async function checkWindowsApp(browser: Browser, agentId: string): Promise<void> {
	for (const zoom of [0.8, 1, 1.25]) {
		const page = await openApp(browser, WINDOWS_APP, { width: Math.round(1280 / zoom), height: Math.round(900 / zoom) }, zoom);
		const controls = arrowControls(page, agentId);
		await walkRoomHomeMemory(controls, page).catch((caught: Error) => { throw new Error(`at ${zoom * 100}% zoom: ${caught.message}`); });
		for (const [hash, shown] of [["#/", HOME], [controls.room, ROOM], ["#/", HOME]] as const) {
			await controls.back.click();
			await controls.on(hash, shown, `at ${zoom * 100}% zoom, Back on to the first entry`);
		}
		await controls.arrows("false,true", `at ${zoom * 100}% zoom, at the first entry, Back is grey`);
		await page.context().close();
	}
	// A narrow window: Home and Memory show their top bar, and the arrows over it.
	const narrow = await openApp(browser, WINDOWS_APP, { width: 700, height: 900 });
	await walkRoomHomeMemory(arrowControls(narrow, agentId), narrow, ".topbar-home-btn").catch((caught: Error) => { throw new Error(`in a narrow window: ${caught.message}`); });
	await narrow.context().close();
	console.log("  ok  the Windows app's arrows go room to Home to Memory and back by clicks at 80%, 100% and 125% zoom and in a narrow window, each grey at its end");
	const page = await openApp(browser, WINDOWS_APP);
	await page.locator(".product-nav").getByRole("button", { name: "Memory", exact: true }).click();
	await atHash(page, "#/memory", "Memory");
	await page.keyboard.press("Alt+ArrowLeft");
	await atHash(page, "#/", "Alt+Left moves back");
	await page.keyboard.press("Alt+ArrowRight");
	await atHash(page, "#/memory", "Alt+Right moves forward");
	await page.keyboard.press("Meta+[");
	await notMoved(page, "#/memory", "the mac keys on the Windows app");
	await page.keyboard.press("Control+Alt+ArrowLeft");
	await notMoved(page, "#/memory", "AltGr with an arrow");
	await page.keyboard.press("Control+,");
	await page.locator('[aria-modal="true"]').first().waitFor({ timeout: 10_000 });
	await page.keyboard.press("Alt+ArrowLeft");
	await notMoved(page, "#/memory", "Alt+Left with Settings open");
	await page.keyboard.press("Escape");
	await page.locator('[aria-modal="true"]').first().waitFor({ state: "detached", timeout: 10_000 });
	await page.keyboard.press("Control+/");
	const row = await page.getByRole("dialog", { name: "Shortcuts" }).locator("tr").filter({ hasText: "Back, Forward" }).locator("kbd").allTextContents();
	assert(row.join() === "Alt+Left,Alt+Right", `the keys list names the Windows keys, got ${JSON.stringify(row)}`);
	await page.context().close();
	console.log("  ok  the Windows app has the keys");
}

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
	// A second room, so Home can be arranged.
	agents.createPersistentAgentFromScaffoldInput({ displayName: "Other Room", userName: "Synthetic User", preferredUserAddress: "Synthetic User" });
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
		await card.getByRole("button", { name: "Enter" }).click();
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

		// A browser has its own Back and Forward: the app adds no button and no key.
		assert(await page.locator(".history-arrows").count() === 0, "a browser shows no arrows");
		const inBrowser = await hash();
		for (const key of ["Alt+ArrowLeft", "Meta+["]) {
			await page.keyboard.press(key);
			await notMoved(page, inBrowser, `${key} in a browser`);
		}
		console.log("  ok  a browser gets no arrows and no keys");
		await ctx.close();

		await checkMacApp(browser, agentId);
		await checkWindowsApp(browser, agentId);
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
