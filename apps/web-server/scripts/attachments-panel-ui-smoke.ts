// A room's Attachments, driven in the page against a real server: the panel
// beside the chat, a file opened in it, the verbs behind ⋯, the gallery from
// the enlarge button, the phone's sheet, and the cards' previews. pdf.js is
// watched by its requests: none in a room without PDFs, one fetch of a PDF
// however often its card comes back. Offline: a synthetic model. Throwaway HOME.
import fs from "node:fs";
import path from "node:path";
import { chromium } from "playwright";
import { agentsRoot, assert, baseUrl, openRoom, requestJson, startRoomStateServer, stopRoomStateServer, waitUntil } from "./room-state-setup.js";
import { SMOKE_AUTH_TOKEN } from "./smoke-server-process.js";
import { closeBrowser } from "./smoke-close-context.js";

{
	const executable = typeof chromium?.executablePath === "function" ? chromium.executablePath() : "";
	if (!executable || !fs.existsSync(executable)) {
		console.log("attachments-panel-ui-smoke skipped (Chromium not installed)");
		process.exit(0);
	}
}

const FILE_ROOM = "Harbour Survey";
const PLAIN_ROOM = "No Pdf Here";
const EMPTY_ROOM = "Bare Shelf";
const PHONE_EMPTY_ROOM = "Bare Pocket";
const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";
// The route takes a zip's magic and the extension; no preview reads further.
const OFFICE = Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.alloc(64)]).toString("base64");
const EMPTY_LINE = "Drop a file anywhere in the room. It can read what you attach, in any conversation.";
const MADE_PAGE = "<!doctype html><title>Market</title><h1>Market</h1>";
const PHONE_EMPTY_LINE = "The room can read what you attach here, in any conversation.";

/** One page, 400 by 600, a blue box from 120 to 360 down it on the card's 480px-wide canvas. */
function onePagePdf(): string {
	const content = "0.1 0.3 0.8 rg 40 300 320 200 re f";
	const objects = [
		"<</Type/Catalog/Pages 2 0 R>>",
		"<</Type/Pages/Kids[3 0 R]/Count 1>>",
		"<</Type/Page/Parent 2 0 R/MediaBox[0 0 400 600]/Contents 4 0 R>>",
		`<</Length ${content.length}>>\nstream\n${content}\nendstream`,
	];
	let body = "%PDF-1.4\n";
	const offsets = objects.map((object, index) => {
		const offset = body.length;
		body += `${index + 1} 0 obj\n${object}\nendobj\n`;
		return offset;
	});
	const xref = body.length;
	body += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map((offset) => `${String(offset).padStart(10, "0")} 00000 n \n`).join("")}`;
	body += `trailer\n<</Size ${objects.length + 1}/Root 1 0 R>>\nstartxref\n${xref}\n%%EOF\n`;
	return Buffer.from(body, "latin1").toString("base64");
}

const text = (body: string) => Buffer.from(body).toString("base64");
const FILES: Record<string, string> = {
	"survey.pdf": onePagePdf(),
	"harbour-photo.png": PNG,
	"tide-notes.md": text("# Tide notes\nHigh water at six.\n"),
	"soundings.csv": text("depth,site\n12,north\n"),
	"contract.docx": OFFICE,
	"costs.xlsx": OFFICE,
	"site.html": text("<h1>Site</h1>\n"),
};

async function upload(roomId: string, files: Record<string, string>): Promise<void> {
	for (const [filename, contentBase64] of Object.entries(files)) {
		const uploaded = await requestJson(`/api/persistent-agents/${roomId}/files`, { method: "POST", body: JSON.stringify({ filename, contentBase64 }) });
		assert(uploaded.status === 200 || uploaded.status === 201, `${filename} reaches the room's shelf, got ${uploaded.status} ${JSON.stringify(uploaded.body)}`);
	}
}

// A computed colour as 0-255 channels and alpha: "rgb(...)", "rgba(...)" or "color(srgb r g b / a)".
function channels(color: string): { rgb: number[]; alpha: number } {
	const values = (color.match(/[\d.]+/g) ?? []).map(Number);
	const scale = color.startsWith("color(") ? 255 : 1;
	return { rgb: values.slice(0, 3).map((value) => value * scale), alpha: values[3] ?? 1 };
}

// The colour a person sees: each layer painted over the ones under it, the first layer opaque.
function painted(...layers: string[]): number[] {
	return layers.map(channels).reduce((under, { rgb, alpha }) => rgb.map((value, index) => value * alpha + under[index]! * (1 - alpha)), [0, 0, 0]);
}

// WCAG 2 contrast ratio between two seen colours.
function contrast(first: number[], second: number[]): number {
	const luminance = (rgb: number[]) => {
		const [r, g, b] = rgb.map((value) => { const channel = value / 255; return channel <= 0.03928 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4; });
		return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!;
	};
	const [lighter, darker] = [luminance(first), luminance(second)].sort((x, y) => y - x);
	return (lighter! + 0.05) / (darker! + 0.05);
}

const ok = (lines: string[], line: string) => lines.push(`  ok ${line}`);
const said: string[] = [];

let error: unknown;
let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
try {
	await startRoomStateServer();
	await openRoom(EMPTY_ROOM);
	await openRoom(PHONE_EMPTY_ROOM);
	const plain = await openRoom(PLAIN_ROOM);
	await upload(plain.roomId, { "plain-notes.md": text("Only words here.\n") });
	const files = await openRoom(FILE_ROOM);
	await upload(files.roomId, FILES);
	// What the room made: a shelf file of a task, and an old run's file outside the shelf.
	const roomDir = path.join(agentsRoot, files.roomId);
	const ledger = (taskId: string, title: string, relativePath: string, bytes: number) => fs.writeFileSync(path.join(roomDir, "runtime", "task-ledger", `${taskId}.json`), JSON.stringify({ schemaVersion: 1, taskId, roomId: files.roomId, conversationId: files.conversationId, templateId: "deck", templateVersion: 1, title, startedAt: "2026-10-02T10:00:00.000Z", endedAt: "2026-10-02T10:05:00.000Z", outcome: "ok", viewedAt: "2026-10-02T10:06:00.000Z", artifacts: [{ relativePath, bytes, extension: ".html" }] }));
	fs.mkdirSync(path.join(roomDir, "runtime", "task-ledger"), { recursive: true });
	fs.writeFileSync(path.join(roomDir, "files", "market-overview.html"), MADE_PAGE);
	ledger("tsk-made1", "Market overview", "files/market-overview.html", MADE_PAGE.length);
	ledger("tsk-oldrun", "Old run", "tasks/tsk-oldrun/old-run.html", MADE_PAGE.length);

	browser = await chromium.launch();
	const page = await (await browser.newContext({ viewport: { width: 1440, height: 900 }, acceptDownloads: true })).newPage();
	const pdfjsRequests: string[] = [];
	const pdfFetches: string[] = [];
	const fileWrites: string[] = [];
	page.on("request", (request) => {
		const url = new URL(request.url());
		if (/\/assets\/pdf[.-]/.test(url.pathname)) pdfjsRequests.push(url.pathname);
		if (request.method() === "GET" && url.pathname.endsWith("/files/survey.pdf")) pdfFetches.push(url.pathname);
		if (request.method() !== "GET" && url.pathname.includes(`/api/persistent-agents/${files.roomId}/files/`)) fileWrites.push(`${request.method()} ${url.pathname}`);
	});
	const pageErrors: string[] = [];
	page.on("pageerror", (caught) => pageErrors.push(caught.message));
	await page.goto(`${baseUrl}/auth/session?token=${SMOKE_AUTH_TOKEN}`);
	await page.waitForLoadState("networkidle");
	if (await page.locator(".whats-new-close").count()) await page.locator(".whats-new-close").click();

	const enter = async (room: string) => {
		await page.locator(".persistent-agent-card").filter({ hasText: room }).getByRole("button", { name: /^(Enter|Resume)$/ }).click();
		await page.locator(".attachments-entry").waitFor({ timeout: 15_000 });
	};
	const home = () => page.locator(".sidebar-home-btn").click();
	const entry = page.locator(".attachments-entry");
	const count = page.locator(".attachments-entry-count");
	const panel = page.locator(".attachments-panel");
	const gallery = page.locator(".attachments-gallery");
	const card = (name: string) => page.locator(".att-card").filter({ has: page.locator(".att-name", { hasText: name }) });
	const cards = page.locator(".att-card");
	const viewer = page.locator("aside.artifact-viewer");
	const composer = page.locator(".composer-box textarea");
	const menuOn = async (name: string) => {
		await card(name).hover();
		await card(name).locator(".att-more").click();
		return page.locator(".att-menu");
	};
	const countIs = (n: number) => waitUntil(async () => (await count.count()) === 1 && (await count.innerText()).trim() === String(n), `the entry's number reaches ${n}`, 10_000);

	// The empty room: its words, and a file attached from the panel.
	await enter(EMPTY_ROOM);
	assert((await count.count()) === 0, "a room with no files shows a number");
	await entry.click();
	await panel.waitFor({ timeout: 5_000 });
	assert((await panel.locator(".att-empty-title").innerText()) === "No attachments yet", "the empty panel's title");
	assert((await panel.locator(".att-empty-line").innerText()) === EMPTY_LINE, "the empty panel's line");
	await panel.locator("input[type=file]").setInputFiles({ name: "first-note.txt", mimeType: "text/plain", buffer: Buffer.from("a first note\n") });
	await card("first note").waitFor({ timeout: 10_000 });
	await countIs(1);
	ok(said, "an empty room's panel says so and offers Attach a file; a file attached there makes a card and the number");
	await page.keyboard.press("Escape");
	await panel.waitFor({ state: "detached", timeout: 5_000 });
	await home();

	// A room with no PDF never loads pdf.js.
	await enter(PLAIN_ROOM);
	await entry.click();
	await card("plain notes").locator(".att-paper-text").waitFor({ timeout: 10_000 });
	assert(pdfjsRequests.length === 0, `a room without a PDF loaded pdf.js: ${pdfjsRequests.join(", ")}`);
	await entry.click();
	await panel.waitFor({ state: "detached", timeout: 5_000 });
	await home();
	ok(said, "a room without a PDF shows its first lines and never asks for pdf.js");

	// The panel beside the chat, the box still usable.
	await enter(FILE_ROOM);
	const startingCards = Object.keys(FILES).length + 2;
	await countIs(startingCards);
	assert((await page.locator(".sidebar .att-card").count()) === 0, "the sidebar holds no cards");
	assert((await panel.count()) === 0, "the panel starts closed");
	await entry.click();
	await panel.waitFor({ timeout: 5_000 });
	await waitUntil(async () => (await cards.count()) === startingCards, "a card per file", 5_000);
	assert((await entry.getAttribute("aria-expanded")) === "true", "the entry reads open");
	const sides = await page.evaluate(() => ({ main: document.querySelector(".workbench > .main")?.getBoundingClientRect().right ?? 0, panel: document.querySelector(".attachments-panel")?.getBoundingClientRect().left ?? 0 }));
	assert(sides.main > 360 && sides.main <= sides.panel, `the panel sits beside the chat: the chat ends at ${sides.main}, the panel starts at ${sides.panel}`);
	await composer.fill("Which file has the tides?");
	assert((await composer.inputValue()) === "Which file has the tides?" && (await composer.isVisible()), "the box stays usable beside the panel");
	await composer.fill("");
	await page.locator(".composer input.composer-attach-input").first().setInputFiles({ name: "from-the-box.txt", mimeType: "text/plain", buffer: Buffer.from("from the box\n") });
	await card("from the box").waitFor({ timeout: 10_000 });
	await countIs(startingCards + 1);
	ok(said, "the panel opens beside the chat with a card per file, the box stays usable, and attaching from the box adds a card and raises the number");

	// The previews.
	const pdfCanvas = card("survey").locator("canvas");
	await pdfCanvas.waitFor({ timeout: 20_000 });
	const pixel = () => pdfCanvas.evaluate((canvas: HTMLCanvasElement) => ({ width: canvas.width, rgba: [...canvas.getContext("2d")!.getImageData(240, 240, 1, 1).data] }));
	await waitUntil(async () => (await pixel()).rgba[2]! > 150 && (await pixel()).rgba[0]! < 80, "the PDF's first page is drawn on its card", 10_000);
	assert((await pixel()).width === 480, `the first page is ${(await pixel()).width}px wide`);
	assert(pdfjsRequests.length > 0, "the PDF card asked for pdf.js");
	assert(pdfFetches.length === 1, `the PDF was fetched ${pdfFetches.length} times`);
	const image = card("harbour photo").locator("img.att-image");
	await waitUntil(() => image.evaluate((img: HTMLImageElement) => img.complete && img.naturalWidth > 0), "the picture shows on its card", 10_000);
	await waitUntil(async () => (await card("tide notes").locator(".att-paper-text").count()) === 1, "the Markdown's lines load", 10_000);
	assert((await card("tide notes").locator(".att-paper-text").innerText()).startsWith("# Tide notes\nHigh water"), "a Markdown card shows its first lines");
	assert((await card("soundings").locator(".att-paper-text").innerText()).startsWith("depth,site"), "a CSV card shows its first lines");
	const fade = await card("tide notes").locator(".att-paper-text").evaluate((paper) => getComputedStyle(paper, "::after").backgroundImage);
	assert(fade.startsWith("linear-gradient"), `a text card's lines fade out at the sheet's foot, not cut mid-letter: ${fade}`);
	for (const name of ["contract", "site"]) assert((await card(name).locator(".att-drawn:not(.att-drawn-sheet)").count()) === 1, `${name} shows the drawn page`);
	assert((await card("costs").locator(".att-drawn-sheet").count()) === 1, "a spreadsheet shows the drawn grid");
	const foot = await card("tide notes").locator(".att-foot").innerText();
	assert(/tide notes/i.test(foot) && /MD · \d+ B/.test(foot) && /attached · /.test(foot), `a card names its kind, size and when: ${JSON.stringify(foot)}`);
	const madeFoot = await card("market overview").locator(".att-foot").innerText();
	assert(/created · Oct 2/.test(madeFoot), `a file the room made reads created: ${JSON.stringify(madeFoot)}`);
	ok(said, "cards show the real picture, the PDF's real first page on a canvas, text's first lines, and the drawn page for Word, Excel and HTML, with name, kind, size and when");

	// A file in the panel, and back.
	await card("tide notes").locator(".att-open").click();
	await viewer.waitFor({ timeout: 5_000 });
	assert((await panel.count()) === 0, "the file takes the panel's place");
	assert((await composer.isVisible()), "the box stays beside the open file");
	assert((await viewer.locator(".artifact-viewer-quiet").filter({ hasText: "Download" }).count()) === 1 && (await viewer.locator(".artifact-viewer-quiet").filter({ hasText: "Save" }).count()) === 1, "the viewer keeps Download and Save");
	assert((await viewer.getByRole("button", { name: "Maximize panel" }).count()) === 1, "the viewer keeps its maximize");
	assert((await entry.getAttribute("aria-expanded")) === "true", "the entry stays open behind a file");
	await viewer.getByRole("button", { name: "Back to Attachments" }).click();
	await panel.waitFor({ timeout: 5_000 });
	await card("contract").locator(".att-open").click();
	await viewer.waitFor({ timeout: 5_000 });
	assert((await viewer.getByRole("alert").innerText()).includes("This file type cannot be previewed."), "a Word file keeps the viewer's own words");
	await page.keyboard.press("Escape");
	await panel.waitFor({ timeout: 5_000 });
	ok(said, "a card opens the file in the panel with Download, Save and maximize; the back arrow and Escape return to the cards");

	// ⋯: Download, Rename, Delete with Undo.
	const download = page.waitForEvent("download", { timeout: 10_000 });
	await (await menuOn("tide notes")).getByRole("menuitem", { name: "Download" }).click();
	assert((await download).suggestedFilename() === "tide-notes.md", "Download saves the file");
	assert((await page.locator(".att-menu").count()) === 0, "the menu closes after Download");
	const items = (await (await menuOn("tide notes")).getByRole("menuitem").allInnerTexts()).map((each) => each.trim());
	assert(JSON.stringify(items) === JSON.stringify(["Download", "Rename", "Delete"]), `the menu holds Download, Rename, Delete: ${JSON.stringify(items)}`);
	const pageTheme = await page.evaluate(() => document.documentElement.dataset.theme ?? "");
	const deleteColors = () => page.evaluate(() => {
		const item = getComputedStyle(document.querySelector(".att-menu-delete")!);
		return { text: item.color, tint: item.backgroundColor, menu: getComputedStyle(document.querySelector(".att-menu")!).backgroundColor };
	});
	for (const theme of ["light", "dark"]) {
		await page.evaluate((name) => { document.documentElement.dataset.theme = name; }, theme);
		// Colours ease between themes: read them once every transition has ended.
		await page.waitForFunction(() => document.getAnimations().length === 0, null, { timeout: 3_000 });
		const rest = await deleteColors();
		const atRest = contrast(painted(rest.text), painted(rest.menu));
		assert(atRest >= 4.5, `the menu's Delete reads at 4.5:1 in ${theme}, got ${atRest.toFixed(2)}`);
		await page.locator(".att-menu-delete").hover();
		const pointed = await deleteColors();
		const background = painted(pointed.menu, pointed.tint);
		const whilePointed = contrast(painted(pointed.menu, pointed.text), background);
		assert(whilePointed >= 4.5, `the menu's Delete reads at 4.5:1 in ${theme} while pointed at, got ${whilePointed.toFixed(2)}`);
		await page.locator(".att-menu").getByRole("menuitem", { name: "Download" }).hover();
		const entry = await page.evaluate(() => ({
			count: getComputedStyle(document.querySelector(".attachments-entry-count")!).color,
			row: getComputedStyle(document.querySelector(".attachments-entry")!).backgroundColor,
			sidebar: getComputedStyle(document.querySelector(".sidebar")!).backgroundColor,
		}));
		const countRatio = contrast(painted(entry.count), painted(entry.sidebar, entry.row));
		assert(countRatio >= 4.5, `the open Attachments row's number reads at 4.5:1 in ${theme}, got ${countRatio.toFixed(2)}`);
	}
	await page.evaluate((name) => { document.documentElement.dataset.theme = name; }, pageTheme);
	await page.keyboard.press("Escape");
	await page.locator(".att-menu").waitFor({ state: "detached", timeout: 3_000 });
	assert((await panel.count()) === 1, "Escape closes the menu, not the panel");

	await (await menuOn("tide notes")).getByRole("menuitem", { name: "Rename" }).click();
	const rename = page.locator(".att-card .assets-rename-input");
	await rename.waitFor({ timeout: 3_000 });
	await rename.fill("should-not-land.md");
	await page.keyboard.press("Escape");
	await rename.waitFor({ state: "detached", timeout: 3_000 });
	assert((await panel.count()) === 1 && (await card("tide notes").count()) === 1 && fileWrites.length < 1, `Escape ends a rename and nothing else (${fileWrites.join(", ")})`);
	await (await menuOn("tide notes")).getByRole("menuitem", { name: "Rename" }).click();
	await rename.fill("high-water.md");
	await page.keyboard.press("Enter");
	await card("high water").waitFor({ timeout: 10_000 });
	await waitUntil(async () => (await card("tide notes").count()) === 0, "the old name goes", 5_000);
	assert(fileWrites.length === 1, `a rename writes once: ${fileWrites.join(", ")}`);

	// An old run's file is no shelf file: it keeps Download and today's list operation.
	const oldRun = (await (await menuOn("old run")).getByRole("menuitem").allInnerTexts()).map((each) => each.trim());
	assert(JSON.stringify(oldRun) === JSON.stringify(["Download", "Remove from the list"]), `an old run's menu: ${JSON.stringify(oldRun)}`);
	await page.getByRole("menuitem", { name: "Remove from the list" }).click();
	await waitUntil(async () => (await card("old run").count()) === 0, "the old run leaves the list", 10_000);
	await page.getByRole("button", { name: "Undo" }).click();
	await card("old run").waitFor({ timeout: 10_000 });

	const before = await cards.count();
	await (await menuOn("high water")).getByRole("menuitem", { name: "Delete" }).click();
	await waitUntil(async () => (await cards.count()) === before - 1, "the deleted card goes", 10_000);
	await countIs(before - 1);
	await page.getByRole("button", { name: "Undo" }).click();
	await card("high water").waitFor({ timeout: 10_000 });
	await countIs(before);
	ok(said, "⋯ gives Download, Rename and Delete; Escape leaves a menu or a rename and not the panel; Delete's Undo brings the card and the number back");

	// The enlarge button: the same cards in place of the chat, and back.
	await panel.getByRole("button", { name: "Show as a gallery" }).click();
	await gallery.waitFor({ timeout: 5_000 });
	assert((await panel.count()) === 0, "the gallery replaces the panel");
	await waitUntil(async () => (await cards.count()) === before, "the gallery shows the same cards", 5_000);
	assert(!(await composer.isVisible()), "the gallery takes the chat's place");
	assert((await page.locator(".topbar").first().isVisible()), "the room's bar stays over the gallery");
	assert(pdfFetches.length === 1, `the gallery fetched the PDF again: ${pdfFetches.length}`);
	await card("survey").locator("canvas").waitFor({ timeout: 5_000 });
	await (await menuOn("high water")).getByRole("menuitem", { name: "Delete" }).click();
	await countIs(before - 1);
	await page.getByRole("button", { name: "Undo" }).click();
	await card("high water").waitFor({ timeout: 10_000 });
	await card("high water").locator(".att-open").click();
	await viewer.waitFor({ timeout: 5_000 });
	assert((await gallery.isVisible()), "a file opens beside the gallery");
	await viewer.getByRole("button", { name: "Close file viewer" }).click();
	await viewer.waitFor({ state: "detached", timeout: 5_000 });
	assert((await gallery.isVisible()), "closing the file leaves the gallery");
	await gallery.getByRole("button", { name: "Back to the conversation" }).click();
	await panel.waitFor({ timeout: 5_000 });
	assert((await composer.isVisible()), "the way back shows the chat beside the panel");
	await panel.getByRole("button", { name: "Show as a gallery" }).click();
	await gallery.waitFor({ timeout: 5_000 });
	await page.keyboard.press("Escape");
	await panel.waitFor({ timeout: 5_000 });
	await panel.getByRole("button", { name: "Close attachments" }).click();
	await panel.waitFor({ state: "detached", timeout: 5_000 });
	await entry.click();
	await panel.waitFor({ timeout: 5_000 });
	await card("survey").locator("canvas").waitFor({ timeout: 5_000 });
	assert(pdfFetches.length === 1, `reopening the panel fetched the PDF again: ${pdfFetches.length}`);
	ok(said, "the enlarge button shows the same cards in place of the chat under the room's bar, Undo works there, a file opens beside it, and the arrow and Escape return to the panel; the PDF was fetched once in all of it");

	// The mac app: its drag strip lies over the top row, and the room's bar over the strip.
	await page.evaluate(() => document.documentElement.classList.add("desktop-app-mac"));
	await panel.getByRole("button", { name: "Show as a gallery" }).click();
	await gallery.waitFor({ timeout: 5_000 });
	const gearOnTop = await page.getByRole("button", { name: "Room settings" }).evaluate((button) => {
		const { left, top, width, height } = button.getBoundingClientRect();
		const hit = document.elementFromPoint(left + width / 2, top + height / 2);
		return { onTop: button.contains(hit), hit: hit?.className ?? "" };
	});
	assert(gearOnTop.onTop, `in the mac app the room's bar takes clicks over the gallery; the top element there is ${JSON.stringify(gearOnTop.hit)}`);
	await page.getByRole("button", { name: "Back to the conversation" }).click();
	await panel.waitFor({ timeout: 5_000 });
	await page.evaluate(() => document.documentElement.classList.remove("desktop-app-mac"));
	ok(said, "in the mac app the room's bar takes clicks over the gallery");

	// Another room has other files: an open gallery does not follow.
	await panel.getByRole("button", { name: "Show as a gallery" }).click();
	await gallery.waitFor({ timeout: 5_000 });
	await home();
	await enter(PLAIN_ROOM);
	assert((await gallery.count()) === 0 && (await panel.count()) === 0 && (await composer.isVisible()), "entering another room shows its chat, not the last room's Attachments");
	await home();
	await enter(FILE_ROOM);
	ok(said, "the panel and the gallery stay with their room");

	// The phone: a sheet over the chat, two a row; a file full screen.
	await page.setViewportSize({ width: 390, height: 844 });
	await waitUntil(() => page.evaluate(() => document.documentElement.classList.contains("sidebar-collapsed")), "the phone's drawer starts closed", 5_000);
	await page.getByRole("button", { name: "Show sidebar" }).first().click();
	await entry.waitFor({ state: "visible", timeout: 10_000 });
	await entry.click();
	await panel.waitFor({ timeout: 5_000 });
	await waitUntil(() => page.evaluate(() => document.documentElement.classList.contains("sidebar-collapsed")), "the drawer closes for the sheet", 5_000);
	const sheet = await page.evaluate(() => {
		const box = document.querySelector(".attachments-panel")!.getBoundingClientRect();
		const tops = [...document.querySelectorAll(".att-card")].slice(0, 3).map((each) => each.getBoundingClientRect().top);
		return { top: box.top, bottom: box.bottom, left: box.left, width: box.width, tops, gallery: document.querySelectorAll('[aria-label="Show as a gallery"]').length };
	});
	assert(sheet.bottom === 844 && sheet.left === 0 && sheet.width === 390 && sheet.top > 80 && sheet.top < 200, `the sheet comes from the bottom over the chat: ${JSON.stringify(sheet)}`);
	assert(sheet.tops[0] === sheet.tops[1] && sheet.tops[2]! > sheet.tops[1]!, `two cards a row: ${JSON.stringify(sheet.tops)}`);
	assert(sheet.gallery === 0, "a phone has no enlarge button");
	await card("high water").scrollIntoViewIfNeeded();
	await card("high water").locator(".att-more").click();
	await page.locator(".att-menu").getByRole("menuitem", { name: "Delete" }).click();
	const undo = page.getByRole("button", { name: "Undo" });
	await undo.waitFor({ timeout: 5_000 });
	await undo.click();
	await card("high water").waitFor({ timeout: 10_000 });
	await card("high water").locator(".att-open").click();
	await viewer.waitFor({ timeout: 5_000 });
	// The viewer slides in, so its box settles a moment after it shows.
	await waitUntil(async () => {
		const shown = await viewer.boundingBox();
		return shown?.x === 0 && shown.y === 0 && Math.round(shown.width) === 390 && shown.height === 844;
	}, "a tapped file fills the screen", 3_000);
	assert(await viewer.getByRole("button", { name: "Open in a new tab" }).isVisible(), "a phone's file keeps Open in a new tab");
	assert(!(await viewer.getByRole("button", { name: "Maximize panel" }).isVisible()), "a phone's full-screen file has nothing to maximize");
	await viewer.getByRole("button", { name: "Back to Attachments" }).click();
	await panel.waitFor({ timeout: 5_000 });
	// Back from a file lands where the person was.
	await page.locator(".att-grid").evaluate((grid) => { grid.scrollTop = 300; });
	const scrolledTo = await page.locator(".att-grid").evaluate((grid) => grid.scrollTop);
	await page.locator(".att-card").nth(5).locator(".att-open").click();
	await viewer.waitFor({ timeout: 5_000 });
	await viewer.getByRole("button", { name: "Back to Attachments" }).click();
	await panel.waitFor({ timeout: 5_000 });
	await waitUntil(async () => (await page.locator(".att-grid").evaluate((grid) => grid.scrollTop)) === scrolledTo, "the cards keep their scroll", 3_000);
	// A card scrolled to the sheet's top: its menu comes into view, not behind the head.
	await page.locator(".att-grid").evaluate((grid) => {
		const foot = [...grid.querySelectorAll(".att-card")][4]!.querySelector(".att-foot")!;
		grid.scrollTop += foot.getBoundingClientRect().top - grid.getBoundingClientRect().top;
	});
	await page.locator(".att-card").nth(4).locator(".att-more").click();
	const menuGap = () => page.evaluate(() => document.querySelector(".att-card:has(.att-menu)")!.getBoundingClientRect().top - document.querySelector(".att-grid")!.getBoundingClientRect().top);
	await waitUntil(async () => (await menuGap()) >= -1, "the menu and its card show in full", 3_000).catch(async () => { throw new Error(`the menu's card starts ${await menuGap()}px under the cards' top edge`); });
	await page.keyboard.press("Escape");
	// A mac window that narrow: the sheet and the file keep their place over the backdrop.
	await page.evaluate(() => document.documentElement.classList.add("desktop-app-mac"));
	const macSheet = await page.evaluate(() => { const { position, zIndex } = getComputedStyle(document.querySelector(".attachments-panel")!); return { position, zIndex }; });
	assert(macSheet.position === "fixed" && macSheet.zIndex === "55", `a narrow mac window's sheet: ${JSON.stringify(macSheet)}`);
	await card("survey").locator(".att-open").click();
	await viewer.waitFor({ timeout: 5_000 });
	await waitUntil(async () => (await viewer.boundingBox())?.x === 0, "a narrow mac window's file fills the screen", 3_000);
	await viewer.getByRole("button", { name: "Back to Attachments" }).click();
	await panel.waitFor({ timeout: 5_000 });
	await page.evaluate(() => document.documentElement.classList.remove("desktop-app-mac"));
	await page.locator(".att-backdrop").click({ position: { x: 195, y: 20 } });
	await panel.waitFor({ state: "detached", timeout: 5_000 });
	ok(said, "on a phone the cards are a sheet from the bottom, two a row, Undo shows above it, a tapped file fills the screen, and the back arrow and the backdrop work");

	// The phone's empty words.
	await page.getByRole("button", { name: "Show sidebar" }).first().click();
	await page.locator(".sidebar-home-btn").click();
	await enter(PHONE_EMPTY_ROOM);
	await entry.click();
	await panel.waitFor({ timeout: 5_000 });
	assert((await panel.locator(".att-empty-line").innerText()) === PHONE_EMPTY_LINE, "the phone's empty line");
	ok(said, "a phone's empty sheet has its own line");
	assert(pageErrors.length === 0, `the page threw: ${pageErrors.join("; ")}`);
	for (const line of said) console.log(line);
	console.log("attachments-panel-ui-smoke: all checks passed");
} catch (caught) {
	error = caught;
	console.error(`attachments-panel-ui-smoke FAILED: ${(caught as Error).message}`);
	for (const line of said) console.error(line);
	process.exitCode = 1;
} finally {
	if (browser) await closeBrowser(browser).catch(() => {});
	await stopRoomStateServer(error);
}
