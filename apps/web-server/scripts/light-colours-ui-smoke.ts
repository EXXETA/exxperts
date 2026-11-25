// The order of light of every screen, read from the colours a person sees: the
// sidebar darkest, then the page, then the cards, the message box and the menus,
// lightest. Both themes have that one order, at desktop and phone width, on
// Home with its gear and sort menus, in a room with its Bash, model, meter, "/", "@"
// and file menus, Memory, a saved conversation in its panel and full screen,
// Wallet, the create-room window, a Memorize run, and every page of Settings
// and Room settings, scrolled where it scrolls, with the pages inside a page (a
// skill's, a connector's, and each form saved with its needed fields empty) and
// a room's refused name. Light's colours are named below and its pages and
// cards must match them; dark's are named too, so a change to light cannot move
// dark. In the settings windows the page, its title line and the phone's bar
// and list are one colour. What sits inside a card is a step darker than it in
// light: a field, a code block, a person's message. And no style file, nor the
// page's own frame, holds one of the creams light had before. Offline: a
// synthetic model answers "Noted.". Throwaway HOME.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, type Browser, type Page } from "playwright";
import { CONNECTOR_WORDS } from "../../web-ui/src/connector-rows.js";
import { OPEN_CONVERSATION_LABEL } from "../../web-ui/src/memory-surface-copy.js";
import { ADD_SKILL_WAYS } from "../../web-ui/src/skill-source-copy.js";
import { agentsRoot, baseUrl, openRoom, requestJson, RoomSocket, startRoomStateServer, stopRoomStateServer, tempHome } from "./room-state-setup.js";
import { answered, assert, closeWindow, DARK, desktop, goToPage, installColourTools, isPhone, LIGHT, lookPages, nearColour, pagesOf, phone, same, type Theme, type Window } from "./settings-look-smoke-parts.js";
import { closeBrowser, closeContext } from "./smoke-close-context.js";
import { waitEvery } from "./smoke-wait.js";

{
	const executable = typeof chromium?.executablePath === "function" ? chromium.executablePath() : "";
	if (!executable || !fs.existsSync(executable)) {
		console.log("light colours ui smoke skipped (Chromium not installed)");
		process.exit(0);
	}
}

const waitUntil = waitEvery(100);
const ROOM = "Harbour Desk";
const SAVED_TITLE = "Supplier call";
const OTHER_ROOM = "Price Desk";
const MESSAGE = "Show the stock.";

// What each theme draws; `box` is the message box. In dark a settings window is a card over the page's
// canvas, so its three steps sit one higher than the app's.
const APP = {
	[LIGHT]: { side: "#f3f0ea", page: "#faf8f4", card: "#ffffff", box: "#ffffff" },
	[DARK]: { side: "#1f1f1f", page: "#242424", card: "#2f2f2f", box: "#373737" },
};
const SETTINGS = {
	[LIGHT]: APP[LIGHT],
	[DARK]: { side: "#272727", page: "#2f2f2f", card: "#373737" },
};

const luminance = (hex: string) => [1, 3, 5].map((at) => parseInt(hex.slice(at, at + 2), 16)).reduce((sum, value, i) => sum + value * [0.2126, 0.7152, 0.0722][i], 0);

/** The colour a person sees on each visible element a selector names, as #rrggbb. */
async function fills(page: Page, selector: string): Promise<string[]> {
	return page.evaluate((query) => [...document.querySelectorAll(query)].filter((element) => {
		const box = element.getBoundingClientRect();
		return box.width > 0 && box.height > 0 && getComputedStyle(element).visibility !== "hidden";
	}).map((element) => (window as any).__fill(element)), selector);
}

async function oneFill(page: Page, selector: string, at: string): Promise<string> {
	const found = [...new Set(await fills(page, selector))];
	assert(found.length === 1, `${at}: ${selector} draws ${found.length === 0 ? "nothing" : found.join(" and ")}`);
	return found[0];
}

// What is out of order, one line each: a screen that fails does not hide the next.
const problems: string[] = [];
function note(check: () => void): void {
	try {
		check();
	} catch (error) {
		problems.push((error as Error).message.split("\n")[0]);
	}
}

/** A screen's parts by selector: its sidebar, its page, and what is lightest on it. */
interface Parts { side?: string; page?: string; cards: string[] }

// A card may be mixed a trace with the page, so cards are held to the order and
// to their own colour within the trace; sidebars and pages are exact.
const CARD_TRACE = 4;

async function checkOrder(page: Page, at: string, want: { side: string; page: string; card: string }, parts: Parts): Promise<void> {
	const pageFill = parts.page ? await oneFill(page, parts.page, at) : null;
	if (pageFill) note(() => nearColour(pageFill, want.page, `${at}: the page (${parts.page})`));
	if (parts.side) {
		const side = await oneFill(page, parts.side, at);
		note(() => nearColour(side, want.side, `${at}: the sidebar (${parts.side})`));
		if (pageFill) note(() => assert(luminance(side) < luminance(pageFill), `${at}: the sidebar ${side} is not darker than the page ${pageFill}`));
	}
	for (const selector of parts.cards) {
		const drawn = [...new Set(await fills(page, selector))];
		assert(drawn.length > 0, `${at}: ${selector} is not on screen`);
		for (const card of drawn) {
			note(() => assert(luminance(card) > luminance(pageFill ?? want.page), `${at}: ${selector} ${card} is not lighter than the page ${pageFill ?? want.page}`));
			const off = [1, 3, 5].map((i) => Math.abs(parseInt(card.slice(i, i + 2), 16) - parseInt(want.card.slice(i, i + 2), 16)));
			note(() => assert(off.every((step) => step <= CARD_TRACE), `${at}: ${selector}: got ${card}, expected ${want.card}`));
		}
	}
}

/** What sits inside a card, a step darker than it, in light. */
async function checkInside(page: Page, at: string, theme: Theme, selectors: string[]): Promise<void> {
	if (theme !== LIGHT) return;
	for (const selector of selectors) {
		const fill = await oneFill(page, selector, at);
		note(() => assert(luminance(fill) < luminance(APP[LIGHT].card), `${at}: ${selector} ${fill} is not darker than the white it lies on`));
	}
}

/** A menu is drawn white in light; in dark it keeps its own ground, which is not read here. */
async function checkMenu(page: Page, at: string, theme: Theme, selector: string): Promise<void> {
	await page.locator(selector).first().waitFor({ timeout: 10000 });
	const fill = await oneFill(page, selector, at);
	if (theme === LIGHT) note(() => nearColour(fill, APP[LIGHT].card, `${at} (${selector})`));
}

/** A list in the message box: its ground, and the row the keys are on and the one under the pointer a clear step off it. */
async function checkBoxList(page: Page, at: string, theme: Theme, typed: string, rows: number): Promise<void> {
	await page.locator(".composer-box textarea").first().fill(typed);
	await page.locator(".mention-row").first().waitFor({ timeout: 10000 });
	await checkMenu(page, at, theme, ".mention-pop");
	if (theme === DARK) return;
	const picked = page.locator(".mention-row.sel");
	await waitUntil(async () => await picked.count() === 1, `${at}: one row is picked`);
	const step = async (what: string) => {
		const fill = await oneFill(page, ".mention-row.sel", at);
		note(() => assert(luminance(APP[LIGHT].card) - luminance(fill) >= 15, `${at}: ${what} ${fill} is not a clear step darker than the white`));
	};
	await step("the picked row");
	assert(await page.locator(".mention-row").count() >= rows, `${at}: ${rows} rows or more`);
	await page.locator(".mention-row").last().hover();
	await waitUntil(async () => /\bsel\b/.test((await page.locator(".mention-row").last().getAttribute("class")) ?? ""), `${at}: the row under the pointer is picked`);
	await step("the row under the pointer");
}

async function openAt(page: Page, hash: string, ready: string): Promise<void> {
	await page.goto("about:blank");
	await page.goto(`${baseUrl}/${hash}`);
	await page.locator(ready).first().waitFor({ timeout: 15000 });
	await installColourTools(page);
}

const ACTIVE_PAGE = ".settings-dialog-pane";
const CARD_BOXES = ".settings-rows, .ai-profile-card, .room-skills-rows, .room-schedules-list, .room-schedules-run-list, .connector-list, .skill-table";
const PANE_FIELDS = `${ACTIVE_PAGE} :is(input:not([type="checkbox"], [type="radio"], [type="range"], [type="file"]), textarea)`;
const NEEDED_LINE = ".settings-needed-line";

/** Presses a page's one button by its words. */
const press = (page: Page, name: string) => page.locator(".settings-dialog").getByRole("button", { name, exact: true }).filter({ visible: true }).first().click();

const addSkill = (way: string) => async (page: Page) => {
	await press(page, "Add skill");
	await page.getByRole("menuitem", { name: way }).click();
};
const addConnector = (way: string) => async (page: Page) => {
	await page.locator(`${ACTIVE_PAGE} .connector-add-btn`).click();
	await page.getByRole("menuitem", { name: way }).click();
};

/** The pages inside a page: how each opens, what is drawn lightest on it, what on the page's own ground is a step
 * darker than it, and, for a form, the button that saves it with its needed fields empty. */
const SUB_PAGES: Array<{ name: string; which: Window; label: string; open: (page: Page) => Promise<void>; cards: string[]; darker?: string; save?: string }> = [
	{ name: "a skill's page", which: "settings", label: "Skills", open: (page) => page.locator(".skill-table .skill-row").first().click(), cards: [".skill-detail .settings-rows"] },
	{ name: "a skill by hand", which: "settings", label: "Skills", open: addSkill(ADD_SKILL_WAYS.write), cards: [PANE_FIELDS], save: "Save skill" },
	{ name: "a skill's repository", which: "settings", label: "Skills", open: addSkill(ADD_SKILL_WAYS.repository), cards: [PANE_FIELDS], save: "Scan" },
	{ name: "a connector's page", which: "settings", label: "Connectors", open: (page) => page.locator(".connector-item-hit").first().click(), cards: [".connector-page .connector-facts"], darker: ".connector-page .pane-head .connector-avatar" },
	{ name: "a connector by address", which: "settings", label: "Connectors", open: addConnector(CONNECTOR_WORDS.addWays.web), cards: [PANE_FIELDS], save: CONNECTOR_WORDS.form.add },
	{ name: "a connector as a program", which: "settings", label: "Connectors", open: addConnector(CONNECTOR_WORDS.addWays.program), cards: [PANE_FIELDS], save: CONNECTOR_WORDS.form.add },
	{ name: "a new task", which: "room", label: "Scheduled tasks", open: (page) => press(page, "New task"), cards: [PANE_FIELDS], save: "Save task" },
];

/** Scrolls a page by a little; whether it scrolls at all. */
const scrollPage = (page: Page) => page.evaluate((pane) => {
	const scrollers = [...document.querySelectorAll(`${pane}, ${pane} *`)].filter((one) => one.scrollHeight > one.clientHeight + 40 && /auto|scroll/.test(getComputedStyle(one).overflowY) && !one.matches("textarea"));
	for (const one of scrollers) one.scrollTop = 120;
	return scrollers.length > 0;
}, ACTIVE_PAGE);

/** A page's ground and its title line, or the phone's bar, at its top and, where it scrolls, over the words that went
 * under it, where the title line must be opaque. Answers whether the page scrolls. */
async function checkGround(page: Page, at: string, pageColour: string): Promise<boolean> {
	const line = isPhone(page) ? ".settings-dialog-bar" : `${ACTIVE_PAGE} .pane-head`;
	const read = async (what: string) => {
		for (const selector of [ACTIVE_PAGE, line]) {
			const found = await fills(page, selector);
			assert(found.length > 0, `${what}: ${selector} is not on screen`);
			for (const fill of found) note(() => nearColour(fill, pageColour, `${what}: ${selector}, the page's colour`));
		}
	};
	await read(at);
	if (!await scrollPage(page)) return false;
	await read(`${at}, scrolled`);
	const opaque = await page.locator(line).filter({ visible: true }).first().evaluate((element) => (window as any).__painted(getComputedStyle(element).backgroundColor));
	note(() => assert(opaque, `${at}, scrolled: ${line} paints no ground of its own`));
	return true;
}

/** The pages inside a page of both windows, each opened from its own list. */
async function checkSubPages(page: Page, at: string, theme: Theme, want: { side: string; page: string; card: string }, openWindow: (page: Page, which: Window) => Promise<void>): Promise<void> {
	for (const sub of SUB_PAGES) {
		const where = `${at}, ${sub.name}`;
		await openWindow(page, sub.which);
		await goToPage(page, sub.label);
		await answered(page, where);
		await sub.open(page);
		if (sub.which === "settings") await page.locator(`${ACTIVE_PAGE} .pane-head-back`).filter({ visible: true }).waitFor({ timeout: 10000 });
		await page.locator(sub.cards[0]).filter({ visible: true }).first().waitFor({ timeout: 10000 });
		await answered(page, where);
		const groundAt = async (what: string) => {
			await checkOrder(page, what, want, { side: isPhone(page) ? undefined : ".settings-dialog-side", page: ACTIVE_PAGE, cards: sub.cards });
			if (sub.darker) {
				const fill = await oneFill(page, sub.darker, what);
				const pageFill = await oneFill(page, ACTIVE_PAGE, what);
				if (theme === LIGHT) note(() => assert(luminance(fill) < luminance(pageFill), `${what}: ${sub.darker} ${fill} is not darker than the page ${pageFill}`));
			}
		};
		await groundAt(where);
		if (sub.save) {
			await press(page, sub.save);
			await page.locator(NEEDED_LINE).filter({ visible: true }).first().waitFor({ timeout: 10000 });
			const what = `${where}, a needed field left empty`;
			await groundAt(what);
			// The line under the field stands on the page and reads on it.
			const lines = await page.locator(NEEDED_LINE).filter({ visible: true }).evaluateAll((all) => all.map((one) => ({ fill: (window as any).__fill(one) as string, contrast: (window as any).__contrast(one) as number })));
			for (const line of lines) {
				note(() => nearColour(line.fill, want.page, `${what}: ${NEEDED_LINE}`));
				note(() => assert(line.contrast >= 4.5, `${what}: ${NEEDED_LINE} stands ${line.contrast.toFixed(2)} to 1 on its ground, under 4.5`));
			}
		}
		await checkGround(page, where, want.page);
		await closeWindow(page);
	}
}

/** A room's name refused: the reason under its field, on the sidebar's own colour (on a phone the page's), read on it. */
async function checkRefusedName(page: Page, at: string, want: { side: string; page: string }, openWindow: (page: Page, which: Window) => Promise<void>): Promise<void> {
	await openWindow(page, "room");
	await page.locator(".settings-dialog-title").click();
	await page.locator(".room-settings-rename-input").fill(OTHER_ROOM);
	await page.locator(".room-settings-rename-form").getByRole("button", { name: "Save", exact: true }).click();
	const refused = page.locator(".settings-dialog-head-note > .workspaces-error");
	await refused.waitFor({ timeout: 10000 });
	const line = await refused.evaluate((element) => ({ fill: (window as any).__fill(element) as string, contrast: (window as any).__contrast(element) as number }));
	note(() => nearColour(line.fill, isPhone(page) ? want.page : want.side, `${at}, a refused room name: its reason`));
	note(() => assert(line.contrast >= 4.5, `${at}, a refused room name: its reason stands ${line.contrast.toFixed(2)} to 1 on its ground, under 4.5`));
}

async function checkSettingsWindows(browser: Browser, theme: Theme, width: "desktop" | "phone"): Promise<void> {
	const { openPage, openWindow } = lookPages({ baseUrl, room: ROOM });
	const page = await openPage(browser, width === "desktop" ? desktop(1440, 900, theme) : phone(theme), "on");
	await installColourTools(page);
	const want = SETTINGS[theme];
	let cards = 0;
	let scrolled = 0;
	for (const which of ["settings", "room"] as const) {
		await openWindow(page, which);
		const list = `${theme}, ${width}, ${which}`;
		if (isPhone(page)) {
			// The list of pages and the window itself are the page's colour on a phone.
			for (const selector of [".settings-dialog", ".settings-dialog-side"]) { const fill = await oneFill(page, selector, list); note(() => nearColour(fill, want.page, `${list}, the list: ${selector}`)); }
		}
		for (const label of pagesOf(which)) {
			await goToPage(page, label);
			const at = `${list}, ${label}`;
			// The page has filled in: whether it scrolls is read below.
			await answered(page, at);
			const parts: Parts = { side: isPhone(page) ? undefined : ".settings-dialog-side", page: ACTIVE_PAGE, cards: [] };
			const boxes = await fills(page, CARD_BOXES);
			// Boxes hold no empty list, so some pages have none.
			if (boxes.length > 0) { parts.cards.push(CARD_BOXES); cards += boxes.length; }
			await checkOrder(page, at, want, parts);
			if (await checkGround(page, at, want.page)) scrolled += 1;
		}
		await closeWindow(page);
	}
	await checkSubPages(page, `${theme}, ${width}`, theme, want, openWindow);
	await checkRefusedName(page, `${theme}, ${width}`, want, openWindow);
	assert(scrolled >= 2, `${theme}, ${width}: only ${scrolled} pages scrolled`);
	assert(cards >= 12, `${theme}, ${width}: only ${cards} cards were read in the settings windows`);
	await closeContext(page.context());
}

async function checkAppScreens(browser: Browser, theme: Theme, width: "desktop" | "phone", roomId: string): Promise<void> {
	const { openPage } = lookPages({ baseUrl, room: ROOM });
	const page = await openPage(browser, width === "desktop" ? desktop(1440, 900, theme) : phone(theme), "on");
	await installColourTools(page);
	const want = APP[theme];
	const at = (screen: string) => `${theme}, ${width}, ${screen}`;
	// On a phone the product's sidebar is the bar along the top, and a room's is a drawer.
	const side = ".product-sidebar";

	await openAt(page, "#/", ".persistent-agent-card");
	await checkOrder(page, at("Home"), want, { side, page: ".landing-shell", cards: [".persistent-agent-card"] });
	await page.locator(".sidebar-config-gear:visible").first().click();
	await page.locator(".sidebar-config-menu").waitFor({ timeout: 10000 });
	await checkOrder(page, at("the gear's menu"), want, { cards: [".sidebar-config-menu"] });

	await openAt(page, "#/", ".persistent-agent-card");
	await page.locator(".room-sort-btn").first().click();
	await checkMenu(page, at("the sort menu"), theme, ".room-sort-menu");

	await openAt(page, "#/", ".persistent-agent-card");
	await page.getByRole("button", { name: "Create a new room" }).first().click();
	await page.locator(".create-room-form").waitFor({ timeout: 10000 });
	await checkOrder(page, at("the create-room window"), want, { cards: [".create-room-modal"] });
	await checkInside(page, at("the create-room window"), theme, [".create-room-input"]);

	await openAt(page, "#/memory", ".mem-card");
	await checkOrder(page, at("Memory"), want, { side, page: ".landing-shell", cards: [".mem-glance", ".mem-card"] });
	await page.locator(".mem-digest").waitFor({ timeout: 10000 });
	await checkOrder(page, at("Memory, since you were last here"), want, { page: ".landing-shell", cards: theme === LIGHT ? [".mem-digest"] : [] });
	await page.locator(".mem-card").filter({ hasText: ROOM }).click();
	await page.getByRole("button", { name: "Details" }).first().click();
	await page.getByRole("button", { name: OPEN_CONVERSATION_LABEL }).first().click();
	await page.locator(".mem-tr-text").first().waitFor({ timeout: 10000 });
	await checkOrder(page, at("a saved conversation"), want, { page: ".landing-shell", cards: [".mem-reading-block"] });
	await checkInside(page, at("a saved conversation"), theme, [".mem-tr-text"]);
	await page.getByRole("button", { name: /Full screen/ }).first().click();
	await page.locator(".mem-fullscreen").waitFor({ timeout: 10000 });
	await checkOrder(page, at("a saved conversation, full screen"), want, { page: ".mem-fullscreen", cards: [".mem-fullscreen-inner"] });

	await openAt(page, "#/dashboard", ".kpi");
	await checkOrder(page, at("Wallet"), want, { side, page: ".landing-shell", cards: [".kpi", ".chart-block"] });

	await openAt(page, `#/maintain/${roomId}`, ".maintain-action");
	await checkOrder(page, at("Maintain"), want, { side, page: ".maintain-workspace", cards: [".maintain-actions"] });
	await page.locator(".maintain-action").filter({ hasText: "Memorize" }).first().click();
	await page.getByRole("button", { name: /Continue/ }).first().waitFor({ timeout: 30000 });
	await checkOrder(page, at("a Memorize run"), want, { page: ".absorb-workspace", cards: [".absorb-workspace-header"] });

	await openAt(page, "#/", ".persistent-agent-card");
	await page.locator(".persistent-agent-card").filter({ hasText: ROOM }).getByRole("button", { name: /Resume|Enter/ }).first().click();
	await page.locator(".composer-box").first().waitFor({ timeout: 15000 });
	await page.locator(".bubble.user").first().waitFor({ timeout: 15000 });
	await installColourTools(page);
	await checkOrder(page, at("a room"), { ...want, card: want.box }, { side: width === "desktop" ? ".sidebar" : undefined, page: ".messages", cards: [".composer-box"] });
	const bubble = await oneFill(page, ".bubble.user", at("a room"));
	if (theme === LIGHT) note(() => assert(luminance(bubble) < luminance(want.page), `${at("a room")}: a person's message ${bubble} is not darker than the page`));
	if (width === "phone") {
		await page.locator(".sidebar-toggle:visible").first().click();
		await waitUntil(async () => (await fills(page, ".sidebar")).length === 1, "the drawer is open");
		await checkOrder(page, at("a room's drawer"), want, { side: ".sidebar", cards: [] });
	}
	await checkRoomMenus(page, at, theme, width);
	await closeContext(page.context());
}

/** A room's menus and lists, at desktop width: the Bash chip's, the model's, the meter's, the "/" and "@" lists and a file's menu. */
async function checkRoomMenus(page: Page, at: (screen: string) => string, theme: Theme, width: "desktop" | "phone"): Promise<void> {
	if (width === "phone") return;
	await page.locator(".bash-mode-chip").click();
	await checkMenu(page, at("the Bash menu"), theme, ".bash-mode-menu");
	await page.keyboard.press("Escape");
	await page.locator(".model-pick-trigger").first().click();
	await checkMenu(page, at("the model menu"), theme, ".model-pick-panel");
	await page.keyboard.press("Escape");
	await page.locator(".composer-context-pill").first().click();
	await checkMenu(page, at("the meter's panel"), theme, ".composer-context-popover");
	if (theme === LIGHT) {
		const worst = await page.evaluate(() => Math.min(...[".composer-context-popover-row strong", ".composer-context-popover-note", ".composer-context-popover-lead"].flatMap((selector) => [...document.querySelectorAll(selector)]).map((element) => (window as any).__contrast(element))));
		note(() => assert(worst >= 4.5, `${at("the meter's panel")}: its words stand ${worst.toFixed(2)} to 1 on it, under 4.5`));
		const ring = await page.evaluate(() => {
			const pill = document.querySelector(".composer-context-pill")!;
			return [".context-ring-track", ".context-ring-fill"].map((selector) => {
				const mark = pill.querySelector(selector);
				return mark ? (window as any).__seen(pill, getComputedStyle(mark).stroke) === (window as any).__fill(pill) ? "unseen" : "seen" : "none";
			});
		});
		note(() => assert(ring[0] === "seen", `${at("the meter's panel")}: the ring's track is not drawn off its ground`));
	}
	await page.keyboard.press("Escape");
	await checkBoxList(page, at('the "/" list'), theme, "/", 2);
	await checkBoxList(page, at('the "@" list'), theme, "@", 1);
	await page.locator(".composer-box textarea").first().fill("");
	await page.locator(".attachments-entry").first().click();
	await page.locator(".att-card").first().waitFor({ timeout: 10000 });
	await page.locator(".att-more").first().click();
	await checkMenu(page, at("a file's menu"), theme, ".att-menu");
}

/** The creams light had, in the page's own style files and frame. The hosted page carries its own copy, checked with it. */
function checkNoCreamLeft(): void {
	const webUi = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "web-ui");
	const creams = /#(?:fffaf2|f7f3ec|f8f5ef|ebe6dc|e7e0d5|ded8cf|e4ded5)\b/i;
	const found: string[] = [];
	const read = (dir: string) => {
		for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
			const file = path.join(dir, entry.name);
			if (entry.isDirectory()) { if (!["hosted", "node_modules", "dist", "dist-hosted"].includes(entry.name)) read(file); }
			else if (/\.(css|tsx?|html|json|webmanifest|svg)$/.test(entry.name)) {
				const hit = creams.exec(fs.readFileSync(file, "utf-8"));
				if (hit) found.push(`${path.relative(webUi, file)}: ${hit[0]}`);
			}
		}
	};
	read(webUi);
	same(found, [], "the old cream in the page's files");
	console.log("  ok  no file of the page holds a cream light had before");
}

/** A remembered conversation in the room's memory, with the stored conversation it was saved from. */
function saveConversation(roomId: string): void {
	const conversationId = "saved_supplier_call";
	const threads = path.join(agentsRoot, roomId, "runtime", "threads");
	fs.mkdirSync(threads, { recursive: true });
	fs.writeFileSync(path.join(threads, `${conversationId}.json`), JSON.stringify({ schemaVersion: 1, threadId: conversationId, state: "closed", closedAt: Date.now(), items: [{ kind: "user", id: "u1", text: "What did the supplier say?" }, { kind: "assistant", id: "a1", text: "The tea arrives on Friday." }] }));
	const l1b = path.join(agentsRoot, roomId, "L1b", "current.md");
	const scaffold = fs.readFileSync(l1b, "utf-8");
	const recent = /^##\s+Recent Context\s*$/m.exec(scaffold);
	assert(recent, "the scaffold has a Recent Context section");
	const savedAt = new Date(Date.now() - 3600_000).toISOString();
	const checkpointId = "saved-call-1";
	const entry = `### RC-0001 | CLOSED | ${savedAt.slice(0, 10)} | ${SAVED_TITLE}\n\n<!-- rc_metadata: checkpoint_id=${checkpointId}; session_id=s1; conversation_id=${conversationId}; density=normal; model=openai-compatible/room-model; approved_at=${savedAt} -->\n\n**Session arc:** The supplier called.\n\n**Body:**\n- The tea arrives on Friday.\n\n**Parked:**\nNone\n`;
	fs.writeFileSync(l1b, `${scaffold.slice(0, recent.index + recent[0].length)}\n\n${entry}`, "utf-8");
	const saves = path.join(agentsRoot, roomId, "events", "checkpoint");
	fs.mkdirSync(saves, { recursive: true });
	fs.writeFileSync(path.join(saves, `${checkpointId}.json`), JSON.stringify({ schemaVersion: 1, operation: "checkpoint", agentId: roomId, checkpointId, approvedAt: savedAt, checkpoint: { approvedEntry: { title: SAVED_TITLE, chars: 120 } }, runtimeBoundary: { closedThreadId: conversationId, closedAt: Date.now() }, result: { estimatedTokens: 100 } }));
}

let failure: unknown;
try {
	await startRoomStateServer();
	const { roomId, conversationId } = await openRoom(ROOM);
	await openRoom(OTHER_ROOM);
	const socket = await RoomSocket.connect(roomId, conversationId);
	await socket.prompt(MESSAGE);
	await socket.close();
	saveConversation(roomId);
	const seed = async (method: "POST" | "PUT", route: string, body: unknown) => {
		const answer = await requestJson(route, { method, body: JSON.stringify(body) });
		assert(answer.status < 300, `seeding ${route}: ${answer.status} ${JSON.stringify(answer.body).slice(0, 300)}`);
	};
	const project = path.join(tempHome, "Documents", "Price Check");
	fs.mkdirSync(project, { recursive: true });
	await seed("POST", `/api/persistent-agents/${roomId}/memory/entries`, { topic: "General", kind: "fact", text: "Reports go out on Fridays.", newTopic: true });
	await seed("PUT", `/api/persistent-agents/${roomId}/workspace-default`, { root: project, workspaceAccessMode: "localFiles", bashEnabled: true });
	await seed("POST", `/api/persistent-agents/${roomId}/schedules`, { name: "Weekly summary", type: "once", schedule: "+30m", prompt: "Write the weekly summary.", enabled: true });
	await seed("POST", "/api/skills", { id: "plain-words", displayName: "plain-words", description: "Answers plainly.", instructions: "Answer plainly." });
	await seed("PUT", `/api/persistent-agents/${roomId}/skill-settings`, { action: "enable", name: "plain-words" });
	await seed("POST", "/api/skills", { id: "short-lists", displayName: "short-lists", description: "Short lists.", instructions: "Answer in short lists." });
	await seed("PUT", `/api/persistent-agents/${roomId}/skill-settings`, { action: "enable", name: "short-lists" });
	await seed("POST", `/api/persistent-agents/${roomId}/files`, { filename: "tide-notes.md", contentBase64: Buffer.from("# Tide notes\n").toString("base64") });
	await seed("POST", "/api/mcp/servers", { name: "notes-server", url: "http://127.0.0.1:9/mcp" });
	await seed("PUT", `/api/persistent-agents/${roomId}/mcp-connectors`, { action: "grant", name: "notes-server" });
	const browser = await chromium.launch();
	note(checkNoCreamLeft);
	try {
		for (const theme of [DARK, LIGHT] as const) {
			for (const width of ["desktop", "phone"] as const) {
				const before = problems.length;
				await checkSettingsWindows(browser, theme, width);
				await checkAppScreens(browser, theme, width, roomId);
				console.log(`  ${problems.length === before ? "ok " : "RED"} ${theme}, ${width}: the settings windows and the app's screens`);
			}
		}
	} finally {
		await closeBrowser(browser);
	}
	assert(problems.length === 0, `colours out of order:\n${problems.join("\n")}`);
	console.log("light colours ui smoke passed");
} catch (error) {
	failure = error;
} finally {
	await stopRoomStateServer(failure);
}
if (failure) {
	console.error(failure instanceof Error ? failure.message : failure);
	process.exit(1);
}
