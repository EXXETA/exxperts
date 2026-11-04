// The room's top bar lines up with the chat column, in the page against a real
// server: the room name starts where the answers' text starts, the last
// action's glyph ends on the workspace banner's right edge, and no "Talking
// to" label sits in the bar. Checked at 1280 and 1600 wide, with the sidebar
// open and collapsed, the file viewer closed and open beside the chat, in the
// browser and in the mac app's look. In the mac app's look the window buttons'
// row (centre y 25 in window points) holds the room name, its trash and gear,
// the open file's name and its three icons, and the approval preview's head:
// each one's ink centres on it, at 1x, 2x and 125% window zoom, with the
// sidebar open and hidden, and a long name stays on one line ending in "…".
// A deck's head keeps its template's kicker over its name, as tall as the row,
// its icons on the row. The row drags the window and its buttons click; the
// bars over it reach the drag strip's bottom, and Home's content starts under
// the strip, at 69.4% zoom too. The sidebar's wordmark stays where it was. On a sharp screen the sidebar button's glyph centres on
// the wordmark's small letters. The floating sidebar button shown while the
// sidebar is collapsed is just its glyph at rest; hover and keyboard focus
// show its square, and focus a ring. At phone width the bar has no "Talking
// to" either, and the button keeps its resting square. Offline: a synthetic model answers
// "Noted.". Throwaway HOME.
import fs from "node:fs";
import path from "node:path";
import { chromium, type Page } from "playwright";
import { agentsRoot, assert, baseUrl, openRoom, rename, requestJson, startRoomStateServer, stopRoomStateServer, waitUntil } from "./room-state-setup.js";
import { SMOKE_AUTH_TOKEN } from "./smoke-server-process.js";
import { closeBrowser, closeContext } from "./smoke-close-context.js";

{
	const executable = typeof chromium?.executablePath === "function" ? chromium.executablePath() : "";
	if (!executable || !fs.existsSync(executable)) {
		console.log("room-topbar-ui-smoke skipped (Chromium not installed)");
		process.exit(0);
	}
}

const ROOM = "Lisbon Trip";
// Longer than a 360px chat column, beside an open file pane.
const LONG_ROOM = "Lisbon Trip, three days of planning for the whole design team offsite";
const MESSAGE = "Plan three days in Lisbon for a team offsite.";
const ANSWER = "Noted.";
const FILE = "agenda.md";
// A deck a template made in this conversation: its head keeps the template's kicker over the file's name.
const DECK = "offsite-deck.html";
const TRANSPARENT = "rgba(0, 0, 0, 0)";
// With the sidebar collapsed the bar keeps clear of the floating sidebar
// button (and in the mac app of the traffic lights): a floor under the room
// name's edge, for a column so narrow its answers start under the button. In
// the mac app the floor is 12px past the 28px button, which sits 87 window
// points in. Kept with the clearances in 35-sidebar-remote.css and
// 34-desktop-app.css.
const COLLAPSED_CLEARANCE = { browser: () => 52, mac: (zoom: number) => 87 / zoom + 40 };
const ROOM_NAME = ".topbar .title";
const WORDMARK = ".brand img.logo";
// The mac window buttons' row: its centre in window points, and how far an ink centre may sit off it.
const MAC_ROW_CENTRE = 25;
const ON_ROW = 0.5;
// The sidebar wordmark's ink centre in the mac app, in CSS px: the header's 62px and half of the logo's 22.
const MAC_WORDMARK_CENTRE = 73;
// What sits on the mac row, by place.
const TOPBAR_PARTS = { "the room name": ROOM_NAME, "the trash": '.topbar-actions button[aria-label="Forget"] svg', "the gear": '.topbar-actions button[aria-label="Room settings"] svg' };
const FILE_ICONS = { "open in a new tab": ".artifact-viewer-actions > :nth-child(1)", "maximize": ".artifact-viewer-actions > :nth-child(2)", "close": ".artifact-viewer-actions > :nth-child(3) svg" };
const FILE_PARTS = { "the file's name": ".artifact-viewer-template", ...FILE_ICONS };
const PREVIEW_PARTS = { "the preview's kicker and title": ".preview-head > div", "the preview's close": ".preview-close" };
// The preview's card, sent on the page's end of the room's socket, as the room's own write approval sends it.
const PREVIEW_CARD = { type: "ui_request", kind: "confirm", id: "card-with-preview", title: "Create local HTML deck?", message: "Create deck.html", detail: "File: deck.html\nGenerated HTML preview:\n<!doctype html><html><body><h1>The deck</h1></body></html>" };
const SIDEBAR_BUTTON = ".sidebar-header .sidebar-toggle";
// The wordmark's first letter, an "e": the share of the logo's width it takes.
const FIRST_LETTER = 0.11;

interface Layout {
	titleLeft: number;
	answerLeft: number;
	lastGlyphRight: number;
	bannerRight: number;
	barText: string;
}

interface Ink { top: number; bottom: number; centre: number }

// The page's boxes, read in one evaluate. No named function inside it: tsx
// wraps those in a helper the page does not have.
async function layout(page: Page): Promise<Layout | string> {
	const parts = { "the room name": ".topbar .title", "the last action's glyph": ".topbar-actions > :last-child svg", "the workspace banner": ".room-workspace-nudge", "the answer": ".messages .bubble-row:not(.user) .assistant-markdown" };
	const boxes = await page.evaluate((selectors) => selectors.map((selector) => document.querySelector(selector)?.getBoundingClientRect().toJSON() ?? null), Object.values(parts));
	const missing = Object.keys(parts).filter((_, at) => !boxes[at]);
	if (missing.length > 0) return `not on screen: ${missing.join(", ")}`;
	const [title, lastGlyph, banner, answer] = boxes as DOMRect[];
	return { titleLeft: title.left, answerLeft: answer.left, lastGlyphRight: lastGlyph.right, bannerRight: banner.right, barText: await page.locator(".topbar").first().innerText() };
}

// Where the ink of a region runs top to bottom, in CSS px: the page is
// photographed at its own scale, the region cut out of it on whole device
// pixels and read in a blank page of the same browser; ink is any pixel well
// off the region's top-left colour. A clip on whole CSS pixels is not enough:
// at a scale such as 2.5 it can start inside a device pixel, and the browser
// then resamples it, which smears the edges.
async function inkOf(page: Page, decoder: Page, selector: string, { pad = 0, widthShare = 1 } = {}): Promise<Ink | string> {
	const box = await page.locator(selector).first().boundingBox();
	if (!box) return `not on screen: ${selector}`;
	const scale = await page.evaluate(() => devicePixelRatio);
	const left = Math.floor((box.x - pad) * scale);
	const top = Math.floor((box.y - pad) * scale);
	const region = { left, top, width: Math.ceil((box.x + box.width * widthShare + pad) * scale) - left, height: Math.ceil((box.y + box.height + pad) * scale) - top };
	const png = (await page.screenshot()).toString("base64");
	const rows = await decoder.evaluate(async ({ data, region }) => {
		const bitmap = await createImageBitmap(await (await fetch(`data:image/png;base64,${data}`)).blob());
		const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
		const context = canvas.getContext("2d")!;
		context.drawImage(bitmap, 0, 0);
		const pixels = context.getImageData(region.left, region.top, region.width, region.height).data;
		let top = -1;
		let bottom = -1;
		for (let y = 0; y < region.height; y++) {
			for (let x = 0; x < region.width; x++) {
				const at = (y * region.width + x) * 4;
				if (Math.max(Math.abs(pixels[at] - pixels[0]), Math.abs(pixels[at + 1] - pixels[1]), Math.abs(pixels[at + 2] - pixels[2])) > 60) {
					if (top < 0) top = y;
					bottom = y + 1;
					break;
				}
			}
		}
		return { top, bottom };
	}, { data: png, region });
	if (rows.top < 0) return `no ink in ${selector}`;
	const inkTop = (region.top + rows.top) / scale;
	const inkBottom = (region.top + rows.bottom) / scale;
	return { top: inkTop, bottom: inkBottom, centre: (inkTop + inkBottom) / 2 };
}

function layoutProblems(measured: Layout | string, clearance: number): string[] {
	if (typeof measured === "string") return [measured];
	const problems: string[] = [];
	const nameEdge = Math.max(measured.answerLeft, clearance);
	if (Math.abs(measured.titleLeft - nameEdge) > 1) problems.push(`the room name starts at ${measured.titleLeft.toFixed(1)}, the answer's text at ${measured.answerLeft.toFixed(1)}${clearance > 0 ? `, the collapsed sidebar's clearance at ${clearance}` : ""}`);
	if (Math.abs(measured.lastGlyphRight - measured.bannerRight) > 1) problems.push(`the last action's glyph ends at ${measured.lastGlyphRight.toFixed(1)}, the workspace banner at ${measured.bannerRight.toFixed(1)}`);
	if (measured.barText.includes("Talking to")) problems.push(`the bar says "Talking to": ${JSON.stringify(measured.barText)}`);
	return problems;
}

const failures: string[] = [];
let passes = 0;
let error: unknown;
let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
try {
	await startRoomStateServer();
	const { roomId, conversationId } = await openRoom(ROOM);
	const deckHtml = "<!doctype html><title>Offsite deck</title><h1>Lisbon offsite</h1>";
	const roomDir = path.join(agentsRoot, roomId);
	fs.mkdirSync(path.join(roomDir, "files"), { recursive: true });
	fs.writeFileSync(path.join(roomDir, "files", DECK), deckHtml);
	fs.mkdirSync(path.join(roomDir, "runtime", "task-ledger"), { recursive: true });
	fs.writeFileSync(path.join(roomDir, "runtime", "task-ledger", "tsk-deck1.json"), `${JSON.stringify({ schemaVersion: 1, taskId: "tsk-deck1", roomId, conversationId, templateId: "deck", templateVersion: 1, title: "Offsite deck", startedAt: "2026-11-01T10:00:00.000Z", endedAt: "2026-11-01T10:05:00.000Z", outcome: "ok", awayNoticedAt: "2026-11-01T10:05:00.000Z", artifacts: [{ relativePath: `files/${DECK}`, bytes: deckHtml.length, extension: ".html" }] }, null, 2)}\n`);
	const uploaded = await requestJson(`/api/persistent-agents/${roomId}/files`, { method: "POST", body: JSON.stringify({ filename: FILE, contentBase64: Buffer.from("# Agenda\n\nDay one: Alfama.\n").toString("base64") }) });
	assert(uploaded.status === 200 || uploaded.status === 201, `the file reaches the room's shelf, got ${uploaded.status} ${JSON.stringify(uploaded.body)}`);

	browser = await chromium.launch();
	const decoder = await browser.newPage();
	const page = await (await browser.newContext({ viewport: { width: 1600, height: 900 } })).newPage();
	await page.goto(`${baseUrl}/auth/session?token=${SMOKE_AUTH_TOKEN}`);
	await page.waitForLoadState("networkidle");
	const dismiss = page.locator(".whats-new-close");
	if (await dismiss.count()) await dismiss.click();
	await page.locator(".persistent-agent-card").filter({ hasText: ROOM }).getByRole("button", { name: /^(Enter|Resume)$/ }).click();
	const composer = page.locator("textarea").first();
	await composer.waitFor({ timeout: 15_000 });
	await composer.fill(MESSAGE);
	await waitUntil(() => page.getByRole("button", { name: "Send", exact: true }).isEnabled(), "Send is enabled");
	await composer.press("Enter");
	await page.locator(".messages").getByText(ANSWER, { exact: true }).first().waitFor({ timeout: 20_000 });
	await waitUntil(async () => (await requestJson(`/api/persistent-agents/${roomId}/status`)).body?.activeThread?.inFlight === false, "the turn settled");

	const floating = page.locator(".sidebar-toggle-floating");
	const setSidebar = async (collapsed: boolean) => {
		if ((await floating.count() > 0) === collapsed) return;
		await page.getByRole("button", { name: collapsed ? "Hide sidebar" : "Show sidebar" }).first().click();
		await waitUntil(async () => (await floating.count() > 0) === collapsed, collapsed ? "the sidebar is collapsed" : "the sidebar is open");
	};
	const setMacLook = (on: boolean) => page.evaluate((mac) => document.documentElement.classList.toggle("desktop-app-mac", mac), on);

	// Every place, measured once its layout has settled: a resize or a pane re-measures the scrollbar gutter a frame later.
	const checkPlace = async (label: string, clearance: number, on: Page = page) => {
		let last: Layout | string = "not measured";
		const settled = await waitUntil(async () => layoutProblems(last = await layout(on).catch((caught: Error) => `not measured: ${caught.message}`), clearance).length === 0, label, 3_000).then(() => true, () => false);
		if (settled) passes += 1;
		else failures.push(`${label}: ${layoutProblems(last, clearance).join("; ")}`);
	};
	// In the mac app's look, each part's ink centred on the window buttons' row: its centre in CSS px times the window zoom.
	// A 1x screen reads ink in whole CSS px, so it gets a whole px of room.
	const checkMacRow = async (on: Page, label: string, zoom: number, parts: Record<string, string>, room = ON_ROW) => {
		const viewport = on.viewportSize() ?? { width: 800, height: 600 };
		await on.mouse.move(viewport.width / 2, viewport.height - 40);
		// The display font sets the lines' metrics: measured before it loads, every line sits elsewhere.
		await on.evaluate(() => document.fonts.ready.then(() => undefined));
		// A pane just opened paints its head a frame or two later: measured once every part shows ink.
		let inks: [string, Ink | string][] = [];
		await waitUntil(async () => {
			inks = [];
			for (const [part, selector] of Object.entries(parts)) inks.push([part, await inkOf(on, decoder, selector, { pad: 1 })]);
			return inks.every(([, ink]) => typeof ink !== "string");
		}, `${label}: every part on the row shows ink`, 3_000).catch(() => {});
		const off: string[] = [];
		for (const [part, ink] of inks) {
			if (typeof ink === "string") off.push(ink);
			else if (Math.abs(ink.centre * zoom - MAC_ROW_CENTRE) > room) off.push(`${part}'s ink centres at ${(ink.centre * zoom).toFixed(2)}`);
		}
		if (off.length > 0) failures.push(`${label}: off the window buttons' row (${MAC_ROW_CENTRE} window points): ${off.join(", ")}`);
		else passes += 1;
	};
	// In the mac app's look the row drags the window: the bars that stretch over it, and the drag strip as tall as the row,
	// while their buttons click and the room name drags with its bar.
	const checkMacDrag = async (on: Page, label: string, zoom: number, bars: string[]) => {
		const look = await on.evaluate(({ bars, name }) => ({
			bars: bars.map((selector) => [selector, document.querySelector(selector) ? getComputedStyle(document.querySelector(selector)!).getPropertyValue("-webkit-app-region") : "missing"]),
			buttons: bars.flatMap((selector) => [...document.querySelectorAll(`${selector} button`)].map((button) => [`${selector} ${button.getAttribute("aria-label") ?? button.textContent}`, getComputedStyle(button).getPropertyValue("-webkit-app-region")])),
			name: document.querySelector(name) ? getComputedStyle(document.querySelector(name)!).getPropertyValue("-webkit-app-region") : "missing",
			strip: document.querySelector(".desktop-drag-strip")?.getBoundingClientRect().height ?? 0,
			bottoms: bars.filter((selector) => selector !== ".desktop-drag-strip").map((selector) => [selector, document.querySelector(selector)?.getBoundingClientRect().bottom ?? 0] as const),
		}), { bars: [...bars, ".desktop-drag-strip"], name: ROOM_NAME });
		const problems = [
			...look.bars.filter(([, region]) => region !== "drag").map(([selector, region]) => `${selector} is ${region || "unset"}, not drag`),
			...look.buttons.filter(([, region]) => region !== "no-drag").map(([button, region]) => `${button} is ${region || "unset"}, not no-drag`),
			...(look.name === "no-drag" || look.name === "missing" ? [`the room name is ${look.name}`] : []),
			...(Math.abs(look.strip * zoom - 2 * MAC_ROW_CENTRE) > 0.5 ? [`the drag strip is ${(look.strip * zoom).toFixed(1)} window points tall, the row ${2 * MAC_ROW_CENTRE}`] : []),
			// Under a bar's bottom edge the strip is the top layer: a click on the chat there would drag the window.
			...look.bottoms.filter(([, bottom]) => bottom < look.strip - 0.01).map(([selector, bottom]) => `${selector} ends at ${bottom.toFixed(1)}, above the drag strip's bottom ${look.strip.toFixed(1)}`),
		];
		if (look.buttons.length === 0) problems.push("no buttons in the row's bars");
		if (problems.length > 0) failures.push(`${label}: the drag area: ${problems.join("; ")}`);
		else passes += 1;
	};
	// The floating button at rest, on hover and on keyboard focus, in the look that is on.
	const checkFloatingButton = async (look: string) => {
		const background = () => floating.evaluate((el) => getComputedStyle(el).backgroundColor);
		await page.mouse.move(800, 600);
		await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
		const resting = await background();
		if (resting !== TRANSPARENT) failures.push(`${look}: the collapsed sidebar's button wears a square at rest (${resting})`);
		else passes += 1;
		await floating.hover();
		const hovered = await background();
		if (hovered === TRANSPARENT) failures.push(`${look}: the collapsed sidebar's button shows no square on hover`);
		else passes += 1;
		await page.mouse.move(800, 600);
		let focused = false;
		for (let tab = 0; tab < 60 && !focused; tab++) {
			await page.keyboard.press("Tab");
			focused = await floating.evaluate((el) => el === document.activeElement);
		}
		const focusLook = await floating.evaluate((el) => {
			const style = getComputedStyle(el);
			return { visible: el.matches(":focus-visible"), background: style.backgroundColor, ring: (style.outlineStyle !== "none" && parseFloat(style.outlineWidth) > 0) || style.boxShadow !== "none" };
		});
		if (!focused || !focusLook.visible) failures.push(`${look}: the collapsed sidebar's button is not reached by Tab with a visible focus`);
		else if (focusLook.background === TRANSPARENT || !focusLook.ring) failures.push(`${look}: the collapsed sidebar's button on keyboard focus shows ${focusLook.background === TRANSPARENT ? "no square" : "no ring"}`);
		else passes += 1;
		await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
	};

	for (const viewer of [false, true]) {
		if (viewer) {
			await page.setViewportSize({ width: 1600, height: 900 });
			await setSidebar(false);
			await page.locator(".attachments-entry").click();
			const fileCard = page.locator(".att-card").filter({ hasText: FILE.replace(/\.md$/, "") }).first();
			await fileCard.waitFor({ timeout: 10_000 }).catch(async () => { throw new Error(`the Attachments show no ${FILE} to open; the sidebar shows ${JSON.stringify(await page.locator(".sidebar").first().innerText().catch(() => ""))}`); });
			await fileCard.locator(".att-open").click();
			await page.locator(".workbench.with-right-pane aside.artifact-viewer").waitFor({ timeout: 10_000 });
		}
		for (const collapsed of [false, true]) {
			await setSidebar(collapsed);
			for (const width of [1280, 1600]) {
				await page.setViewportSize({ width, height: 900 });
				for (const mac of [false, true]) {
					await setMacLook(mac);
					const look = `${width} wide, ${mac ? "mac app" : "browser"}, sidebar ${collapsed ? "collapsed" : "open"}, viewer ${viewer ? "open" : "closed"}`;
					await checkPlace(look, collapsed ? COLLAPSED_CLEARANCE[mac ? "mac" : "browser"](1) : 0);
					if (mac) await checkMacRow(page, look, 1, viewer ? { ...TOPBAR_PARTS, ...FILE_PARTS } : TOPBAR_PARTS, 1);
					if (collapsed && !viewer) await checkFloatingButton(look);
				}
				await setMacLook(false);
			}
		}
	}

	// The phone keeps its bar as it was, the resting square on the sidebar button included, without "Talking to".
	await page.setViewportSize({ width: 390, height: 844 });
	await setSidebar(true);
	await page.mouse.move(200, 600);
	const phoneBar = await page.locator(".topbar").first().innerText();
	if (phoneBar.includes("Talking to")) failures.push(`at phone width the bar says "Talking to": ${JSON.stringify(phoneBar)}`);
	else passes += 1;
	const phoneResting = await floating.evaluate((el) => getComputedStyle(el).backgroundColor);
	if (phoneResting === TRANSPARENT) failures.push("at phone width the sidebar button lost its resting square");
	else passes += 1;
	// The phone keeps its own padding (set at its breakpoint): the room name clear of the actions, the last action inside the screen.
	const [name, first, last] = await page.evaluate((selectors) => selectors.map((selector) => document.querySelector(selector)?.getBoundingClientRect().toJSON() ?? null), [ROOM_NAME, ".topbar-actions > :first-child", ".topbar-actions > :last-child"]);
	const phoneWidth = page.viewportSize()?.width ?? 0;
	if (!name || !first || !last) failures.push(`at phone width not all of the bar is on screen: ${JSON.stringify({ name, first, last })}`);
	else if (name.right > first.left || last.right > phoneWidth) failures.push(`at phone width the bar overlaps: the room name ends at ${name.right}, the first action starts at ${first.left}, the last ends at ${last.right} on a ${phoneWidth} wide screen`);
	else passes += 1;

	// A sharp screen (2x): the sidebar button's glyph centred on the wordmark's small letters in the browser, the room name on the wordmark in the mac app's look. One place at a time: the 1x page leaves the room first.
	await closeContext(page.context());
	const sharp = await (await browser.newContext({ viewport: { width: 1280, height: 900 }, deviceScaleFactor: 2 })).newPage();
	await sharp.goto(`${baseUrl}/auth/session?token=${SMOKE_AUTH_TOKEN}`);
	await sharp.waitForLoadState("networkidle");
	if (await sharp.locator(".whats-new-close").count()) await sharp.locator(".whats-new-close").click();
	await sharp.locator(".persistent-agent-card").filter({ hasText: ROOM }).getByRole("button", { name: /^(Enter|Resume)$/ }).click();
	await sharp.locator(".room-workspace-nudge").waitFor({ timeout: 15_000 });
	await sharp.mouse.move(800, 600);
	const [button, letter] = [await inkOf(sharp, decoder, SIDEBAR_BUTTON), await inkOf(sharp, decoder, WORDMARK, { widthShare: FIRST_LETTER })];
	if (typeof button === "string" || typeof letter === "string") failures.push(`at 2x: ${[button, letter].filter((part) => typeof part === "string").join(", ")}`);
	else if (Math.abs(button.centre - letter.centre) > 0.25) failures.push(`at 2x the sidebar button's glyph runs ${button.top}..${button.bottom}, the wordmark's "e" ${letter.top}..${letter.bottom}`);
	else passes += 1;
	await closeContext(sharp.context());

	// The mac app's window, 1280x860 window points on a sharp screen, at 100% and 125% zoom: CSS px are window points over the zoom.
	for (const zoom of [0.694, 1, 1.25]) {
		const at = `mac app at ${Math.round(zoom * 1000) / 10}% zoom`;
		const mac = await (await browser.newContext({ viewport: { width: Math.round(1280 / zoom), height: Math.round(860 / zoom) }, deviceScaleFactor: 2 * zoom })).newPage();
		let roomSocket: { send(message: string): void } | undefined;
		await mac.routeWebSocket(/\/ws\?/, (ws) => {
			roomSocket = ws;
			const upstream = ws.connectToServer();
			ws.onMessage((message) => upstream.send(message));
			upstream.onMessage((message) => ws.send(message));
		});
		// The shell sets the class before the page runs and measures the zoom from the window; here both are set by hand.
		const macLook = () => mac.evaluate((windowZoom) => {
			document.documentElement.classList.add("desktop-app-mac");
			document.documentElement.style.setProperty("--window-zoom", String(windowZoom));
		}, zoom);
		const openFile = async () => {
			await mac.locator(".attachments-entry").click();
			await mac.locator(".att-card").filter({ hasText: FILE.replace(/\.md$/, "") }).first().locator(".att-open").click();
			await mac.locator(".workbench.with-right-pane aside.artifact-viewer").waitFor({ timeout: 10_000 });
		};
		await mac.goto(`${baseUrl}/auth/session?token=${SMOKE_AUTH_TOKEN}`);
		await mac.waitForLoadState("networkidle");
		if (await mac.locator(".whats-new-close").count()) await mac.locator(".whats-new-close").click();
		await macLook();
		// Home: its content starts under the drag strip, where a click clicks.
		const home = await mac.evaluate(() => {
			const landing = document.querySelector(".landing:not(.settings-dialog .landing)");
			return { contentTop: landing ? landing.getBoundingClientRect().top + parseFloat(getComputedStyle(landing).paddingTop) : -1, strip: document.querySelector(".desktop-drag-strip")?.getBoundingClientRect().bottom ?? 0 };
		});
		if (home.contentTop < home.strip - 0.01) failures.push(`${at}, Home: its content starts at ${home.contentTop.toFixed(1)}, under the drag strip that ends at ${home.strip.toFixed(1)}`);
		else passes += 1;
		await mac.locator(".persistent-agent-card").filter({ hasText: ROOM }).getByRole("button", { name: /^(Enter|Resume)$/ }).click();
		await mac.locator(".room-workspace-nudge").waitFor({ timeout: 15_000 });
		await macLook();
		await checkMacRow(mac, `${at}, sidebar open`, zoom, TOPBAR_PARTS);
		await checkMacDrag(mac, `${at}, sidebar open`, zoom, [".topbar"]);
		// Zoomed out, the row only has to stay covered: the rest is checked at 100% and 125%.
		if (zoom < 1) {
			await closeContext(mac.context());
			continue;
		}
		if (zoom === 1) {
			const wordmark = await inkOf(mac, decoder, WORDMARK, { pad: 2 });
			if (typeof wordmark === "string") failures.push(`${at}: ${wordmark}`);
			else if (Math.abs(wordmark.centre - MAC_WORDMARK_CENTRE) > ON_ROW) failures.push(`${at}: the sidebar's wordmark moved, its ink centres at ${wordmark.centre.toFixed(2)}, not ${MAC_WORDMARK_CENTRE}`);
			else passes += 1;
		}
		await openFile();
		await checkMacRow(mac, `${at}, sidebar open, file pane open`, zoom, { ...TOPBAR_PARTS, ...FILE_PARTS });
		await checkMacDrag(mac, `${at}, file pane open`, zoom, [".topbar", ".artifact-viewer-head"]);
		await mac.getByRole("button", { name: "Hide sidebar" }).first().click();
		await mac.locator(".sidebar-toggle-floating").waitFor({ timeout: 5_000 });
		await checkMacRow(mac, `${at}, sidebar hidden, file pane open`, zoom, { ...TOPBAR_PARTS, ...FILE_PARTS });
		await mac.locator(".artifact-viewer-close").click();
		await mac.locator("aside.artifact-viewer").waitFor({ state: "detached", timeout: 5_000 });
		await checkMacRow(mac, `${at}, sidebar hidden`, zoom, TOPBAR_PARTS);
		await checkPlace(`${at}, sidebar hidden`, COLLAPSED_CLEARANCE.mac(zoom), mac);
		await mac.getByRole("button", { name: "Show sidebar" }).first().click();
		await mac.locator(".sidebar-toggle-floating").waitFor({ state: "detached", timeout: 5_000 });
		assert(roomSocket, "the page's room socket is open");
		roomSocket.send(JSON.stringify(PREVIEW_CARD));
		await mac.locator("aside.preview-pane").waitFor({ timeout: 5_000 });
		await checkMacRow(mac, `${at}, approval preview open`, zoom, { ...TOPBAR_PARTS, ...PREVIEW_PARTS });
		await checkMacDrag(mac, `${at}, approval preview open`, zoom, [".topbar", ".preview-head"]);
		await mac.locator(".preview-close").click();
		// The deck: two lines, kicker and name, no taller than the row, its icons on the row.
		await mac.locator(".attachments-entry").click();
		await mac.locator(".att-card").filter({ hasText: "offsite deck" }).first().locator(".att-open").click();
		await mac.locator(".artifact-viewer-kicker:not(.artifact-viewer-kicker-noun)").filter({ hasText: "Deck" }).waitFor({ timeout: 10_000 });
		await mac.locator(".artifact-viewer-open-tab:enabled").waitFor({ timeout: 10_000 });
		const deckHead = await mac.evaluate(() => ({ height: document.querySelector(".artifact-viewer-head")?.getBoundingClientRect().height ?? 0, origin: document.querySelectorAll(".artifact-viewer-origin").length }));
		if (deckHead.origin > 0 || Math.abs(deckHead.height * zoom - 2 * MAC_ROW_CENTRE) > 0.5) failures.push(`${at}, a deck's head: ${(deckHead.height * zoom).toFixed(1)} window points tall${deckHead.origin > 0 ? ", with an origin line" : ""}, the row ${2 * MAC_ROW_CENTRE}`);
		else passes += 1;
		await checkMacRow(mac, `${at}, a deck's head with its template's kicker`, zoom, FILE_ICONS);
		// Its two lines centre on the row as one block: from the kicker's ink top to the name's ink bottom.
		const [kickerInk, deckNameInk] = [await inkOf(mac, decoder, ".artifact-viewer-kicker", { pad: 1 }), await inkOf(mac, decoder, ".artifact-viewer-template", { pad: 1 })];
		if (typeof kickerInk === "string" || typeof deckNameInk === "string") failures.push(`${at}, a deck's head: ${[kickerInk, deckNameInk].filter((part) => typeof part === "string").join(", ")}`);
		else if (Math.abs((kickerInk.top + deckNameInk.bottom) / 2 * zoom - MAC_ROW_CENTRE) > ON_ROW) failures.push(`${at}, a deck's head: its kicker and name centre at ${((kickerInk.top + deckNameInk.bottom) / 2 * zoom).toFixed(2)}, off the row (${MAC_ROW_CENTRE})`);
		else passes += 1;
		await mac.locator(".artifact-viewer-close").click();
		await mac.locator("aside.artifact-viewer").waitFor({ state: "detached", timeout: 5_000 });
		// A long name in the narrowest chat column, beside the file pane: one line ending in "…", the trash and gear still on the row.
		await rename(roomId, LONG_ROOM);
		await mac.reload();
		await mac.locator(".topbar .title").filter({ hasText: LONG_ROOM }).waitFor({ timeout: 15_000 });
		await macLook();
		await openFile();
		const name = await mac.locator(ROOM_NAME).evaluate((element) => ({ lines: Math.round(element.getBoundingClientRect().height / parseFloat(getComputedStyle(element).lineHeight)), cut: element.scrollWidth > element.clientWidth, ellipsis: getComputedStyle(element).textOverflow }));
		if (name.lines !== 1 || !name.cut || name.ellipsis !== "ellipsis") failures.push(`${at}, a long name beside the file pane: ${name.lines} line(s), ${name.cut ? "cut" : "not cut"}, text-overflow ${name.ellipsis}; one line ending in "…" expected`);
		else passes += 1;
		await checkMacRow(mac, `${at}, a long name beside the file pane`, zoom, { ...TOPBAR_PARTS, ...FILE_PARTS });
		await rename(roomId, ROOM);
		await closeContext(mac.context());
	}

	assert(failures.length === 0, `the room's top bar:\n  ${failures.join("\n  ")}`);
	console.log(`  ok the room name starts where the answers do and the last action's glyph ends on the workspace banner's edge, with no "Talking to", at 1280 and 1600 wide, sidebar open and collapsed, viewer closed and open, browser and mac look`);
	console.log("  ok in the mac app's look the room name, trash, gear, the file's name and icons, and the approval preview's head centre on the window buttons' row, at 1x, 2x and 125% zoom, sidebar open and hidden; a long name beside the file pane is one line ending in \"…\"; the row drags, its buttons click, and the sidebar's wordmark stays");
	console.log(`  ok at 2x the sidebar button's glyph centres on the wordmark's small letters`);
	console.log("  ok the collapsed sidebar's button is only its glyph at rest; hover and keyboard focus show its square, focus with a ring");
	console.log(`  ok at phone width the bar has no "Talking to", nothing in it overlaps, and the sidebar button keeps its resting square`);
	console.log(`room-topbar-ui-smoke: ${passes} checks passed`);
} catch (caught) {
	error = caught;
	console.error(`room-topbar-ui-smoke FAILED: ${(caught as Error).message}`);
	if (failures.length > 0 && !(caught as Error).message.includes(failures[0])) console.error(`  before that:\n  ${failures.join("\n  ")}`);
	process.exitCode = 1;
} finally {
	if (browser) await closeBrowser(browser).catch(() => {});
	await stopRoomStateServer(error);
}
