// Settings and Room settings, in the browser, at desktop and phone width, in
// light and dark: rows sit in soft boxes with no outline, no line between
// them and none under a pane's title, while Memory's notes outside a box keep
// theirs. Both lists keep their order and their default pane, also with the
// panes a remote device or a shared server does not get. Appearance holds the
// theme and the chat width (Theme alone on a phone), and Wide widens the
// room's column and survives a reload and a server restart. Forget in Room
// settings asks the bin's question, with its running-answer line, and sends
// one request. Instructions' text wraps before Clear, which sits in its box. Every danger word reads at 4.5:1 in dark, and light keeps its red.
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import { fileURLToPath } from "node:url";
import { chromium, type Browser, type Page } from "playwright";
import { authedFetch, SMOKE_AUTH_TOKEN, SMOKE_SERVER_AUTH_ENV, SMOKE_SERVER_SPAWN_TREE_OPTIONS, smokeHomeEnv, stopSmokeServer, freePort, waitForServer } from "./smoke-server-process.js";
import { waitEvery } from "./smoke-wait.js";

const waitUntil = waitEvery(100);

function assert(condition: unknown, message: string): asserts condition {
	if (!condition) throw new Error(message);
}
function same(actual: unknown, expected: unknown, what: string): void {
	assert(JSON.stringify(actual) === JSON.stringify(expected), `${what}: got ${JSON.stringify(actual)}, expected ${JSON.stringify(expected)}`);
}

{
	const p = typeof chromium?.executablePath === "function" ? chromium.executablePath() : "";
	if (!p || !fs.existsSync(p)) {
		console.log("settings look ui smoke skipped (Chromium not installed)");
		process.exit(0);
	}
}

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const webServerDir = path.resolve(scriptDir, "..");
const repoRoot = path.resolve(webServerDir, "..", "..");
const port = await freePort();
const baseUrl = `http://127.0.0.1:${port}`;

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "exxperts-settings-look-"));
const tempHome = path.join(tempRoot, "home");
const agentsRoot = path.join(tempHome, ".exxperts", "app", "personalized-agents");
const agentDir = path.join(tempHome, ".exxperts", "agent");
const appDir = path.join(tempHome, ".exxperts", "app");
for (const dir of [agentsRoot, agentDir]) fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
process.env.HOME = tempHome;
process.env.USERPROFILE = tempHome;
process.env.EXXPERTS_CODING_AGENT_DIR = agentDir;
process.env.EXXETA_PERSISTENT_AGENTS_ROOT = agentsRoot;

const SETTINGS_ORDER = ["AI setup", "Instructions", "Skills", "Connectors", "Web search", "Appearance", "Remote access", "Profiles"];
const REMOTE_ORDER = SETTINGS_ORDER.slice(0, 6);
const ROOM_ORDER = ["Model", "Memory", "Instructions", "Folder", "Skills", "Connectors", "Scheduled tasks", "Conversation", "Archive or delete"];
const QUESTION = "Forget this conversation and start fresh?";
const QUIET_BODY = "This deletes this conversation for good. Nothing from it is saved to memory.";
const RUNNING_BODY = `The response currently being written will be stopped. ${QUIET_BODY}`;
const HOLD = "Hold this answer open.";
const SCHEDULE = { name: "Weekly summary", type: "once", schedule: "+30m", prompt: "Write the weekly summary.", enabled: true };
const BOX = ".settings-rows, .ai-profile-card, .room-skills-rows, .room-schedules-list, .room-schedules-run-list, .connector-table, .skill-table";
// A task that ran, so the Recent runs list has rows to read.
const RUN = { kind: "scheduled-prompt", status: "succeeded", source: { scheduleId: "gone-task" }, createdAt: "2026-01-05T09:00:00.000Z", updatedAt: "2026-01-05T09:01:00.000Z", finishedAt: "2026-01-05T09:01:00.000Z" };
const RECENT_RUNS = { runs: [{ ...RUN, runId: "run-1" }, { ...RUN, runId: "run-2" }] };

// The model: one short answer, or an answer that stays open until the smoke lets it go.
let releaseHeld: (() => void) | null = null;
function sse(res: http.ServerResponse, event: string, payload: unknown): void {
	res.write(`event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`);
}
const provider = http.createServer((req, res) => {
	let raw = "";
	req.on("data", (chunk) => { raw += chunk; });
	req.on("end", () => {
		res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
		sse(res, "message_start", { type: "message_start", message: { id: "msg_1", type: "message", role: "assistant", model: "claude-fake", content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 100, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } } });
		sse(res, "content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } });
		const finish = (): void => {
			sse(res, "content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Answer from the model." } });
			sse(res, "content_block_stop", { type: "content_block_stop", index: 0 });
			sse(res, "message_delta", { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 20 } });
			sse(res, "message_stop", { type: "message_stop" });
			res.end();
		};
		const lastUser = (JSON.parse(raw || "{}").messages ?? []).filter((message: { role?: string }) => message.role === "user").at(-1);
		if (JSON.stringify(lastUser ?? "").includes(HOLD)) {
			sse(res, "content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Still writing" } });
			releaseHeld = finish;
		} else finish();
	});
});

let server: ChildProcessWithoutNullStreams | null = null;

async function startServer(): Promise<void> {
	server = spawn("npx", ["tsx", "src/index.ts"], {
		shell: process.platform === "win32",
		...SMOKE_SERVER_SPAWN_TREE_OPTIONS,
		cwd: webServerDir,
		env: smokeHomeEnv(tempHome, { PORT: String(port), ...SMOKE_SERVER_AUTH_ENV, EXXETA_HOME: repoRoot, EXXPERTS_CODING_AGENT_DIR: agentDir, EXXETA_PERSISTENT_AGENTS_ROOT: agentsRoot }) as NodeJS.ProcessEnv,
		stdio: ["ignore", "pipe", "pipe"],
	}) as unknown as ChildProcessWithoutNullStreams;
	await waitForServer(server, baseUrl, { tries: 100 });
}

async function signIn(page: Page): Promise<void> {
	await page.goto(`${baseUrl}/auth/session?token=${SMOKE_AUTH_TOKEN}`);
	await page.locator(".persistent-agent-card").first().waitFor({ timeout: 15000 });
	const dismiss = page.locator(".whats-new-close");
	if (await dismiss.count()) await dismiss.click();
}

const isPhone = (page: Page): boolean => (page.viewportSize()?.width ?? 1280) <= 760;

async function openSettings(page: Page): Promise<void> {
	await page.locator(".product-sidebar-footer button, .home-gear, button[aria-label='Settings']").first().click();
	await page.locator(".sidebar-config-menu button, .sidebar-config-menu a").filter({ hasText: /Settings/ }).first().click();
	await page.waitForSelector(".settings-overlay", { timeout: 10000 });
}

async function openRoomCardSettings(page: Page, room: string): Promise<void> {
	await page.locator(".persistent-agent-card").filter({ hasText: room }).locator(".card-gear-btn").click();
	await page.waitForSelector(".rs-shell", { timeout: 10000 });
}

const navItem = (page: Page, label: string) => page.locator(".settings-dialog-nav-item").filter({ hasText: new RegExp(`^${label}$`) }).first();
const navLabels = (page: Page) => page.locator(".settings-dialog-nav-item").allInnerTexts();
const activePane = async (page: Page) => (await page.locator(".settings-dialog-nav-item.active").first().innerText()).trim();

async function goToPane(page: Page, label: string): Promise<void> {
	if (isPhone(page) && await page.locator(".settings-dialog-back").isVisible()) await page.locator(".settings-dialog-back").click();
	await navItem(page, label).click();
	await waitUntil(async () => (await activePane(page)) === label, `the pane ${label} is open`);
}

async function closeDialog(page: Page): Promise<void> {
	await page.locator(".settings-dialog-close").first().click();
	await page.locator(".settings-dialog").first().waitFor({ state: "detached", timeout: 5000 });
}

// What a sighted person gets: the page's colours flattened to sRGB through a
// canvas, so a color-mix reads the same as a hex, and the contrast of a word
// against everything painted behind it.
async function installColourTools(page: Page): Promise<void> {
	// tsx wraps the named functions below in a helper the page does not have.
	await page.evaluate("globalThis.__name = (target) => target");
	await page.evaluate(() => {
		type Rgba = [number, number, number, number];
		const context = document.createElement("canvas").getContext("2d", { willReadFrequently: true })!;
		const rgba = (colour: string): Rgba => {
			context.clearRect(0, 0, 1, 1);
			context.fillStyle = colour;
			context.fillRect(0, 0, 1, 1);
			const [r, g, b, a] = context.getImageData(0, 0, 1, 1).data;
			return [r, g, b, a / 255];
		};
		const over = (top: Rgba, under: Rgba): Rgba => [0, 1, 2].map((i) => top[i] * top[3] + under[i] * (1 - top[3])).concat(1) as Rgba;
		const behind = (element: Element): Rgba => {
			const layers: Rgba[] = [];
			for (let at: Element | null = element; at; at = at.parentElement) layers.push(rgba(getComputedStyle(at).backgroundColor));
			return layers.reduceRight<Rgba>((under, top) => over(top, under), [255, 255, 255, 1]);
		};
		const luminance = (colour: Rgba): number => {
			const [r, g, b] = colour.slice(0, 3).map((value) => {
				const c = value / 255;
				return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
			});
			return 0.2126 * r + 0.7152 * g + 0.0722 * b;
		};
		const ratio = (a: Rgba, b: Rgba): number => {
			const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
			return (hi + 0.05) / (lo + 0.05);
		};
		(window as any).__contrast = (element: Element) => {
			const back = behind(element);
			return ratio(over(rgba(getComputedStyle(element).color), back), back);
		};
		(window as any).__fillContrast = (element: Element) => ratio(behind(element), behind(element.parentElement!.closest(".settings-dialog")!));
		(window as any).__colour = (element: Element) => rgba(getComputedStyle(element).color).slice(0, 3).join(",");
		(window as any).__rgb = (element: Element) => rgba(getComputedStyle(element).color).slice(0, 3);
		(window as any).__line = (colour: string, width: string, style: string) => parseFloat(width) > 0 && style !== "none" && rgba(colour)[3] > 0;
	});
}

// The open pane's boxes and every line a person could see in one. A control
// keeps its edge; a row, a table's head and a title may not have a line.
async function readPane(page: Page) {
	return page.evaluate((selector) => {
		const line = (window as any).__line as (colour: string, width: string, style: string) => boolean;
		const fillContrast = (window as any).__fillContrast as (element: Element) => number;
		const pane = document.querySelector(".settings-dialog-pane")!;
		const shown = (element: Element) => element.getClientRects().length > 0;
		const sides = ["Top", "Right", "Bottom", "Left"] as const;
		const edges = (element: Element, which: readonly (typeof sides)[number][]) => {
			const style = getComputedStyle(element);
			return which.filter((side) => line(style[`border${side}Color`], style[`border${side}Width`], style[`border${side}Style`]));
		};
		const name = (element: Element) => `${element.tagName.toLowerCase()}.${String(element.className).split(" ").join(".")}`;
		const boxes = [...pane.querySelectorAll(selector)].filter(shown);
		const offenders: string[] = [];
		for (const box of boxes) {
			if (edges(box, sides).length > 0) offenders.push(`the box ${name(box)} has an outline`);
			const wide = box.getBoundingClientRect().width * 0.7;
			for (const inner of box.querySelectorAll("*")) {
				if (!shown(inner) || inner.closest("button, input, select, textarea, label.toggle, .ai-profile-models, .settings-segments")) continue;
				if (inner.getBoundingClientRect().width >= wide && edges(inner, ["Top", "Bottom"]).length > 0) offenders.push(`a line on ${name(inner)} in ${name(box)}`);
			}
		}
		for (const head of [...pane.querySelectorAll(".pane-head, .room-schedules-history")].filter(shown)) {
			if (edges(head, sides).length > 0) offenders.push(`a line on ${name(head)}`);
		}
		// Every red word on screen, whichever token paints it.
		const contrast = (window as any).__contrast as (element: Element) => number;
		const rgb = (window as any).__rgb as (element: Element) => [number, number, number];
		const lowReds: string[] = [];
		for (const element of pane.parentElement!.parentElement!.querySelectorAll("*")) {
			const words = [...element.childNodes].some((node) => node.nodeType === Node.TEXT_NODE && node.textContent!.trim());
			if (!shown(element) || !words) continue;
			const [r, g, b] = rgb(element);
			if (r > 150 && r > g * 1.3 && r > b * 1.3 && contrast(element) < 4.5) lowReds.push(`"${element.textContent!.trim().slice(0, 40)}" at ${contrast(element).toFixed(2)}:1`);
		}
		return {
			offenders,
			lowReds,
			boxes: boxes.length,
			lowestFill: Math.min(...boxes.map(fillContrast)),
		};
	}, BOX);
}

async function assertLook(page: Page, where: string, panes: string[], paneWithoutBox: string[]): Promise<void> {
	for (const pane of panes) {
		await goToPane(page, pane);
		// A pane fills in from its own request: its box, or its empty line, is there first.
		if (!paneWithoutBox.includes(pane)) await waitUntil(async () => (await readPane(page)).boxes > 0, `${where}, ${pane} shows a box`);
		const read = await readPane(page);
		same(read.offenders, [], `${where}, ${pane}`);
		same(read.lowReds, [], `${where}, ${pane}: red words under 4.5:1`);
		if (read.boxes > 0) assert(read.lowestFill >= 1.08, `${where}, ${pane}: the box reads as a box, its fill is ${read.lowestFill.toFixed(2)}:1 against the dialog`);
	}
}

// Clear hangs in the box's corner: a long line and a long unbroken word wrap
// before it, and no text ever runs under it.
async function assertTextWrapsBeforeClear(page: Page, where: string, boxArea: string): Promise<void> {
	const box = page.locator(`${boxArea} .room-instructions-textarea:visible`);
	const before = await box.inputValue();
	for (const [what, text] of [["a long line", "word ".repeat(400)], ["a long unbroken word", "x".repeat(3000)]] as const) {
		await box.fill(text);
		const clear = page.locator(boxArea).getByRole("button", { name: "Clear", exact: true });
		await clear.waitFor({ timeout: 5000 });
		const clearEdges = await clear.evaluate((element) => { const { left, right } = element.getBoundingClientRect(); return { left, right }; });
		const read = await box.evaluate((element) => {
			const insideLeft = element.getBoundingClientRect().left + element.clientLeft;
			return {
				textEnds: insideLeft + element.clientWidth - parseFloat(getComputedStyle(element).paddingRight),
				scrollBarStarts: insideLeft + element.clientWidth,
				scrolls: element.scrollHeight > element.clientHeight,
				sideways: element.scrollWidth - element.clientWidth,
			};
		});
		assert(read.textEnds <= clearEdges.left, `${where}: with ${what} the text ends at ${read.textEnds}, past Clear at ${clearEdges.left}`);
		assert(read.scrolls, `${where}: ${what} should fill the box until it scrolls`);
		assert(clearEdges.right + 4 <= read.scrollBarStarts, `${where}: with ${what} Clear ends at ${clearEdges.right}, against the scroll bar at ${read.scrollBarStarts}`);
		assert(read.sideways <= 0, `${where}: ${what} runs ${read.sideways} px past the box`);
	}
	// The thinner scroll bar must leave the corner's handle working.
	const corner = await box.boundingBox();
	assert(corner, `${where}: the box has a place on the page`);
	await page.mouse.move(corner.x + corner.width - 3, corner.y + corner.height - 3);
	await page.mouse.down();
	await page.mouse.move(corner.x + corner.width - 3, corner.y + corner.height + 37, { steps: 4 });
	await page.mouse.up();
	const taller = await box.evaluate((element) => element.getBoundingClientRect().height);
	assert(taller >= corner.height + 30, `${where}: dragging the corner left the box at ${taller} px, from ${corner.height}`);
	await box.fill(before);
}

async function assertDangerWords(page: Page, where: string): Promise<void> {
	const read = (element: Element) => (window as any).__contrast(element) as number;
	// The red word on Archive or delete, chosen and not.
	const danger = page.locator(".settings-dialog-nav-item.danger");
	await page.mouse.move(0, 0);
	const idle = await danger.evaluate(read);
	assert(idle >= 4.5, `${where}: "Archive or delete" is ${idle.toFixed(2)}:1`);
	await goToPane(page, "Archive or delete");
	await page.mouse.move(0, 0);
	const chosen = await danger.evaluate(read);
	assert(chosen >= 4.5, `${where}: "Archive or delete" on its chosen row is ${chosen.toFixed(2)}:1`);
	await goToPane(page, "Scheduled tasks");
	await page.locator(".room-schedules-run").first().waitFor({ timeout: 10000 });
	const remove = page.locator(".rs-quiet-danger:visible").first();
	await remove.waitFor({ timeout: 10000 });
	const onBox = await remove.evaluate(read);
	assert(onBox >= 4.5, `${where}: "Delete" in Scheduled tasks is ${onBox.toFixed(2)}:1`);
}

async function chooseTheme(page: Page, theme: "Light" | "Dark" | "System"): Promise<void> {
	await page.getByRole("group", { name: "Theme" }).getByRole("button", { name: theme }).click();
}

async function chatColumnWidth(page: Page): Promise<number> {
	return page.locator(".bubble-row").first().evaluate((element) => Math.round(element.getBoundingClientRect().width));
}

// In the room with its socket ready: a message sent any sooner goes nowhere.
async function enterRoom(page: Page, room: string): Promise<void> {
	const socketReady = new Promise<void>((resolve) => {
		page.on("websocket", (socket) => socket.on("framereceived", ({ payload }) => { if (String(payload).includes('"type":"ready"')) resolve(); }));
	});
	await page.locator(".persistent-agent-card").filter({ hasText: room }).locator(".persistent-agent-primary-actions .landing-action").first().click();
	await page.locator("textarea").first().waitFor({ timeout: 15000 });
	await socketReady;
}

async function send(page: Page, text: string): Promise<void> {
	const composer = page.locator("textarea").first();
	await composer.fill(text);
	await composer.press("Enter");
}

// So the Conversation pane has a row to show.
async function startConversation(browser: Browser, room: string): Promise<void> {
	const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
	const page = await context.newPage();
	await signIn(page);
	await enterRoom(page, room);
	await send(page, "Open a conversation.");
	await page.getByText("Answer from the model.").first().waitFor({ timeout: 45000 });
	await context.close();
}

async function checkLookOnEveryPane(browser: Browser): Promise<void> {
	for (const [device, viewport] of [["desktop", { width: 1440, height: 900 }], ["phone", { width: 390, height: 844 }]] as const) {
		for (const colorScheme of ["light", "dark"] as const) {
			const context = await browser.newContext({ viewport, colorScheme, hasTouch: device === "phone" });
			const page = await context.newPage();
			await page.route("**/background-runs*", (route) => route.fulfill({ contentType: "application/json", body: JSON.stringify(RECENT_RUNS) }));
			await signIn(page);
			await installColourTools(page);
			const where = `${device} ${colorScheme}`;
			await openSettings(page);
			same(await navLabels(page), SETTINGS_ORDER, `${where}: the order of Settings`);
			if (device === "desktop") same(await activePane(page), "AI setup", `${where}: Settings opens on AI setup`);
			await assertLook(page, `${where} Settings`, SETTINGS_ORDER, ["Instructions"]);
			await goToPane(page, "Instructions");
			await assertTextWrapsBeforeClear(page, `${where} Settings`, ".settings-overlay .settings-dialog-pane");
			// A connector that cannot be reached paints its failure in red words too.
			await goToPane(page, "Connectors");
			await page.locator(".connector-row").first().getByRole("button", { name: "Test" }).click();
			await page.locator(".connector-status-failed").first().waitFor({ timeout: 15000 });
			await assertLook(page, `${where} Settings`, ["Connectors"], []);
			if (device === "phone") await page.locator(".settings-dialog-back").click();
			await closeDialog(page);

			await openRoomCardSettings(page, "Look Room");
			same(await navLabels(page), ROOM_ORDER, `${where}: the order of Room settings`);
			if (device === "desktop") same(await activePane(page), "Model", `${where}: Room settings opens on Model`);
			await assertLook(page, `${where} Room settings`, ROOM_ORDER, []);
			await goToPane(page, "Instructions");
			await assertTextWrapsBeforeClear(page, `${where} Room settings`, ".room-settings-section:not([hidden])");
			// The allowed neighbour: Memory's notes sit outside any box and keep their line.
			await goToPane(page, "Memory");
			const noteLine = page.locator(".memory-topic + .memory-topic").first();
			await noteLine.waitFor({ timeout: 10000 });
			assert(await noteLine.evaluate((element) => parseFloat(getComputedStyle(element).borderTopWidth) === 1 && !element.closest(".settings-rows")), `${where}: Memory's notes keep their line, outside a box`);
			if (colorScheme === "dark") await assertDangerWords(page, where);
			else {
				await goToPane(page, "Archive or delete");
				same(await page.locator(".settings-dialog-nav-item.danger").evaluate((element) => (window as any).__colour(element)), "180,35,35", `${where}: light keeps its red`);
			}
			await context.close();
			console.log(`  ok  ${where}: boxes without lines on every pane, the order, the reds`);
		}
	}
}

async function checkPanesLessDevices(browser: Browser): Promise<void> {
	for (const [who, answer] of [
		["a remote device", { remote: true, capability: "read-only" }],
		["a shared server", { remote: false, capability: "full", sharedServer: true, person: { id: "smoke-person", name: "Smoke Person", admin: false }, signOut: null }],
	] as const) {
		const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
		const page = await context.newPage();
		await page.route("**/api/remote/client-context", (route) => route.fulfill({ contentType: "application/json", body: JSON.stringify(answer) }));
		await signIn(page);
		await openSettings(page);
		same(await navLabels(page), REMOTE_ORDER, `${who}: Settings keeps its order without Remote access and Profiles`);
		const asked: string[] = [];
		page.on("request", (request) => { if (request.method() !== "GET") asked.push(`${request.method()} ${request.url()}`); });
		await goToPane(page, "Appearance");
		await page.getByRole("group", { name: "Chat width" }).getByRole("button", { name: "Wide" }).click();
		await chooseTheme(page, "Dark");
		await waitUntil(() => page.evaluate(() => document.documentElement.dataset.theme === "dark"), `${who}: Dark applies`);
		same(asked, [], `${who}: Appearance writes nothing to the server`);
		await context.close();
		console.log(`  ok  ${who}: the list keeps its order, Appearance works and asks the server nothing`);
	}
}

async function checkAppearance(browser: Browser): Promise<void> {
	const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, colorScheme: "light" });
	const page = await context.newPage();
	await signIn(page);
	await enterRoom(page, "Width Room");
	await send(page, "First question.");
	await page.getByText("Answer from the model.").first().waitFor({ timeout: 45000 });
	same(await chatColumnWidth(page), 768, "Standard is the default column");

	await page.keyboard.press(process.platform === "darwin" ? "Meta+Comma" : "Control+Comma");
	await page.waitForSelector(".settings-overlay", { timeout: 10000 });
	await goToPane(page, "Appearance");
	const widths = page.getByRole("group", { name: "Chat width" });
	const chosen = (group: typeof widths) => group.locator('[aria-pressed="true"]').allInnerTexts();
	same(await page.locator(".settings-overlay .settings-row-label:visible").allInnerTexts(), ["Theme", "Chat width"], "Appearance holds Theme and Chat width");
	same(await chosen(widths), ["Standard"], "Standard is chosen by default");

	// The theme is the gear menu's one choice: changed here, the menu reads it, and back.
	const themes = page.getByRole("group", { name: "Theme" });
	same(await themes.getByRole("button").allInnerTexts(), ["System", "Light", "Dark"], "the theme's choices");
	await chooseTheme(page, "Dark");
	await waitUntil(() => page.evaluate(() => document.documentElement.dataset.theme === "dark"), "Dark applies at once");
	await widths.getByRole("button", { name: "Wide" }).click();
	same(await chosen(widths), ["Wide"], "Wide is chosen");
	await closeDialog(page);
	same(await chatColumnWidth(page), 960, "Wide widens the room's column");
	same(await page.locator(".bubble:not(.user)").first().evaluate((element) => getComputedStyle(element).maxWidth), "972px", "the answer keeps its step past the rail");
	same(await page.locator(".composer-layout").first().evaluate((element) => Math.round(element.getBoundingClientRect().width)), 1008, "the message box widens with the column");

	await page.reload();
	await page.locator("textarea").first().waitFor({ timeout: 15000 });
	await page.locator(".bubble-row").first().waitFor({ timeout: 15000 });
	same(await chatColumnWidth(page), 960, "Wide survives a reload");

	await stopSmokeServer(server);
	await startServer();
	await signIn(page);
	await enterRoom(page, "Width Room");
	await page.locator(".bubble-row").first().waitFor({ timeout: 15000 });
	same(await chatColumnWidth(page), 960, "Wide survives a server restart");
	await page.keyboard.press(process.platform === "darwin" ? "Meta+Comma" : "Control+Comma");
	await page.waitForSelector(".settings-overlay", { timeout: 10000 });
	await goToPane(page, "Appearance");
	same(await chosen(page.getByRole("group", { name: "Chat width" })), ["Wide"], "the pane still reads Wide after a restart");
	same(await chosen(page.getByRole("group", { name: "Theme" })), ["Dark"], "the theme comes back too");

	// Standard goes back to today's column.
	await page.getByRole("group", { name: "Chat width" }).getByRole("button", { name: "Standard" }).click();
	await closeDialog(page);
	same(await chatColumnWidth(page), 768, "Standard is the 768 px column again");
	await context.close();

	const phone = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true });
	const phonePage = await phone.newPage();
	await signIn(phonePage);
	await openSettings(phonePage);
	await goToPane(phonePage, "Appearance");
	same(await phonePage.locator(".settings-overlay .settings-row-label:visible").allInnerTexts(), ["Theme"], "a phone's Appearance holds Theme alone");
	assert(await phonePage.getByRole("group", { name: "Theme" }).isVisible(), "a phone offers the theme");
	const themeHeight = await phonePage.getByRole("button", { name: "Dark", exact: true }).evaluate((element) => element.getBoundingClientRect().height);
	assert(themeHeight >= 38, `a phone's theme choice is ${themeHeight} px tall, too small for a finger`);
	assert((await phonePage.getByRole("group", { name: "Chat width" }).count()) === 0, "a phone is not offered Chat width");
	await phone.close();
	console.log("  ok  Appearance: the theme, Wide at 960 px through a reload and a restart, Theme alone on a phone");
}

async function dialogWords(page: Page) {
	const dialog = page.getByRole("alertdialog");
	await dialog.waitFor({ timeout: 5000 });
	return { text: (await dialog.innerText()).replace(/\s+/g, " ").trim(), red: await dialog.locator(".rs-btn-danger").innerText() };
}
const FORGET_WORDS = (body: string) => ({ text: `${QUESTION} ${body} Cancel Forget`, red: "Forget" });

async function checkForget(browser: Browser): Promise<void> {
	const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
	const page = await context.newPage();
	const mementos: string[] = [];
	page.on("request", (request) => { if (request.method() === "POST" && request.url().endsWith("/memento")) mementos.push(request.postData() ?? ""); });
	await signIn(page);

	// In the room, idle: the bin's question and the pane's are the same words.
	await enterRoom(page, "Forget Room");
	await send(page, "Keep this for now.");
	await page.getByText("Answer from the model.").first().waitFor({ timeout: 45000 });
	await page.getByRole("button", { name: "Forget", exact: true }).first().click();
	same(await dialogWords(page), FORGET_WORDS(QUIET_BODY), "the bin's question");
	await page.getByRole("alertdialog").getByRole("button", { name: "Cancel" }).click();
	await page.locator('button[aria-label="Room settings"]').first().click();
	await page.waitForSelector(".rs-shell", { timeout: 10000 });
	await goToPane(page, "Conversation");
	const forgetRow = page.locator(".room-session-section").getByRole("button", { name: "Forget…" });
	await forgetRow.click();
	same(await dialogWords(page), FORGET_WORDS(QUIET_BODY), "the pane's question, idle");
	assert((await page.locator(".room-session-section").getByText("Forget conversation").count()) === 0, "the inline confirmation is gone");
	await page.getByRole("alertdialog").getByRole("button", { name: "Cancel" }).click();
	await page.getByRole("alertdialog").waitFor({ state: "detached", timeout: 5000 });
	assert(await forgetRow.isVisible(), "Cancel leaves the pane as it was");
	same(mementos.length, 0, "a cancelled question forgets nothing");
	await closeDialog(page);

	// With an answer running, both add its line.
	await send(page, HOLD);
	await page.getByText("Still writing").first().waitFor({ timeout: 15000 });
	await page.getByRole("button", { name: "Forget", exact: true }).first().click();
	same(await dialogWords(page), FORGET_WORDS(RUNNING_BODY), "the bin's question while an answer runs");
	await page.getByRole("alertdialog").getByRole("button", { name: "Cancel" }).click();
	await page.locator('button[aria-label="Room settings"]').first().click();
	await page.waitForSelector(".rs-shell", { timeout: 10000 });
	await goToPane(page, "Conversation");
	await forgetRow.click();
	same(await dialogWords(page), FORGET_WORDS(RUNNING_BODY), "the pane's question while an answer runs");

	// Forget from the pane: one request, and the room closes as it did.
	await page.getByRole("alertdialog").getByRole("button", { name: "Forget", exact: true }).click();
	await page.locator(".persistent-agent-card").first().waitFor({ timeout: 15000 });
	same(mementos.length, 1, "Forget sends one request");
	assert(JSON.parse(mementos[0]).conversationId, "the request names the conversation");
	releaseHeld?.();
	releaseHeld = null;

	// From the card on Home, the same question, and the pane says it is done.
	await enterRoom(page, "Home Forget Room");
	await send(page, "A conversation to forget from Home.");
	await page.getByText("Answer from the model.").first().waitFor({ timeout: 45000 });
	await page.getByRole("button", { name: "Home", exact: true }).first().click();
	await page.locator(".persistent-agent-card").first().waitFor({ timeout: 15000 });
	await openRoomCardSettings(page, "Home Forget Room");
	await goToPane(page, "Conversation");
	await page.locator(".room-session-section").getByRole("button", { name: "Forget…" }).click();
	same(await dialogWords(page), FORGET_WORDS(QUIET_BODY), "the question from Home's card");
	await page.getByRole("alertdialog").getByRole("button", { name: "Cancel" }).click();
	await closeDialog(page);
	// The card's own read of the room carries the running line too.
	await enterRoom(page, "Home Forget Room");
	await send(page, HOLD);
	await page.getByText("Still writing").first().waitFor({ timeout: 15000 });
	await page.getByRole("button", { name: "Home", exact: true }).first().click();
	await page.locator(".persistent-agent-card").first().waitFor({ timeout: 15000 });
	await openRoomCardSettings(page, "Home Forget Room");
	await goToPane(page, "Conversation");
	await page.locator(".room-session-section").getByText("(in use)").waitFor({ timeout: 15000 });
	await page.locator(".room-session-section").getByRole("button", { name: "Forget…" }).click();
	same(await dialogWords(page), FORGET_WORDS(RUNNING_BODY), "the question from Home's card while an answer runs");
	await page.getByRole("alertdialog").getByRole("button", { name: "Forget", exact: true }).click();
	await page.getByText("This conversation is forgotten. The room starts a fresh one on next open.").waitFor({ timeout: 10000 });
	same(mementos.length, 2, "Forget from Home sends one request");
	await context.close();
	console.log("  ok  Forget: one question from the bin and the pane, its running line, one request");
}

async function checkSetWorkspaceLink(browser: Browser): Promise<void> {
	const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
	const page = await context.newPage();
	await signIn(page);
	await enterRoom(page, "Look Room");
	await page.getByRole("button", { name: "Set workspace" }).click();
	await page.waitForSelector(".rs-shell", { timeout: 10000 });
	same(await activePane(page), "Folder", "Set workspace opens Room settings at Folder");
	await closeDialog(page);
	await context.close();
	console.log("  ok  Set workspace lands on Folder");
}

try {
	await new Promise<void>((resolve) => provider.listen(0, "127.0.0.1", resolve));
	const providerPort = (provider.address() as AddressInfo).port;
	fs.writeFileSync(path.join(agentDir, "models.json"), JSON.stringify({
		providers: { "fake-claude": { name: "Fake Claude", baseUrl: `http://127.0.0.1:${providerPort}`, api: "anthropic-messages", models: [{ id: "claude-fake", name: "Claude Fake", input: ["text"], contextWindow: 200000, maxTokens: 16000, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }] } },
	}), { mode: 0o600 });
	fs.writeFileSync(path.join(agentDir, "auth.json"), JSON.stringify({ "fake-claude": { type: "api_key", key: "synthetic-claude" } }), { mode: 0o600 });
	fs.writeFileSync(path.join(appDir, "custom-ai-profiles.json"), JSON.stringify({ version: 1, profiles: [{ id: "custom-fake-claude", providerId: "fake-claude", label: "Fake Claude", roomModels: ["claude-fake"], learnModel: "claude-fake", reviewMemoryModel: "claude-fake" }] }), { mode: 0o600 });
	fs.writeFileSync(path.join(appDir, "persistent-agent-ai-profile.json"), JSON.stringify({ profileId: "custom-fake-claude" }), { mode: 0o600 });

	const agents = await import("../src/persistent-agents.js");
	const roomModels = await import("../src/room-models.js");
	const makeRoom = (displayName: string): string => {
		const agentId = agents.createPersistentAgentFromScaffoldInput({ displayName, userName: "Synthetic User", preferredUserAddress: "Synthetic User" }).agent.agentId;
		roomModels.writeRoomModels(agentId, { conversation: { provider: "fake-claude", model: "claude-fake" } });
		return agentId;
	};
	const lookRoom = makeRoom("Look Room");
	for (const name of ["Width Room", "Forget Room", "Home Forget Room"]) makeRoom(name);

	await startServer();
	const seed = async (method: "POST" | "PUT", route: string, body: unknown): Promise<void> => {
		const answer = await authedFetch(`${baseUrl}${route}`, { method, headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
		assert(answer.ok, `seeding ${route}: ${answer.status} ${await answer.text()}`);
	};
	const room = `/api/persistent-agents/${encodeURIComponent(lookRoom)}`;
	await seed("POST", `${room}/memory/entries`, { topic: "General", kind: "fact", text: "Reports go out on Fridays.", newTopic: true });
	await seed("POST", `${room}/memory/entries`, { topic: "Clients", kind: "fact", text: "Acme prefers short summaries.", newTopic: true });
	await seed("POST", `${room}/schedules`, SCHEDULE);
	// Two of each, so the place a line between rows would sit is on screen.
	for (const id of ["cite-sources", "plain-words"]) {
		await seed("POST", "/api/skills", { id, displayName: id, description: "A synthetic skill.", instructions: "Answer plainly." });
		await seed("PUT", `${room}/skill-settings`, { action: "enable", name: id });
	}
	for (const name of ["notes-server", "tickets-server"]) {
		await seed("POST", "/api/mcp/servers", { name, url: "http://127.0.0.1:9/mcp" });
		await seed("PUT", `${room}/mcp-connectors`, { action: "grant", name });
	}

	const browser = await chromium.launch({ ignoreDefaultArgs: ["--hide-scrollbars"] });
	try {
		await startConversation(browser, "Look Room");
		await checkLookOnEveryPane(browser);
		await checkPanesLessDevices(browser);
		await checkSetWorkspaceLink(browser);
		await checkAppearance(browser);
		await checkForget(browser);
	} finally {
		await browser.close();
	}
	console.log("settings look ui smoke passed");
} finally {
	await stopSmokeServer(server);
	provider.close();
	fs.rmSync(tempRoot, { recursive: true, force: true });
}
