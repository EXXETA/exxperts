// Settings, Connectors opened again, in the browser: the list it last had is
// there in the first frame, "Loading connectors…" never shows, and the
// Directory stays where it is when the fresh answer brings the same list. A
// connector whose state changed, was removed or was added between two visits
// reads as it is once the fresh answer is in, and nothing is checked before
// it. A read that fails keeps the list under its failure line. A click on a
// row while the fresh answer is on its way opens its page at once, saying
// Checking… until the answer is in: the page then says what the answer does,
// what was pressed on it meanwhile acts on that, and it goes back to the list
// where the connector is gone or the read fails. A button the answer no longer
// offers does nothing. Reloaded, nothing is kept. A room's
// Connectors opened again shows its rows in the first frame too, and one
// switched on elsewhere reads as on once the fresh answer is in, also after a
// switch that could not be saved; on a shared server none is kept. Nothing is
// written to the browser's storage.
//
// The world is real: a server on a scratch home and stand-in connectors on
// this computer. The list's answer is held in the page so its first frames
// can be read; the sign-in routes are answered in the page.
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import { fileURLToPath } from "node:url";
import { chromium, type Browser, type Page } from "playwright";
import { authedFetch, SMOKE_SERVER_AUTH_ENV, SMOKE_SERVER_SPAWN_TREE_OPTIONS, smokeHomeEnv, stopSmokeServer, freePort, waitForServer } from "./smoke-server-process.js";
import { waitEvery } from "./smoke-wait.js";
import { answered, assert, closeWindow, desktop, goToPage, lookPages, navItem, phone, same } from "./settings-look-smoke-parts.js";

{
	const p = typeof chromium?.executablePath === "function" ? chromium.executablePath() : "";
	if (!p || !fs.existsSync(p)) {
		console.log("connectors page keeps list ui smoke skipped (Chromium not installed)");
		process.exit(0);
	}
}

const waitUntil = waitEvery(100);
const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const webServerDir = path.resolve(scriptDir, "..");
const repoRoot = path.resolve(webServerDir, "..", "..");
const port = await freePort();
const baseUrl = `http://127.0.0.1:${port}`;

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "exxperts-connectors-kept-"));
const tempHome = path.join(tempRoot, "home");
const agentsRoot = path.join(tempHome, ".exxperts", "app", "personalized-agents");
const agentDir = path.join(tempHome, ".exxperts", "agent");
for (const dir of [agentsRoot, agentDir]) fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
process.env.HOME = tempHome;
process.env.USERPROFILE = tempHome;
process.env.EXXPERTS_CODING_AGENT_DIR = agentDir;
process.env.PI_CODING_AGENT_DIR = agentDir;
process.env.EXXETA_PERSISTENT_AGENTS_ROOT = agentsRoot;

const { CONNECTOR_WORDS: WORDS } = await import("../../web-ui/src/connector-rows.js");
const { CONNECTOR_REQUEST_LINES } = await import("../src/connector-form.js");

const ROOM = "Kept Room";
const { openPage, openWindow } = lookPages({ baseUrl, room: ROOM });

// --- The stand-in connectors on this computer: each path is one, and one listed in `refuses` wants a sign-in ---

const refuses = new Set<string>();
const standIns = http.createServer((req, res) => {
	let raw = "";
	req.on("data", (chunk) => { raw += chunk; });
	req.on("end", () => {
		if (refuses.has(new URL(req.url ?? "/", "http://x").pathname)) return void res.writeHead(401, { "content-type": "text/plain" }).end("sign in first");
		if (req.method !== "POST") return void res.writeHead(405).end();
		const message = JSON.parse(raw || "{}");
		if (message.id === undefined) return void res.writeHead(202).end();
		const result = message.method === "initialize" ? { protocolVersion: message.params?.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: "stand-in", version: "1.0.0" } }
			: message.method === "tools/list" ? { tools: [{ name: "search_pages", description: "Search.", inputSchema: { type: "object" } }] } : {};
		res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ jsonrpc: "2.0", id: message.id, result }));
	});
});
await new Promise<void>((resolve) => standIns.listen(0, "127.0.0.1", resolve));
const at = (where: string) => `http://127.0.0.1:${(standIns.address() as AddressInfo).port}${where}`;

const NAMES = ["Board", "Desk", "Maps", "Press", "Trips", "Wiki"];
const id = (name: string) => name.toLowerCase();

async function servers(method: "POST" | "DELETE", where: string, body?: object): Promise<void> {
	const answer = await authedFetch(`${baseUrl}/api/mcp/servers${where}`, { method, ...(body && { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }) });
	assert(answer.ok, `${method} ${where}: ${answer.status} ${await answer.text()}`);
}
/** Every connector there, connected and checked, and on in no room but Wiki. */
async function startWorld(): Promise<void> {
	refuses.clear();
	const listed = (await (await authedFetch(`${baseUrl}/api/mcp/status`)).json() as { servers: Array<{ name: string }> }).servers.map((one) => one.name);
	for (const name of listed.filter((one) => !NAMES.map(id).includes(one))) await servers("DELETE", `/${name}`);
	for (const name of NAMES) {
		if (!listed.includes(id(name))) await servers("POST", "", { name, url: at(`/${id(name)}/mcp`) });
		await servers("POST", `/${id(name)}/test`);
	}
	for (const name of NAMES) await grant(id(name), name === "Wiki");
}
async function grant(name: string, on: boolean): Promise<void> {
	const answer = await authedFetch(`${baseUrl}/api/persistent-agents/${roomId}/mcp-connectors`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: on ? "grant" : "revoke", name }) });
	assert(answer.ok, `${name} in the room: ${answer.status}`);
}

// --- The page's own requests ------------------------------------------------------------

/** What the list's reads get: answered as they come, held until `go`, or failed. */
class Reads {
	mode: "through" | "held" | "failed" = "through";
	/** Reads of the list asked for, and the checks and sign-ins the page started. */
	lists = 0;
	answered = 0;
	started: string[] = [];
	private waiting: Array<() => void> = [];
	async listen(page: Page): Promise<void> {
		await page.route("**/api/mcp/status*", async (route) => {
			this.lists++;
			if (this.mode === "held") await new Promise<void>((resolve) => this.waiting.push(resolve));
			if (this.mode === "failed") return void await route.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ error: CONNECTOR_REQUEST_LINES.loadFailed }) }).catch(() => undefined);
			await route.continue().catch(() => undefined);
		});
		await page.route(/\/api\/mcp\/servers\/[^/]+\/(login|test)(\/.*)?$/, async (route) => {
			const [, name, what] = /servers\/([^/]+)\/([^/]+)/.exec(new URL(route.request().url()).pathname)!;
			const signIn = what === "login";
			if (route.request().method() === "POST") this.started.push(`${what} ${name}`);
			if (signIn) return void await route.fulfill({ contentType: "application/json", body: JSON.stringify(route.request().method() === "POST" ? { ok: true } : { pending: false }) });
			await route.continue().catch(() => undefined);
		});
	}
	/** From now on each read waits for its own release, in the order asked. */
	async holdEach(page: Page): Promise<Array<() => void>> {
		const releases: Array<() => void> = [];
		this.answered = 0;
		await page.route("**/api/mcp/status*", async (route) => {
			this.lists++;
			await new Promise<void>((resolve) => releases.push(resolve));
			await route.continue().catch(() => undefined);
			await route.request().response().then((answer) => answer?.finished());
			this.answered++;
		});
		return releases;
	}
	go(mode: "through" | "failed" = "through"): void {
		this.mode = mode;
		for (const release of this.waiting.splice(0)) release();
	}
}

const paneOf = (page: Page) => page.locator(".settings-dialog-pane").filter({ visible: true }).first();
const rowOf = (page: Page, name: string) => paneOf(page).locator(".connector-item").filter({ has: page.locator(".connector-item-name-text", { hasText: new RegExp(`^${name}$`) }) });
const lineOf = async (page: Page, name: string) => (await rowOf(page, name).locator(".connector-item-state").textContent()) ?? "";
/** An open connector's page: the labels of its facts, each with its place, and where its tools start. */
const pagePlaces = (page: Page) => paneOf(page).locator(".connector-page").evaluate((element) => [
	...[...element.querySelectorAll(".connector-facts > .settings-row")].map((row) => `${row.querySelector(".settings-row-label")?.textContent} ${Math.round(row.getBoundingClientRect().top)}`),
	`tools ${Math.round(element.querySelector(".connector-tools-group")!.getBoundingClientRect().top)}`,
]);
/** What an open connector's page says its state is. */
const pageState = async (page: Page) => ((await paneOf(page).locator(".connector-page .connector-status-words").textContent()) ?? "").trim();
const names = (page: Page) => paneOf(page).locator(".connector-item-name-text").allTextContents();

interface Frame { loading: boolean; rows: string[]; directory: number | null }
/** Opens a page of the open window by its menu, reading every frame from the click on until `readFrames`: whether the loading line
 * shows, the rows' names, and where the Directory starts (a room's page has none). */
async function openRecording(page: Page, label: string, rows: string): Promise<void> {
	const back = page.locator(".settings-dialog-back");
	if (await back.isVisible()) await back.click();
	await navItem(page, label).evaluate((button, rowSelector) => {
		const w = window as any;
		w.__frames = [];
		w.__recording = true;
		const read = () => {
			const pane = [...document.querySelectorAll(".settings-dialog-pane")].find((one) => one.getClientRects().length);
			const shown = [...document.querySelectorAll(".connector-list-section, .room-connectors-section")].some((one) => one.getClientRects().length);
			if (pane && shown) {
				const directory = pane.querySelector("[aria-label='Connector directory']");
				const visible = (one: Element) => one.getClientRects().length > 0;
				w.__frames.push({
					loading: [...pane.querySelectorAll("p.ai-setup-copy")].some((one) => visible(one) && one.textContent === "Loading connectors…"),
					rows: [...pane.querySelectorAll(rowSelector)].filter(visible).map((one) => one.textContent),
					directory: directory ? Math.round(directory.getBoundingClientRect().top - pane.getBoundingClientRect().top + pane.scrollTop) : null,
				});
			}
			if (w.__recording) requestAnimationFrame(read);
		};
		(button as HTMLElement).click();
		requestAnimationFrame(read);
	}, rows);
	await page.waitForFunction(() => (window as any).__frames.length > 2, null, { timeout: 10_000 });
}
const CONNECTOR_NAMES = ".connector-item-name-text";
const ROOM_NAMES = ".room-connectors-section .room-skills-name";
/** The frames read so far, each different run of them once. */
const framesSoFar = (page: Page): Promise<Frame[]> => page.evaluate(() => (window as any).__frames.filter((frame: unknown, i: number, all: unknown[]) => i === 0 || JSON.stringify(frame) !== JSON.stringify(all[i - 1])));
async function stopFrames(page: Page): Promise<Frame[]> {
	await page.evaluate(() => { (window as any).__recording = false; });
	return framesSoFar(page);
}

/** The window back in front, until `done`: the page reads its list again, at most once every few seconds. */
async function backInFront(page: Page, reads: Reads, done: () => Promise<boolean>): Promise<void> {
	const before = reads.lists;
	await waitUntil(async () => {
		if (reads.lists === before) await page.evaluate(() => window.dispatchEvent(new Event("focus")));
		return reads.lists > before && await done();
	}, "the list read again as the window comes back", 20_000);
}

/** Settings opened on Connectors, with every row read and checked. */
async function visit(page: Page, what: string): Promise<void> {
	await openWindow(page, "settings");
	await goToPage(page, "Connectors");
	await paneOf(page).locator(".connector-item, .settings-empty").first().waitFor({ timeout: 15_000 });
	await answered(page, what);
}
async function visited(browser: Browser, options = desktop(1440)): Promise<{ page: Page; reads: Reads }> {
	await startWorld();
	const page = await openPage(browser, options, "on");
	const reads = new Reads();
	await reads.listen(page);
	await visit(page, "the first visit");
	same(await names(page), NAMES, "the first visit's list");
	await closeWindow(page);
	reads.started = [];
	return { page, reads };
}

// --- The rows -------------------------------------------------------------------------------

async function checkSameList(browser: Browser): Promise<void> {
	for (const [where, options] of [["desktop", desktop(1440)], ["phone", phone()]] as const) {
		await startWorld();
		const page = await openPage(browser, options, "on");
		const reads = new Reads();
		await reads.listen(page);
		// The first time, nothing to show yet: the loading line.
		reads.mode = "held";
		await openWindow(page, "settings");
		await openRecording(page, "Connectors", CONNECTOR_NAMES);
		same((await stopFrames(page)).map((frame) => [frame.loading, frame.rows]), [[true, []]], `${where}: the first visit, before the first answer`);
		reads.go();
		await rowOf(page, "Wiki").waitFor();
		await answered(page, `${where}: the first visit`);
		const was = await paneOf(page).locator("[aria-label='Connector directory']").evaluate((element) => { const pane = element.closest(".settings-dialog-pane")!; return Math.round(element.getBoundingClientRect().top - pane.getBoundingClientRect().top + pane.scrollTop); });
		// Left and opened again, by the menu and by closing the window.
		for (const way of ["another page", "the window closed"]) {
			if (way === "another page") await goToPage(page, "Appearance");
			else {
				await closeWindow(page);
				await openWindow(page, "settings");
			}
			reads.started = [];
			reads.mode = "held";
			await openRecording(page, "Connectors", CONNECTOR_NAMES);
			same((await framesSoFar(page)), [{ loading: false, rows: NAMES, directory: was }], `${where}, after ${way}: every frame before the fresh answer`);
			same(reads.started, [], `${where}, after ${way}: nothing is checked before the fresh answer`);
			reads.go();
			await answered(page, `${where}, after ${way}`);
			same(await stopFrames(page), [{ loading: false, rows: NAMES, directory: was }], `${where}, after ${way}: every frame, the fresh answer's too`);
			same(reads.started.sort(), NAMES.map((name) => `test ${id(name)}`).sort(), `${where}, after ${way}: each is checked once the answer is in`);
		}
		// Kept in the page's memory alone: the browser's storage holds none of it, and a reload has nothing to show.
		const stored = await page.evaluate(() => JSON.stringify([{ ...localStorage }, { ...sessionStorage }]));
		assert(!stored.includes(at("/wiki/mcp")) && !stored.includes("\"wiki\""), `${where}: the list is not in the browser's storage: ${stored}`);
		await page.reload();
		await page.locator(".persistent-agent-card").first().waitFor({ timeout: 15_000 });
		reads.mode = "held";
		await openWindow(page, "settings");
		await openRecording(page, "Connectors", CONNECTOR_NAMES);
		same((await stopFrames(page)).map((frame) => [frame.loading, frame.rows]), [[true, []]], `${where}: reloaded, nothing is kept`);
		reads.go();
		await page.context().close();
	}
	console.log("  ok  opened again: the list in the first frame, the Directory still, nothing checked before the answer, nothing kept across a reload");
}

async function checkNoConnectors(browser: Browser): Promise<void> {
	const { page, reads } = await visited(browser);
	for (const name of NAMES) await servers("DELETE", `/${id(name)}`);
	await visit(page, "none left");
	await paneOf(page).locator(".settings-empty").waitFor();
	await closeWindow(page);
	reads.mode = "held";
	await openWindow(page, "settings");
	await openRecording(page, "Connectors", CONNECTOR_NAMES);
	same(await paneOf(page).locator(".settings-empty").count(), 1, "none kept: the line that says so, before the answer");
	reads.go();
	await answered(page, "none kept");
	same((await stopFrames(page)).length, 1, "none kept: no frame differs");
	await page.context().close();
	console.log("  ok  with none added, the line that says so is there in the first frame");
}

async function checkChanged(browser: Browser): Promise<void> {
	const { page, reads } = await visited(browser);
	// Between the visits: Board wants a sign-in, Desk is gone, Zoo is new.
	refuses.add("/board/mcp");
	await servers("POST", "/board/test");
	await servers("DELETE", "/desk");
	await servers("POST", "", { name: "Zoo", url: at("/zoo/mcp") });
	reads.mode = "held";
	await openWindow(page, "settings");
	await goToPage(page, "Connectors");
	same([await names(page), (await lineOf(page, "Board")).startsWith(WORDS.status.connected)], [NAMES, true], "before the answer: the list as it was");
	reads.go();
	await waitUntil(async () => (await names(page)).join() === NAMES.filter((name) => name !== "Desk").concat("Zoo").join(), "the fresh answer's list");
	await waitUntil(async () => (await lineOf(page, "Board")).startsWith(WORDS.status.notConnected), "Board's fresh state");
	await page.context().close();
	console.log("  ok  a changed, a removed and an added connector read as they are once the fresh answer is in");
}

async function checkFailed(browser: Browser): Promise<void> {
	const { page, reads } = await visited(browser);
	refuses.add("/board/mcp");
	await servers("POST", "/board/test");
	reads.mode = "failed";
	await openWindow(page, "settings");
	await goToPage(page, "Connectors");
	const failure = paneOf(page).locator(".connector-load-error");
	await failure.waitFor({ timeout: 10_000 });
	same([await failure.locator("span").textContent(), await names(page)], [CONNECTOR_REQUEST_LINES.loadFailed, NAMES], "a failed read: the line, and the list under it");
	// A click on a row of a list that couldn't be read again asks for it first.
	const before = reads.lists;
	await rowOf(page, "Wiki").locator(".connector-item-hit").click();
	await waitUntil(() => reads.lists > before, "the click reads the list again");
	await failure.waitFor({ timeout: 10_000 });
	same([await names(page), reads.started], [NAMES, []], "read again and failed again: the list stays, and nothing starts");
	reads.mode = "through";
	await failure.getByRole("button", { name: WORDS.loadAgain }).click();
	await failure.waitFor({ state: "detached", timeout: 10_000 });
	await waitUntil(async () => (await lineOf(page, "Board")).startsWith(WORDS.status.notConnected), "Try again brings the fresh state");
	same(await names(page), NAMES, "after Try again: the list");
	// Read in this opening, then a later read fails: its rows are held as the kept ones are, also while Try again reads.
	// Board is connected meanwhile, so its Connect has nothing left to do.
	for (const way of ["a click", "a click while Try again reads"]) {
		refuses.add("/board/mcp");
		await servers("POST", "/board/test");
		reads.mode = "through";
		await backInFront(page, reads, async () => (await lineOf(page, "Board")).startsWith(WORDS.status.notConnected));
		await answered(page, `before ${way}`);
		reads.mode = "failed";
		await backInFront(page, reads, () => failure.isVisible());
		refuses.clear();
		await servers("POST", "/board/test");
		reads.started = [];
		reads.mode = way === "a click" ? "through" : "held";
		if (reads.mode === "held") {
			await failure.getByRole("button", { name: WORDS.loadAgain }).click();
			await failure.waitFor({ state: "detached" });
		}
		await rowOf(page, "Board").locator(".connector-item-side button").click();
		if (reads.mode === "held") {
			same([reads.started, await rowOf(page, "Board").locator(".connector-item-side button").getAttribute("aria-busy")], [[], "true"], `${way}: it waits, busy`);
			reads.go();
		}
		await waitUntil(async () => (await lineOf(page, "Board")).startsWith(WORDS.status.connected), `${way}: Board's fresh state`);
		await answered(page, way);
		same([reads.started.filter((one) => one.startsWith("login")), await failure.count()], [[], 0], `${way} after a later failed read: no sign-in, and the failure line goes`);
	}
	await page.context().close();
	console.log("  ok  a failed read keeps the list under its failure line, and Try again brings the fresh one");
}

async function checkClicks(browser: Browser): Promise<void> {
	// The list as last seen says Board wants a sign-in.
	const { page, reads } = await visited(browser);
	refuses.add("/board/mcp");
	await servers("POST", "/board/test");
	await visit(page, "Board wants a sign-in");
	await closeWindow(page);
	const press = async () => {
		reads.mode = "held";
		reads.started = [];
		await openWindow(page, "settings");
		await goToPage(page, "Connectors");
		await rowOf(page, "Board").locator(".connector-item-side button").click();
		same(reads.started, [], "a press before the answer starts nothing yet");
		reads.go();
	};
	// Still so: the press goes on once the answer is in.
	await press();
	await waitUntil(() => reads.started.includes("login board"), "the press goes on once the answer is in");
	await answered(page, "the press that went on");
	await closeWindow(page);
	// Connected meanwhile: the press has nothing left to do, and the row says what it is.
	await visit(page, "Board still wants a sign-in");
	await closeWindow(page);
	refuses.clear();
	await servers("POST", "/board/test");
	await press();
	await waitUntil(async () => (await lineOf(page, "Board")).startsWith(WORDS.status.connected), "Board's fresh state");
	await answered(page, "the press that had nothing to do");
	same(reads.started.filter((one) => one.startsWith("login")), [], "a press the fresh answer no longer offers does nothing");
	await closeWindow(page);
	// A row's page opens at once, checking until the answer is in; a row that is gone goes back to the list.
	await servers("DELETE", "/desk");
	for (const [name, opens] of [["Wiki", true], ["Desk", false]] as const) {
		if (name === "Desk") {
			await servers("POST", "", { name: "Desk", url: at("/desk/mcp") });
			await visit(page, "Desk is back");
			await closeWindow(page);
			await servers("DELETE", "/desk");
		}
		reads.mode = "held";
		await openWindow(page, "settings");
		await goToPage(page, "Connectors");
		await rowOf(page, name).locator(".connector-item-hit").click();
		await paneOf(page).locator(".connector-page").waitFor({ timeout: 5_000 });
		reads.started = [];
		same([await pageState(page), reads.started], [WORDS.status.checking, []], `${name}: its page at once, checking, with nothing started before the answer`);
		const places = await pagePlaces(page);
		reads.go();
		if (opens) await waitUntil(async () => (await pageState(page)) === WORDS.status.connected, `${name}: its page says what the answer does`);
		await answered(page, `${name} clicked`);
		if (opens) same(await pagePlaces(page), places, `${name}: nothing on its page moves when the answer comes`);
		same([await paneOf(page).locator(".connector-page").count(), opens ? true : await rowOf(page, name).count() === 0], [opens ? 1 : 0, true], `${name}: its page, once the answer is in`);
		await closeWindow(page);
	}
	// What is pressed on the page meanwhile acts on the answer: Remove asks once it is in, for a connector still there.
	reads.mode = "held";
	await openWindow(page, "settings");
	await goToPage(page, "Connectors");
	await rowOf(page, "Wiki").locator(".connector-item-hit").click();
	const remove = paneOf(page).locator(".connector-remove-group").getByRole("button", { name: WORDS.button.remove, exact: true });
	await remove.click();
	same([await page.locator(".confirm-dialog-backdrop").count(), await remove.getAttribute("aria-busy")], [0, "true"], "Remove pressed before the answer: it waits, busy");
	reads.go();
	await page.locator(".confirm-dialog-backdrop").waitFor({ timeout: 10_000 });
	await page.locator(".confirm-dialog-backdrop").getByRole("button", { name: WORDS.button.keep, exact: true }).click();
	await answered(page, "Remove kept");
	await closeWindow(page);
	// A read that fails takes the page back to the list under its failure line; the read that works then opens nothing by itself.
	reads.mode = "held";
	await openWindow(page, "settings");
	await goToPage(page, "Connectors");
	await rowOf(page, "Wiki").locator(".connector-item-hit").click();
	await paneOf(page).locator(".connector-page").waitFor({ timeout: 5_000 });
	reads.go("failed");
	await paneOf(page).locator(".connector-page").waitFor({ state: "detached", timeout: 10_000 });
	assert(((await paneOf(page).textContent()) ?? "").includes(CONNECTOR_REQUEST_LINES.loadFailed), "a failed read: the list under its failure line");
	reads.mode = "through";
	await paneOf(page).getByRole("button", { name: "Try again", exact: true }).click();
	await answered(page, "the list read again");
	same(await paneOf(page).locator(".connector-page").count(), 0, "the list read again opens nothing by itself");
	await closeWindow(page);
	// A second read started before the first answered: the page goes by the newer one's answer alone.
	const held = (await reads.holdEach(page));
	await openWindow(page, "settings");
	await goToPage(page, "Connectors");
	await rowOf(page, "Wiki").locator(".connector-item-hit").click();
	await backInFront(page, reads, async () => held.length === 2);
	held[0]();
	await waitUntil(() => reads.answered === 1, "the older read's answer is in");
	await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
	same(await pageState(page), WORDS.status.checking, "the older answer changes nothing on the page");
	held[1]();
	await waitUntil(async () => (await pageState(page)) === WORDS.status.connected, "the newer answer is on the page");
	await page.context().close();
	console.log("  ok  while the fresh answer is on its way a row's page opens at once and says Checking…, and a press waits for the answer and acts on what it says");
}

/** A room's page: its rows' names as they stand, the names switched on, and each row's line. */
const roomRows = (page: Page) => paneOf(page).locator(".room-connectors-section .room-skills-row").evaluateAll((rows) => rows.map((row) => ({ name: row.querySelector(".room-skills-name")!.textContent!, on: row.querySelector<HTMLInputElement>("input")?.checked ?? false, line: row.querySelector(".room-connector-fact")?.textContent ?? "" })));

async function checkRoom(browser: Browser): Promise<void> {
	await startWorld();
	const page = await openPage(browser, desktop(1440), "on");
	const reads = new Reads();
	await reads.listen(page);
	const ROOM_ROUTE = "**/api/persistent-agents/*/mcp-connectors";
	let room: "through" | "failed" | "refuse" = "through";
	await page.route(ROOM_ROUTE, (route) => (route.request().method() === (room === "failed" ? "GET" : room === "refuse" ? "PUT" : "") ? route.fulfill({ status: 500, contentType: "application/json", body: "{}" }) : route.continue()));
	const open = async () => {
		await openWindow(page, "room");
		await openRecording(page, "Connectors", ROOM_NAMES);
	};
	const close = async (what: string) => {
		reads.go();
		await answered(page, what);
		await page.evaluate(() => { (window as any).__recording = false; });
		await closeWindow(page);
	};
	const withWikiFirst = ["Wiki", ...NAMES.filter((name) => name !== "Wiki")];
	reads.mode = "held";
	await open();
	same((await framesSoFar(page)).map((frame) => [frame.loading, frame.rows]), [[true, []]], "a room's first visit, before the first answer");
	await close("a room's first visit");
	// Opened again: every frame the same list.
	reads.mode = "held";
	await open();
	same(await framesSoFar(page), [{ loading: false, rows: withWikiFirst, directory: null }], "a room opened again: every frame before the fresh answer");
	reads.go();
	await answered(page, "a room opened again");
	same(await stopFrames(page), [{ loading: false, rows: withWikiFirst, directory: null }], "a room opened again: every frame, the fresh answer's too");
	await closeWindow(page);
	// Switched on elsewhere meanwhile: the fresh answer moves it up, switched on.
	await grant("maps", true);
	reads.mode = "held";
	await open();
	same((await roomRows(page)).map((row) => row.name), withWikiFirst, "before the answer: the room as it was");
	reads.go();
	await waitUntil(async () => (await roomRows(page))[0].name === "Maps", "Maps goes up among the ones on");
	same((await roomRows(page)).filter((row) => row.on).map((row) => row.name), ["Maps", "Wiki"], "the room's ones on, as the answer has them");
	await close("switched on elsewhere");
	// A switch flipped before the answer is saved, and the rows' states still come in fresh.
	refuses.add("/board/mcp");
	await servers("POST", "/board/test");
	reads.mode = "held";
	await open();
	await paneOf(page).locator(".room-skills-row", { hasText: "Trips" }).locator("input").click();
	await waitUntil(async () => (await roomRows(page)).some((row) => row.name === "Trips" && row.on), "the flipped switch is on");
	assert((await roomRows(page)).some((row) => row.name === "Board" && row.line !== WORDS.status.notConnected), "Board's state as last read");
	reads.go();
	await waitUntil(async () => (await roomRows(page)).some((row) => row.name === "Board" && row.line.startsWith(WORDS.status.notConnected)), "Board's fresh state");
	same((await roomRows(page)).filter((row) => row.on).map((row) => row.name), ["Maps", "Wiki", "Trips"], "the flipped switch stays on once the answer is in");
	await close("a switch flipped before the answer");
	// A switch flipped before the answer whose change fails: the room is read again, so what changed elsewhere shows.
	await grant("trips", false);
	await grant("press", true);
	room = "refuse";
	reads.mode = "held";
	await open();
	await paneOf(page).locator(".room-skills-row", { hasText: "Desk" }).locator("input").click();
	await paneOf(page).locator(".room-connectors-section .checkpoint-proposal-error").waitFor();
	reads.go();
	await waitUntil(async () => (await roomRows(page)).filter((row) => row.on).map((row) => row.name).join() === "Maps,Press,Wiki", "the room as the server has it");
	same(await paneOf(page).locator(".room-connectors-section .checkpoint-proposal-error").textContent(), CONNECTOR_REQUEST_LINES.saveFailed, "the failed change's line stays");
	await close("a failed switch before the answer");
	await grant("press", false);
	await grant("trips", true);
	room = "through";
	await openWindow(page, "room");
	await goToPage(page, "Connectors");
	await answered(page, "the room as it was");
	await closeWindow(page);
	// A failed read keeps the rows under its line.
	room = "failed";
	await open();
	const failure = paneOf(page).locator(".room-connectors-section .connector-load-error");
	await failure.waitFor({ timeout: 10_000 });
	same([await failure.locator("span").textContent(), (await roomRows(page)).map((row) => row.name)], [WORDS.room.loadFailed, ["Maps", "Trips", "Wiki", "Board", "Desk", "Press"]], "a failed read: the line, and the list under it");
	room = "through";
	await failure.getByRole("button", { name: WORDS.loadAgain }).click();
	await failure.waitFor({ state: "detached", timeout: 10_000 });
	same((await roomRows(page)).length, NAMES.length, "Try again: the list");
	await page.context().close();
	// On a shared server who may see a room can change: none is kept, and it loads at every opening.
	const shared = await openPage(browser, desktop(1440), "on");
	await shared.route("**/api/remote/client-context", (route) => route.fulfill({ json: { remote: false, sharedServer: true } }));
	let letGo: Array<() => void> | null = null;
	await shared.route(ROOM_ROUTE, async (route) => {
		if (letGo) await new Promise<void>((resolve) => letGo!.push(resolve));
		await route.continue().catch(() => undefined);
	});
	await shared.reload();
	await shared.locator(".persistent-agent-card").first().waitFor({ timeout: 15_000 });
	await openWindow(shared, "room");
	await goToPage(shared, "Connectors");
	await waitUntil(async () => (await roomRows(shared)).length === NAMES.length, "a shared server's room lists its connectors");
	await closeWindow(shared);
	letGo = [];
	await openWindow(shared, "room");
	await openRecording(shared, "Connectors", ROOM_NAMES);
	same((await stopFrames(shared)).map((frame) => [frame.loading, frame.rows]), [[true, []]], "a shared server's room opened again: nothing kept");
	await waitUntil(() => letGo!.length > 0, "its read is out");
	for (const release of letGo.splice(0)) release();
	letGo = null;
	await shared.context().close();
	console.log("  ok  a room's Connectors opened again: its rows in the first frame, its changes once the answer is in, a failed read keeps them");
}

let model: http.Server | undefined;
let server: ChildProcessWithoutNullStreams | null = null;
let roomId = "";
try {
	const agents = await import("../src/persistent-agents.js");
	roomId = agents.createPersistentAgentFromScaffoldInput({ displayName: ROOM, userName: "Synthetic User", preferredUserAddress: "Synthetic User" }).agent.agentId;
	// A model server is never asked here; the app wants one set up to show its rooms.
	const modelPort = await freePort();
	model = http.createServer((_req, res) => { res.writeHead(500); res.end(); }).listen(modelPort, "127.0.0.1");
	fs.writeFileSync(path.join(agentDir, "models.json"), JSON.stringify({ providers: { synthetic: { name: "Synthetic", baseUrl: `http://127.0.0.1:${modelPort}/v1`, api: "openai-completions", models: [{ id: "room-model", name: "Room Model", input: ["text"], contextWindow: 128000, maxTokens: 16384 }] } } }));
	server = spawn("npx", ["tsx", "src/index.ts"], {
		shell: process.platform === "win32",
		...SMOKE_SERVER_SPAWN_TREE_OPTIONS,
		cwd: webServerDir,
		env: smokeHomeEnv(tempHome, { PORT: String(port), ...SMOKE_SERVER_AUTH_ENV, EXXETA_HOME: repoRoot, EXXPERTS_CODING_AGENT_DIR: agentDir, PI_CODING_AGENT_DIR: agentDir, EXXETA_PERSISTENT_AGENTS_ROOT: agentsRoot }) as NodeJS.ProcessEnv,
		stdio: ["ignore", "pipe", "pipe"],
	}) as unknown as ChildProcessWithoutNullStreams;
	await waitForServer(server, baseUrl, { tries: 100 });
	const key = await authedFetch(`${baseUrl}/api/auth/api-key`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ provider: "synthetic", key: "synthetic-test-key" }) });
	assert(key.ok, `saving the synthetic key: ${key.status}`);
	const browser = await chromium.launch({ ignoreDefaultArgs: ["--hide-scrollbars"] });
	try {
		const failed: string[] = [];
		const only = process.env.KEPT_ROWS?.split(",");
		for (const check of [checkSameList, checkNoConnectors, checkChanged, checkFailed, checkClicks, checkRoom]) {
			if (only && !only.includes(check.name)) continue;
			try {
				await check(browser);
			} catch (error) {
				failed.push(`${check.name}: ${(error as Error).message.split("\n")[0]}`);
				console.log(`  FAIL ${failed.at(-1)}`);
				for (const context of browser.contexts()) await context.close();
			}
		}
		assert(failed.length === 0, `${failed.length} rows failed:\n${failed.join("\n")}`);
	} finally {
		await browser.close();
	}
	console.log("connectors page keeps list ui smoke passed");
} finally {
	await stopSmokeServer(server);
	model?.close();
	standIns.close();
	fs.rmSync(tempRoot, { recursive: true, force: true });
}
