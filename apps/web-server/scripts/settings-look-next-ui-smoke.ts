// The settings windows' new look and its switch: with nothing set both windows
// open in the new look, at desktop and phone width (also when the browser's
// storage cannot be read); with the key naming the old look both keep the old
// markup; and every rule of the new style file sits under the switch's class.
// With it on, in the browser: the window, its sidebar and
// content column at 1440, 1024, 800 and 390 px with nothing scrolling
// sideways; the sidebar's sizes, states and groups; on all 17 pages a title
// line that stays put with its hairline once scrolled, one close button and a
// jump to a row that stops below the header; cards, form rows, section titles
// and the switch; the phone's one bar; the contrast of what the look colours,
// in both themes; the class names other checks read, on the same elements
// with the switch on and off; the controls in the look (fields, the search
// field and the long text box, the segmented choice, radios, the slider, a
// menu, the question a window asks and the info mark), each with its states,
// keys and name; and outside the two windows nothing changing with the switch
// on: the gear's menu, Create a room, Maintain, Review's choice of how much to
// tidy, a Maintain question, the Bash chip's menu and its question.
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, type Browser, type Page } from "playwright";
import { authedFetch, SMOKE_SERVER_AUTH_ENV, SMOKE_SERVER_SPAWN_TREE_OPTIONS, smokeHomeEnv, stopSmokeServer, freePort, waitForServer } from "./smoke-server-process.js";
import { waitEvery } from "./smoke-wait.js";
import { SETTINGS_LOOK_KEY, SETTINGS_LOOK_OLD } from "../../web-ui/src/settings-look.js";
import { MODE_NAMES } from "../src/room-box/card-text.js";
import { answered, assert, closeWindow, contrast, DARK, desktop, goToPage, installColourTools, installReach, isPhone, LIGHT, LOOK_FILE, lookPages, navItem, nearColour, notLookPageFilesAfterLook, pagesOf, phone, requestsFromNow, ROOM_ORDER, rulesOutsideRoots, same, SETTINGS_ORDER, SWITCH_CLASS, type Theme, type Window as LookWindow } from "./settings-look-smoke-parts.js";

const waitUntil = waitEvery(100);

{
	const p = typeof chromium?.executablePath === "function" ? chromium.executablePath() : "";
	if (!p || !fs.existsSync(p)) {
		console.log("settings look next ui smoke skipped (Chromium not installed)");
		process.exit(0);
	}
}

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const webServerDir = path.resolve(scriptDir, "..");
const repoRoot = path.resolve(webServerDir, "..", "..");
const stylesDir = path.join(repoRoot, "apps", "web-ui", "src", "styles");
const port = await freePort();
const baseUrl = `http://127.0.0.1:${port}`;

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "exxperts-settings-look-next-"));
const tempHome = path.join(tempRoot, "home");
const agentsRoot = path.join(tempHome, ".exxperts", "app", "personalized-agents");
const agentDir = path.join(tempHome, ".exxperts", "agent");
for (const dir of [agentsRoot, agentDir]) fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
process.env.HOME = tempHome;
process.env.USERPROFILE = tempHome;
process.env.EXXPERTS_CODING_AGENT_DIR = agentDir;
process.env.EXXETA_PERSISTENT_AGENTS_ROOT = agentsRoot;

const ROOM = "Look Room";
// A room with a folder and commands on, for the Bash chip outside the windows.
const DESK_ROOM = "Desk Room";
const BOX = ".settings-rows, .ai-profile-card, .room-skills-rows, .room-schedules-list, .room-schedules-run-list, .connector-list, .skill-table";
// The class names a hosted check and the desktop checks read: on the same elements with the look on and off.
const KEPT_CLASSES = ["settings-rows", "settings-row", "settings-row-label", "settings-row-sub", "settings-row-choice", "workspaces-tool-switch", "settings-dialog-nav", "settings-overlay", "pane-head", "pane-head-actions", "settings-group-kicker"];
const { openPage, openWindow, everyPage } = lookPages({ baseUrl, room: ROOM });

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

// --- With the switch off ---------------------------------------------------

/** Today's shape of the shell and of every page header, as the code on main renders it. */
async function readOffShape(page: Page) {
	return page.evaluate(() => {
		const dialog = document.querySelector(".settings-dialog")!;
		const pane = dialog.querySelector(".settings-dialog-pane")!;
		return {
			lookClass: document.querySelectorAll(".settings-look-next").length,
			dialogChildren: [...dialog.children].map((child) => `${child.tagName.toLowerCase()}.${child.className}`),
			headFirst: dialog.querySelector(".settings-dialog-head")?.parentElement === dialog,
			back: pane.firstElementChild?.matches("button.settings-dialog-back") ? pane.firstElementChild.textContent : null,
			newParts: dialog.querySelectorAll(".settings-dialog-bar, .settings-dialog-side, .pane-top, .pane-lead").length,
			// Each header holds its text block, with the title and its line, and its actions after it.
			heads: [...pane.querySelectorAll(".pane-head")].every((head) => head.firstElementChild?.matches(".pane-head-text") && head.querySelector(":scope > .pane-head-text > h2")),
			closes: dialog.querySelectorAll(".settings-dialog-close").length,
		};
	});
}

async function checkOff(browser: Browser): Promise<void> {
	for (const [where, options] of [["desktop", desktop(1280)], ["phone", phone()]] as const) {
		const page = await openPage(browser, options, "off");
		await everyPage(page, async (which, label) => {
			const shape = await readOffShape(page);
			const at = `${where}, switch off, ${which} ${label}`;
			same(shape.lookClass, 0, `${at}: elements with the new look's class`);
			same(shape.dialogChildren, ["header.settings-dialog-head", "div.settings-dialog-body"], `${at}: the window's parts`);
			same(shape.back, "← All settings", `${at}: the way back to the list sits first in the pane`);
			same(shape.newParts, 0, `${at}: the new look's parts`);
			assert(shape.heads, `${at}: a page header holds its title and line together`);
			same(shape.closes, 1, `${at}: close buttons`);
		});
		await page.context().close();
	}
	console.log("  ok  switch off: both windows keep the old shell and headers on every page, at desktop and phone width");
}

/** Whether each window opens in the new look. */
async function lookOfWindows(page: Page): Promise<Record<LookWindow, boolean>> {
	const seen = {} as Record<LookWindow, boolean>;
	for (const which of ["settings", "room"] as const) {
		await openWindow(page, which);
		seen[which] = await page.locator(SWITCH_CLASS).count() === 1;
		await closeWindow(page);
	}
	return seen;
}

// A person who has set nothing gets the new look in both windows, at desktop and phone width; so does a key left at
// "next", one with a value that names no look, and storage that can't be read. Only the old look's value turns it back.
async function checkDefault(browser: Browser): Promise<void> {
	for (const [where, options, look, value, on] of [
		["desktop, nothing set", desktop(1280), "on", null, true],
		["phone, nothing set", phone(), "on", null, true],
		["desktop, the key left at next", desktop(1280), "on", "next", true],
		["desktop, the key set to another value", desktop(1280), "on", "on", true],
		["desktop, storage unreadable", desktop(1280), "unreadable", null, true],
		["desktop, the old look's value", desktop(1280), "off", SETTINGS_LOOK_OLD, false],
		["phone, the old look's value", phone(), "off", SETTINGS_LOOK_OLD, false],
	] as const) {
		const page = await openPage(browser, options, look);
		if (look === "on" && value !== null) await page.evaluate(([key, set]) => localStorage.setItem(key, set), [SETTINGS_LOOK_KEY, value]);
		if (look !== "unreadable") same(await page.evaluate((key) => localStorage.getItem(key), SETTINGS_LOOK_KEY), value, `${where}: the key`);
		same(await lookOfWindows(page), { settings: on, room: on }, `${where}: Settings and Room settings in the new look`);
		await page.context().close();
	}
	console.log("  ok  with nothing set both windows open in the new look, at desktop and phone width, as with the key left at next, another value or unreadable storage; the old look's value turns both back");
}

/** Where a rule may start: the window with the switch's class, and the two parts drawn outside it that take the look from
 * it, the question (confirm-dialog.tsx gives its backdrop the class) and the menu on <body> while such a window shows. */
const LOOK_ROOTS = [SWITCH_CLASS, ".confirm-dialog-backdrop.settings-look-next", `body:has(${SWITCH_CLASS}) > .ai-profile-menu`];

async function checkRulesUnderSwitch(browser: Browser): Promise<void> {
	const page = await openPage(browser, desktop(1280), "off");
	const css = fs.readFileSync(path.join(stylesDir, LOOK_FILE), "utf8");
	same(await rulesOutsideRoots(page, css, LOOK_ROOTS), [], `rules in ${LOOK_FILE} outside ${SWITCH_CLASS}`);
	// The check itself: a rule outside the class is found, in a media query too, and a longer class name is not the class.
	same(await rulesOutsideRoots(page, `.settings-dialog .pane-head { color: red; } @media (max-width: 760px) { ${SWITCH_CLASS} .x, .y { color: red; } } ${SWITCH_CLASS}-more .z { color: red; } :root { --a: 1; } .confirm-dialog-backdrop .q { color: red; } body > .ai-profile-menu { color: red; } body:has(${SWITCH_CLASS}) > .ai-profile-menu-more { color: red; }`, LOOK_ROOTS), [".settings-dialog .pane-head", ".y", `${SWITCH_CLASS}-more .z`, ":root", ".confirm-dialog-backdrop .q", "body > .ai-profile-menu", `body:has(${SWITCH_CLASS}) > .ai-profile-menu-more`], "the check's own probe");
	// The page loads the file after every other but the look's own page files.
	const imports = [...fs.readFileSync(path.join(repoRoot, "apps", "web-ui", "src", "styles.css"), "utf8").matchAll(/@import "\.\/styles\/([^"]+)";/g)].map((match) => match[1]);
	same(notLookPageFilesAfterLook(imports), [], `the style files the page loads after ${LOOK_FILE} that are not the look's page files`);
	same(notLookPageFilesAfterLook([LOOK_FILE, "45-settings-look-room-pages.css", "45-room-pages.css", "46-settings-look-.css"]), ["45-room-pages.css", "46-settings-look-.css"], "the order check's own probe");
	const loaded = await page.evaluate((prefix) => [...document.styleSheets].some((sheet) => [...sheet.cssRules].some((rule) => rule instanceof CSSStyleRule && rule.selectorText.startsWith(prefix))), SWITCH_CLASS);
	assert(loaded, "the page's stylesheet carries the new look's rules");
	await page.context().close();
	console.log(`  ok  every rule of ${LOOK_FILE} sits under ${SWITCH_CLASS}, or on the question or the menu a window in the look shows, and the page loads it last but for the look's page files`);
}

// --- With the switch on ------------------------------------------------------

/** The window's frame and whether anything scrolls sideways. */
async function readFrame(page: Page) {
	return page.evaluate(() => {
		const box = (selector: string) => { const element = document.querySelector(selector); if (!element || !element.getClientRects().length) return null; const { left, top, width, height } = element.getBoundingClientRect(); return { left, top, width, height }; };
		const pane = document.querySelector(".settings-dialog-pane")!;
		const style = getComputedStyle(pane);
		return {
			dialog: box(".settings-dialog")!,
			side: box(".settings-dialog-side"),
			head: box(".settings-dialog-head"),
			title: document.querySelector(".settings-dialog-head")?.textContent?.trim() ?? "",
			// The name a screen reader gives the window: what its aria-labelledby points at, the hidden "Room settings" included.
			spoken: (document.querySelector(".settings-dialog")!.getAttribute("aria-labelledby") ?? "").split(" ").filter(Boolean).map((id) => document.getElementById(id)?.textContent?.trim() ?? "").join(" "),
			column: pane.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight),
			paneSideways: pane.scrollWidth - pane.clientWidth,
			pageSideways: document.documentElement.scrollWidth - window.innerWidth,
		};
	});
}

async function checkFrame(browser: Browser): Promise<void> {
	for (const [width, height, sideWidth] of [[1440, 900, 240], [1024, 768, 240], [800, 700, 200], [390, 844, 0]] as const) {
		const page = await openPage(browser, width === 390 ? phone() : desktop(width, height), "on");
		await everyPage(page, async (which, label) => {
			const at = `${width} px, ${which} ${label}`;
			await answered(page, at);
			const frame = await readFrame(page);
			assert(frame.paneSideways <= 0 && frame.pageSideways <= 0, `${at}: something scrolls sideways (pane ${frame.paneSideways}, page ${frame.pageSideways})`);
			if (width === 390) {
				same([frame.dialog.width, frame.dialog.height], [390, 844], `${at}: the window fills the screen`);
				return;
			}
			assert(frame.dialog.width <= 1040 && frame.dialog.height <= 800, `${at}: the window is ${frame.dialog.width} by ${frame.dialog.height}`);
			same([frame.dialog.width, frame.dialog.height], [Math.min(1040, width - 48), Math.min(800, height - 72)], `${at}: the window's size, 36 clear above and below as today`);
			same(frame.side?.width, sideWidth, `${at}: the sidebar's width`);
			assert(frame.head && frame.side && frame.head.top === frame.side.top, `${at}: the window's name heads the sidebar`);
			if (which === "settings") same(frame.title, "Settings.", `${at}: the window's name`);
			// No small "Room settings" line above the room's name; the window keeps it as its name for a screen reader.
			else assert(!frame.title.includes("Room settings") && frame.title.startsWith(ROOM) && frame.spoken.startsWith("Room settings") && frame.spoken.includes(ROOM), `${at}: the room's window is named for the room, got "${frame.title}", spoken "${frame.spoken}"`);
			assert(frame.column <= 720 && frame.column >= 480, `${at}: the content column is ${frame.column} px`);
		});
		await page.context().close();
	}
	console.log("  ok  the window at 1440, 1024, 800 and 390: at most 1040 by 800, the sidebar 240 (200 at 800) under the window's name, the column at most 720, nothing sideways on any of the 17 pages");
}

/** How far the pencil's middle is from the middle of the room's name's first line. */
const pencilOffLine = (page: Page) => page.evaluate(() => {
	const words = document.createRange();
	words.selectNodeContents(document.querySelector(".settings-dialog-title")!);
	const middle = (box: DOMRect) => (box.top + box.bottom) / 2;
	return Math.round(middle(document.querySelector(".settings-dialog-title-action")!.getBoundingClientRect()) - middle(words.getClientRects()[0]));
});

async function checkSidebar(browser: Browser): Promise<void> {
	// The specification's fills on the sidebar: hover, and pressed or chosen.
	const fills = { [LIGHT]: { hover: "#eae7e2", on: "#e4e1db" }, [DARK]: { hover: "#313131", on: "#393939" } };
	for (const theme of [LIGHT, DARK] as const) {
		const page = await openPage(browser, desktop(1440, 900, theme), "on");
		await installColourTools(page);
		const firstTops: number[] = [];
		for (const which of ["settings", "room"] as const) {
			await openWindow(page, which);
			const at = `${theme}, ${which}`;
			const items = await page.locator(".settings-dialog-nav-item").evaluateAll((all) => all.map((item) => {
				const box = item.getBoundingClientRect();
				const style = getComputedStyle(item);
				return { label: item.textContent!.trim(), top: box.top, bottom: box.bottom, height: box.height, weight: style.fontWeight, colour: style.color, chosen: item.classList.contains("active"), fill: (window as any).__fill(item) };
			}));
			same(items.map((item) => item.label), which === "settings" ? SETTINGS_ORDER : ROOM_ORDER, `${at}: the pages' order`);
			same([...new Set(items.map((item) => item.height))], [32], `${at}: item heights`);
			firstTops.push(items[0].top);
			if (which === "room") {
				same(firstTops[1], firstTops[0], `${at}: the list starts where Settings' does`);
				same(await pencilOffLine(page), 0, `${at}: the pencil on the name's first line`);
			}
			const chosen = items.filter((item) => item.chosen);
			same(chosen.map((item) => item.weight), ["500"], `${at}: the chosen item's weight`);
			nearColour(chosen[0].fill, fills[theme].on, `${at}: the chosen item's fill`);
			same([...new Set(items.filter((item) => !item.chosen).map((item) => item.weight))], ["400"], `${at}: the other items' weight`);
			if (which === "settings") {
				const gaps = items.slice(1).map((item, i) => [item.label, Math.round(item.top - items[i].bottom)]);
				// One even list: no gap between groups of pages.
				same(gaps, gaps.map(([label]) => [label, 2]), `${at}: the space before each item`);
			} else {
				const rest = items.find((item) => !item.chosen && item.label !== "Archive or delete")!;
				same(items.at(-1)!.colour, rest.colour, `${at}: Archive or delete in the ordinary colour`);
			}
			// Hover, pressed and keyboard focus, on an item that is not the chosen one.
			const other = navItem(page, which === "settings" ? "Connectors" : "Folder");
			await other.hover();
			// A fill fades in over 100 ms.
			const settled = async (want: string, what: string) => {
				const fill = () => other.evaluate((item) => (window as any).__fill(item) as string);
				await waitUntil(async () => { try { nearColour(await fill(), want, what); return true; } catch { return false; } }, what, 2000).catch(() => {});
				nearColour(await fill(), want, what);
			};
			await settled(fills[theme].hover, `${at}: an item under the pointer`);
			await page.mouse.down();
			await settled(fills[theme].on, `${at}: a pressed item`);
			await page.mouse.up();
			await page.mouse.move(5, 5);
			await other.press("Shift+Tab");
			const ring = await page.evaluate(() => {
				const item = document.activeElement!;
				const style = getComputedStyle(item);
				const box = item.getBoundingClientRect();
				const nav = item.closest(".settings-dialog-nav")!.getBoundingClientRect();
				const reach = parseFloat(style.outlineOffset) + parseFloat(style.outlineWidth);
				return { item: item.classList.contains("settings-dialog-nav-item"), focusVisible: item.matches(":focus-visible"), style: style.outlineStyle, width: style.outlineWidth, inside: reach <= 0 && box.left >= nav.left && box.right <= nav.right };
			});
			same(ring, { item: true, focusVisible: true, style: "solid", width: "2px", inside: true }, `${at}: the keyboard's ring on an item, inside it`);
			await closeWindow(page);
		}
		await page.context().close();
	}
	console.log("  ok  sidebar: 32 px items in today's order, the chosen one at 500 on its fill, hover, pressed and a 2 px ring inside the item, Settings in three groups, Archive or delete in the ordinary colour, both themes");
}

/** The open page's header, lead, close and hairline. */
async function readHeader(page: Page) {
	return page.evaluate(() => {
		const dialog = document.querySelector(".settings-dialog")!;
		const pane = dialog.querySelector(".settings-dialog-pane")!;
		const shown = (element: Element) => element.getClientRects().length > 0;
		const head = [...pane.querySelectorAll(".pane-head")].find(shown)!;
		const top = head.closest(".pane-top")!;
		const lead = top.querySelector(".pane-lead");
		const h2 = head.querySelector("h2")!;
		const closes = [...dialog.querySelectorAll("button")].filter((button) => shown(button) && button.getAttribute("aria-label") === "Close");
		const close = closes[0]?.getBoundingClientRect();
		const shadow = getComputedStyle(head).boxShadow;
		return {
			headTop: head.getBoundingClientRect().top - pane.getBoundingClientRect().top,
			headBottom: head.getBoundingClientRect().bottom,
			headHeight: head.getBoundingClientRect().height,
			types: [h2, dialog.querySelector(".settings-dialog-title")!].map((one) => `${getComputedStyle(one).fontSize}/${getComputedStyle(one).lineHeight}`),
			// The window's name (its first line), the page's title, the close and each of the page's actions, by their middles.
			middles: [dialog.querySelector(".settings-dialog-title")!, h2, ...closes, ...head.querySelectorAll(".pane-head-actions > *")].filter(shown).map((one) => { const box = one.getBoundingClientRect(); return Math.round(box.top + (one.matches(".settings-dialog-title") ? parseFloat(getComputedStyle(one).lineHeight) : box.height) / 2); }),
			titleBottom: h2.getBoundingClientRect().bottom,
			leadTop: lead ? lead.getBoundingClientRect().top : null,
			closes: closes.length,
			closeInActions: head.querySelector(".pane-head-actions [aria-label='Close']") !== null,
			close: close ? [close.left, close.top, close.width, close.height] : null,
			hairline: (window as any).__painted(shadow.replace(/\s+-?\d+(\.\d+)?px/g, "").trim()) && /1px/.test(shadow),
			scrolled: pane.scrollTop,
		};
	});
}

async function checkHeader(browser: Browser): Promise<void> {
	const page = await openPage(browser, desktop(1440, 900), "on");
	await installColourTools(page);
	const rows: string[] = [];
	await everyPage(page, async (which, label) => {
		const at = `${which} ${label}`;
		// Rows above the header never show: each page starts scrolled to its top here.
		await page.evaluate(() => { document.querySelector(".settings-dialog-pane")!.scrollTop = 0; });
		const rest = await readHeader(page);
		same([rest.headTop, rest.headHeight, rest.types], [0, 56, ["18px/24px", "18px/24px"]], `${at}: the title line at rest, its title at the window name's size and line`);
		assert(Math.max(...rest.middles) - Math.min(...rest.middles) <= 1, `${at}: the window's name, the title, the close and the page's actions on one line (${rest.middles.join(", ")})`);
		if (rest.leadTop !== null) same(Math.round(rest.leadTop - rest.titleBottom), 8, `${at}: the lead 8 under the title`);
		same([rest.closes, rest.closeInActions, rest.close?.slice(2)], [1, false, [28, 28]], `${at}: one 28 px close button, outside the page's actions`);
		assert(!rest.hairline, `${at}: a hairline shows before the page has scrolled`);
		// The header holds while the box it sticks in lasts: that box must reach far enough that the page's last line can scroll into view under a header still in place.
		const reach = await page.evaluate(() => {
			const pane = document.querySelector(".settings-dialog-pane")!;
			const shown = (element: Element) => element.getClientRects().length > 0;
			const holder = [...pane.querySelectorAll(".pane-top")].find((top) => shown(top.querySelector(".pane-head")!))!.parentElement!;
			const root = [...pane.children].find((child) => child.contains(holder))!;
			const lowest = Math.max(...[...root.querySelectorAll("*")].filter(shown).map((element) => element.getBoundingClientRect().bottom));
			return { short: Math.round(lowest - holder.getBoundingClientRect().bottom), room: pane.clientHeight - 56, holder: holder.className };
		});
		assert(reach.short <= reach.room, `${at}: the page runs ${reach.short} px past ${reach.holder}, the box its header sticks in`);
		// Then scroll within that box: a spacer at its end, so the shortest page scrolls too.
		await page.evaluate(() => {
			const pane = document.querySelector(".settings-dialog-pane")!;
			const holder = [...pane.querySelectorAll(".pane-top")].find((top) => top.querySelector(".pane-head")!.getClientRects().length > 0)!.parentElement!;
			const spacer = document.createElement("div");
			spacer.className = "smoke-spacer";
			spacer.style.height = "1600px";
			spacer.style.flex = "none";
			holder.append(spacer);
			pane.scrollTop = 1200;
		});
		await waitUntil(async () => (await readHeader(page)).hairline, `${at}: the hairline shows once scrolled`, 3000).catch(() => {});
		const down = await readHeader(page);
		same([down.headTop, down.close], [0, rest.close], `${at}: the title line and close stay put while the page scrolls`);
		assert(down.hairline, `${at}: no hairline under the header once the page has scrolled`);
		if (rest.leadTop !== null) same(Math.round(rest.leadTop - down.leadTop!), down.scrolled, `${at}: the lead scrolls with the page`);
		// Back to the top: the hairline goes, and the spacer with it.
		await page.evaluate(() => { const pane = document.querySelector(".settings-dialog-pane")!; pane.scrollTop = 0; document.querySelector(".smoke-spacer")!.remove(); });
		await waitUntil(async () => !(await readHeader(page)).hairline, `${at}: the hairline goes at the top`, 3000);
		// A jump to a row from either side stops below the header.
		const jumps = await page.evaluate(() => {
			const pane = document.querySelector(".settings-dialog-pane")!;
			const head = [...pane.querySelectorAll(".pane-head")].find((element) => element.getClientRects().length)!;
			const rows = [...pane.querySelectorAll(".settings-row, .settings-group-kicker, .room-skills-row, .connector-item, .skill-row, .room-schedules-job")].filter((element) => element.getClientRects().length);
			if (rows.length < 2 || pane.scrollHeight <= pane.clientHeight) return null;
			const last = rows.at(-1)!;
			last.scrollIntoView({ block: "start" });
			// A row near the page's end cannot reach the top: then the page has scrolled as far as it goes.
			const lastGap = pane.scrollTop >= pane.scrollHeight - pane.clientHeight - 1 ? 0 : last.getBoundingClientRect().top - head.getBoundingClientRect().bottom;
			pane.scrollTop = pane.scrollHeight;
			const first = rows.find((row) => row.getBoundingClientRect().bottom < head.getBoundingClientRect().bottom) ?? rows[0];
			first.scrollIntoView({ block: "nearest" });
			const firstGap = first.getBoundingClientRect().top - head.getBoundingClientRect().bottom;
			pane.scrollTop = 0;
			return { lastGap, firstGap };
		});
		if (jumps) assert(jumps.firstGap >= 0 && jumps.lastGap >= 0, `${at}: a jump to a row ends under the header (${JSON.stringify(jumps)})`);
		// Shared parts on every page: form rows at least 56, section titles 13/20 at 500.
		const parts = await page.evaluate((box) => {
			const pane = document.querySelector(".settings-dialog-pane")!;
			const shown = (element: Element) => element.getClientRects().length > 0;
			return {
				shortRows: [...pane.querySelectorAll(".settings-row")].filter((row) => shown(row) && row.closest(box)).map((row) => Math.round(row.getBoundingClientRect().height)).filter((height) => height < 56),
				kickers: [...new Set([...pane.querySelectorAll(".settings-group-kicker")].filter(shown).map((kicker) => { const style = getComputedStyle(kicker); return `${style.fontSize}/${style.lineHeight}/${style.fontWeight}`; }))],
				// Between two rows of a card, one painted line that starts and ends 16 px in from the card's edges. Settings,
				// Connectors' own list is left out: its rows reach 8 px past the card's padding for their open fill
				// (26-connectors.css), and their lines come with that list's own rows.
				missingLines: [...pane.querySelectorAll(box)].filter((card) => shown(card) && !card.matches(".connector-list")).flatMap((card) => {
					const edge = card.getBoundingClientRect();
					const rows = [...card.children].filter(shown);
					return rows.slice(1).filter((row, i) => {
						const above = getComputedStyle(rows[i]);
						const style = getComputedStyle(row);
						const painted = (colour: string, width: string, line: string) => parseFloat(width) >= 1 && line !== "none" && (window as any).__painted(colour);
						const lined = painted(style.borderTopColor, style.borderTopWidth, style.borderTopStyle) ? row : painted(above.borderBottomColor, above.borderBottomWidth, above.borderBottomStyle) ? rows[i] : null;
						if (!lined) return true;
						const line = lined.getBoundingClientRect();
						return Math.round(line.left - edge.left) !== 17 || Math.round(edge.right - line.right) !== 17;
					}).map((row) => `${card.className.split(" ")[0]} > ${row.className.split(" ")[0] || row.tagName.toLowerCase()}`);
				}),
				// No line above a card's first row: the card's edge is that line.
				extraLines: [...pane.querySelectorAll(box)].filter(shown).flatMap((card) => {
					const first = [...card.children].find(shown);
					const style = first && getComputedStyle(first);
					return style && parseFloat(style.borderTopWidth) >= 1 && style.borderTopStyle !== "none" && (window as any).__painted(style.borderTopColor) ? [`${card.className.split(" ")[0]} > ${first!.className.split(" ")[0]}`] : [];
				}),
				// A section's title (with its help) 8 px above the card right after it. Settings, Connectors' two lists keep
				// their own spacing (26-connectors.css), as that page's own layout.
				titleGaps: [...pane.querySelectorAll(box)].filter((card) => shown(card) && !card.closest(".connector-list-section, [aria-label='Connector directory']")).flatMap((card) => {
					const title = card.previousElementSibling;
					if (!title || !shown(title) || !title.matches(".group-head, .settings-group-kicker")) return [];
					const gap = Math.round(card.getBoundingClientRect().top - title.getBoundingClientRect().bottom);
					return gap === 8 ? [] : [`"${title.textContent!.slice(0, 24)}" ${gap} px`];
				}),
			};
		}, BOX);
		same(parts.shortRows, [], `${at}: form rows under 56 px`);
		same(parts.missingLines, [], `${at}: rows of a card with no divider 16 px in from its sides`);
		same(parts.extraLines, [], `${at}: a line above a card's first row`);
		same(parts.titleGaps, [], `${at}: section titles not 8 px above their card`);
		// A section's label, 13/20 at 600 (44).
		assert(parts.kickers.every((kind) => kind === "13px/20px/600"), `${at}: section titles at ${parts.kickers.join(", ")}`);
		rows.push(label);
	});
	same(rows.length, 17, "pages checked");
	// The hairline after a change of page: scrolled on one page, then a page too short to scroll.
	await openWindow(page, "settings");
	await goToPage(page, "Connectors");
	// Scrolled to its end once its rows are in.
	await waitUntil(async () => { await page.evaluate(() => { const pane = document.querySelector(".settings-dialog-pane")!; pane.scrollTop = pane.scrollHeight; }); return (await readHeader(page)).hairline; }, "Connectors scrolled shows the hairline");
	await goToPage(page, "Appearance");
	await waitUntil(async () => { const read = await readHeader(page); return read.hairline === read.scrolled > 0; }, "after a change of page the hairline matches the scroll", 3000);
	same((await readHeader(page)).hairline, false, "Appearance, opened from a scrolled Connectors: the hairline");
	await closeWindow(page);
	// In Room settings every page stays mounted in one scroller.
	await openWindow(page, "room");
	await goToPage(page, "Memory");
	// Scrolled to its end once its rows are in.
	await waitUntil(async () => { await page.evaluate(() => { const pane = document.querySelector(".settings-dialog-pane")!; pane.scrollTop = pane.scrollHeight; }); return (await readHeader(page)).hairline; }, "Memory scrolled shows the hairline");
	for (const label of ["Model", "Conversation", "Memory"]) {
		await goToPage(page, label);
		await waitUntil(async () => { const read = await readHeader(page); return read.hairline === read.scrolled > 0; }, `Room settings, ${label} after a change of page: the hairline matches the scroll`, 3000);
	}
	await page.context().close();
	console.log("  ok  page header on all 17 pages: the title at the window name's 18/24, on one line with it, the close and the page's actions; the 56 px line stays put, the lead 8 under the title and scrolling, the hairline only once scrolled and right after a change of page, one 28 px close, jumps stop below it; form rows at least 56, section titles 13/20 at 500, 8 px above their card, no line above a card's first row");
}

async function checkParts(browser: Browser): Promise<void> {
	// The specification's colours: the card, its edge and dividers, the switch off and on.
	const want = {
		// The off track at 3:1 on the card, its own token (01-base.css), so an off switch reads.
		[LIGHT]: { card: "#ffffff", edge: "#e2ddd3", divider: "#e8e3da", off: "#928b82", offHover: "#7f786f", on: "#111111", knobOn: "#ffffff", soft: "#34312d" },
		[DARK]: { card: "#373737", edge: "#464645", divider: "#4c4b4b", off: "#8a847c", offHover: "#9a948b", on: "#f4f1ec", knobOn: "#0f0f0f", soft: "#d5d0c8" },
	};
	for (const theme of [LIGHT, DARK] as const) {
		const page = await openPage(browser, desktop(1440, 900, theme), "on");
		await installColourTools(page);
		await openWindow(page, "room");
		await goToPage(page, "Memory");
		const at = `${theme}, Memory`;
		const toggle = page.locator(".room-maintenance-section input.workspaces-tool-switch").first();
		await toggle.waitFor({ timeout: 10000 });
		const card = await page.evaluate(() => {
			const shown = (element: Element) => element.getClientRects().length > 0;
			const box = [...document.querySelectorAll(".room-maintenance-section .settings-rows")].find((element) => shown(element) && element.children.length > 1)!;
			const style = getComputedStyle(box);
			const outer = box.getBoundingClientRect();
			const second = box.children[1];
			const line = getComputedStyle(second);
			const row = second.getBoundingClientRect();
			const w = window as any;
			return {
				fill: w.__fill(box), edge: `${style.borderTopWidth} ${style.borderTopStyle} ${w.__seen(box, style.borderTopColor)}`, radius: style.borderTopLeftRadius,
				divider: `${line.borderTopWidth} ${line.borderTopStyle} ${w.__seen(second, line.borderTopColor)}`,
				inset: [row.left - outer.left, outer.right - row.right],
				kicker: w.__seen(box, getComputedStyle(document.querySelector(".room-maintenance-section .settings-group-kicker")!).color),
			};
		});
		same([card.edge.split(" ").slice(0, 2), card.divider.split(" ").slice(0, 2), card.radius, card.inset], [["1px", "solid"], ["1px", "solid"], "12px", [17, 17]], `${at}: the card's edge, radius and a divider 16 px in from its sides`);
		nearColour(card.fill, want[theme].card, `${at}: the card's fill`);
		nearColour(card.edge.split(" ")[2], want[theme].edge, `${at}: the card's edge`);
		nearColour(card.divider.split(" ")[2], want[theme].divider, `${at}: a divider`);
		nearColour(card.kicker, want[theme].soft, `${at}: a section title`);
		const switchLook = () => toggle.evaluate((input) => {
			const box = input.getBoundingClientRect();
			const knob = getComputedStyle(input, "::before");
			return { tag: `${input.tagName.toLowerCase()}:${(input as HTMLInputElement).type}`, size: [box.width, box.height], track: (window as any).__fill(input), knob: knob.backgroundColor, knobSize: [knob.width, knob.height] };
		});
		const knobOff = theme === LIGHT ? "rgb(255, 255, 255)" : "rgb(244, 241, 236)";
		const off = await switchLook();
		assert(!(await toggle.isChecked()), `${at}: the first switch starts off`);
		same({ ...off, track: "" }, { tag: "input:checkbox", size: [36, 20], track: "", knob: knobOff, knobSize: ["16px", "16px"] }, `${at}: a switch, off`);
		nearColour(off.track, want[theme].off, `${at}: a switch's track, off`);
		for (const [what, colour] of [["off", want[theme].off], ["off under the pointer", want[theme].offHover]] as const) assert(contrast(colour, want[theme].card) >= 3, `${at}: a switch ${what} stands ${contrast(colour, want[theme].card).toFixed(2)} to 1 off its card, under 3`);
		// On, read without saving and in one step, without the fade, so the page's own render cannot put it back first.
		const on = await toggle.evaluate((input) => {
			const box = input as HTMLInputElement;
			box.style.transition = "none";
			box.checked = true;
			const read = { track: (window as any).__fill(box) as string, knob: getComputedStyle(box, "::before").backgroundColor };
			box.checked = false;
			box.style.transition = "";
			return read;
		});
		nearColour(on.track, want[theme].on, `${at}: a switch's track, on`);
		same(on.knob, await page.evaluate((hex) => { const probe = document.createElement("i"); probe.style.color = hex; document.body.append(probe); const colour = getComputedStyle(probe).color; probe.remove(); return colour; }, want[theme].knobOn), `${at}: a switch's knob, on`);
		await toggle.hover();
		// The track's colour fades over 150 ms.
		await waitUntil(async () => { try { nearColour((await switchLook()).track, want[theme].offHover, ""); return true; } catch { return false; } }, "the hover settles", 2000).catch(() => {});
		nearColour((await switchLook()).track, want[theme].offHover, `${at}: a switch under the pointer, off`);
		// Its target is 44 by 32 around it.
		const target = await toggle.evaluate((input) => {
			const box = input.getBoundingClientRect();
			const lands = (x: number, y: number) => document.elementFromPoint(x, y) === input;
			const middleX = box.left + box.width / 2;
			const middleY = box.top + box.height / 2;
			return [lands(middleX, box.top - 5), lands(middleX, box.bottom + 5), lands(box.left - 3, middleY), lands(box.right + 3, middleY)];
		});
		same(target, [true, true, true, true], `${at}: the switch takes a click 44 by 32 around it`);
		await page.mouse.move(5, 5);
		await toggle.focus();
		await page.keyboard.press("Shift+Tab");
		await page.keyboard.press("Tab");
		same(await toggle.evaluate((input) => { const style = getComputedStyle(input); return [input.matches(":focus-visible"), style.outlineStyle, style.outlineWidth, style.outlineOffset]; }), [true, "solid", "2px", "2px"], `${at}: the keyboard's ring, 2 px off the switch`);
		await toggle.evaluate((input) => { (input as HTMLInputElement).disabled = true; });
		same(await toggle.evaluate((input) => getComputedStyle(input).opacity), "0.45", `${at}: a disabled switch`);
		await toggle.evaluate((input) => { (input as HTMLInputElement).disabled = false; });
		await page.context().close();
	}
	console.log("  ok  shared parts: the card in the card colour with its edge, a 12 px radius and dividers 16 px in; section titles in soft text; the switch 36 by 20, still a checkbox, off, on, hover, focus and disabled, with a 44 by 32 target, both themes");
}

async function checkPhone(browser: Browser): Promise<void> {
	for (const theme of [LIGHT, DARK] as const) {
		const page = await openPage(browser, phone(theme), "on");
		await installReach(page);
		const small: string[] = [];
		for (const which of ["settings", "room"] as const) {
			await openWindow(page, which);
			for (const label of pagesOf(which)) {
				await goToPage(page, label);
				const at = `${theme}, phone, ${which} ${label}`;
				const readBar = () => page.evaluate(() => {
					const shown = (element: Element) => element.getClientRects().length > 0;
					const bars = [...document.querySelectorAll(".settings-dialog-bar")].filter(shown);
					const one = bars[0];
					const size = (element: Element | null) => { const box = element?.getBoundingClientRect(); return box ? [box.width, box.height] : null; };
					const pane = document.querySelector(".settings-dialog-pane")!;
					const firstRow = [...pane.querySelectorAll(".settings-rows > *, .ai-profile-row, .room-skills-row, .connector-item, .skill-row, .room-schedules-job, textarea, .settings-empty, .room-skills-empty")].find(shown);
					return {
						bars: bars.length,
						height: one ? one.getBoundingClientRect().height : 0,
						back: size(one?.querySelector(".settings-dialog-back") ?? null),
						backName: one?.querySelector(".settings-dialog-back")?.getAttribute("aria-label"),
						name: one?.querySelector(".settings-dialog-bar-title")?.textContent,
						close: size(one?.querySelector(".settings-dialog-close") ?? null),
						// Back and close are the same quiet mark: one size, one colour.
						marks: [".settings-dialog-back", ".settings-dialog-close"].map((selector) => { const button = one?.querySelector(selector); const mark = button?.querySelector("svg"); return mark ? `${mark.getBoundingClientRect().width} ${getComputedStyle(button!).color}` : null; }),
						firstRow: firstRow ? Math.round(firstRow.getBoundingClientRect().top) : null,
						// A section's title and help, in the open page, are never hidden with the page's own title.
						hiddenTitles: [...pane.children].filter(shown).flatMap((root) => [...root.querySelectorAll(".group-head .settings-group-kicker, .group-head .group-head-line")]).filter((title) => !shown(title)).map((title) => title.textContent),
						// A row whose control drops under its words keeps it 12 below them.
						dropGaps: [...pane.querySelectorAll(".settings-row")].filter((row) => shown(row) && getComputedStyle(row).flexDirection === "column").flatMap((row) => {
							const [words, control] = [...row.children].filter(shown);
							if (!words || !control) return [];
							const gap = Math.round(control.getBoundingClientRect().top - words.getBoundingClientRect().bottom);
							return gap === 12 ? [] : [`${(words.textContent ?? "").slice(0, 24)}: ${gap} px`];
						}),
						// The page's actions on one line sit together from the left, 8 apart.
						actionGaps: [...pane.querySelectorAll(".pane-head > .pane-head-actions")].filter(shown).flatMap((actions) => {
							const boxes = [...actions.children].filter(shown).map((child) => child.getBoundingClientRect());
							return boxes.slice(1).filter((box, i) => Math.round(box.top) === Math.round(boxes[i].top) && Math.round(box.left - boxes[i].right) !== 8).map((box, i) => Math.round(box.left - boxes[i].right));
						}),
						// No line above a card's first row, where a table hides its head.
						extraLines: [...pane.querySelectorAll(".settings-rows, .room-skills-rows, .room-schedules-list, .room-schedules-run-list, .skill-table")].filter(shown).flatMap((card) => {
							const first = [...card.children].find(shown);
							const style = first && getComputedStyle(first);
							return style && parseFloat(style.borderTopWidth) >= 1 && style.borderTopStyle !== "none" && !/rgba\(.*, 0\)$/.test(style.borderTopColor) ? [`${card.className.split(" ")[0]} > ${first!.className.split(" ")[0]}`] : [];
						}),
						// No room kept for a scrollbar: the cards sit 16 from both sides of the screen.
						sides: (() => { const card = [...pane.querySelectorAll(".settings-rows, .ai-profile-card, .skill-table")].find(shown); if (!card) return null; const box = card.getBoundingClientRect(); return [Math.round(box.left), Math.round(window.innerWidth - box.right)]; })(),
					};
				});
				await answered(page, at);
				const bar = await readBar();
				same({ bars: bar.bars, height: bar.height, back: bar.back, backName: bar.backName, name: bar.name, close: bar.close }, { bars: 1, height: 52, back: [44, 44], backName: "All settings", name: label, close: [44, 44] }, `${at}: one bar with back, the page's name and close`);
				assert(bar.firstRow !== null && bar.firstRow <= 240, `${at}: the first row starts at ${bar.firstRow} px`);
				same(bar.hiddenTitles, [], `${at}: section titles and help hidden`);
				same(bar.marks[0], bar.marks[1], `${at}: back's mark against close's`);
				same(bar.extraLines, [], `${at}: a line above a card's first row`);
				same(bar.dropGaps, [], `${at}: a dropped control not 12 below its words`);
				same(bar.actionGaps, [], `${at}: the page's actions not 8 apart`);
				if (bar.sides && !(await page.evaluate(() => { const pane = document.querySelector(".settings-dialog-pane")!; return pane.scrollHeight > pane.clientHeight; }))) same(bar.sides, [16, 16], `${at}: the card's sides`);
				// Every target in the bar and the page's header is a finger's size; the info mark is left out, as its size is its own component's (rs-info.tsx), not this look's.
				small.push(...(await page.evaluate((where) => {
					const shown = (element: Element) => element.getClientRects().length > 0;
					const targets = [...document.querySelectorAll(".settings-dialog-bar button, .settings-dialog-pane .pane-top button, .settings-dialog-pane .pane-top input, .settings-dialog-pane .pane-top a")].filter((target) => shown(target) && !target.matches(".rs-info"));
					const reach = (target: Element): number => (window as any).__reach(target);
					return targets.map((target) => ({ name: (target.getAttribute("aria-label") ?? target.textContent ?? "").trim(), height: reach(target) })).filter((one) => one.height < 43.5).map((one) => `${where}: "${one.name}" ${one.height} px`);
				}, at)));
			}
			// The list of pages: the window's name where the bar is, and close.
			await page.locator(".settings-dialog-back").click();
			if (which === "room") same(await pencilOffLine(page), 0, `${theme}, phone: the pencil on the name's first line`);
			const list = await page.evaluate(() => {
				const shown = (element: Element) => element.getClientRects().length > 0;
				const head = document.querySelector(".settings-dialog-head")!.getBoundingClientRect();
				const close = document.querySelector(".settings-dialog-close")!.getBoundingClientRect();
				return { visibleBack: shown(document.querySelector(".settings-dialog-back")!), headTop: head.top, closeInHead: close.top >= head.top && close.bottom <= head.bottom, rows: [...document.querySelectorAll(".settings-dialog-nav-item")].map((item) => item.getBoundingClientRect().height),
					// Each row: a chevron, and a line under it unless it ends the list or stands before Archive or delete (one even list).
					marks: [...document.querySelectorAll(".settings-dialog-nav-item")].map((item) => {
						const next = item.nextElementSibling;
						const ends = !next || next.matches(".danger");
						return `${item.textContent}: ${getComputedStyle(item, "::after").content !== "none" ? "chevron" : "no chevron"}, ${(parseFloat(getComputedStyle(item).borderBottomWidth) >= 1) !== ends ? "right line" : "wrong line"}`;
					}).filter((mark) => !mark.endsWith(": chevron, right line")),
					// Labels start on the page's 16 px edge.
					labelEdges: [...new Set([...document.querySelectorAll(".settings-dialog-nav-item")].map((item) => Math.round(item.getBoundingClientRect().left + parseFloat(getComputedStyle(item).paddingLeft))))],
					// Room settings' head keeps the room's name on the left edge until its own task.
					headStart: (() => { const name = document.querySelector(".settings-dialog-title-row")?.firstElementChild; return name ? Math.round(name.getBoundingClientRect().left) : null; })() };
			});
			same([list.visibleBack, list.headTop, list.closeInHead], [false, 0, true], `${theme}, phone, ${which}'s list: the window's name on top beside close, no back`);
			assert(list.rows.every((height) => height >= 44), `${theme}, phone, ${which}'s list: rows ${list.rows.join(", ")} px`);
			same(list.marks, [], `${theme}, phone, ${which}'s list: rows' chevrons and lines`);
			same(list.labelEdges, [16], `${theme}, phone, ${which}'s list: where the labels start`);
			if (which === "room") same(list.headStart, 16, `${theme}, phone, room's list: where the room's name starts`);
			await closeWindow(page);
		}
		same(small, [], `${theme}, phone: targets under 44 px`);
		await page.context().close();
	}
	console.log("  ok  phone: one 52 px bar with \"All settings\", the page's name and close on all 17 pages, the first row at 240 px or higher, finger-sized targets, a dropped control 12 under its words, the page's actions 8 apart, the cards 16 from both sides, the list under the window's name with a chevron on every row, labels on the 16 px edge and a line between the pages, back's mark as quiet as close's, Room settings' head on the left edge, both themes");
}

/** For each kept class, the tag of each element carrying it, in page order. An element only the look draws (`data-look-only`) is left out: its page's own smoke checks it.
 * So are a room's Skills' "On" and "Off" headings: the new look has one list, with how many are on beside the title
 * (settings-look-skills-ui-smoke.ts). And a room's Connectors header's actions: the old look's "Open connectors" there is the lead's link in the new look (one way to Settings per page), which settings-look-room-connectors-ui-smoke.ts checks. */
async function readClasses(page: Page): Promise<Record<string, string[]>> {
	return page.evaluate((classes) => Object.fromEntries(classes.map((name) => [name, [...document.querySelectorAll(`.${name}:not([data-look-only])`)].filter((element) => !(name === "pane-head-actions" && element.closest(".room-connectors-section")) && !(name === "settings-group-kicker" && element.closest(".room-skills-group"))).map((element) => `${element.tagName.toLowerCase()}${element.getAttribute("type") ? `[${element.getAttribute("type")}]` : ""}`)])), KEPT_CLASSES);
}

async function checkClassNames(browser: Browser): Promise<void> {
	const read: Record<string, Record<string, Record<string, string[]>>> = { off: {}, on: {} };
	const inkAndColour: Record<string, Awaited<ReturnType<typeof readInkAndColour>>> = {};
	for (const look of ["off", "on"] as const) {
		const page = await openPage(browser, desktop(1280), look);
		if (look === "on") await installColourTools(page);
		await everyPage(page, async (which, label) => {
			const at = `${which} ${label}`;
			// Room settings mounts every page at once, each filling in from its own request: read once none is out, twice in a row.
			await answered(page, `${look}, ${at}`);
			read[look][at] = await readClasses(page);
			if (look === "on") {
				await page.mouse.move(5, 5);
				inkAndColour[at] = await readInkAndColour(page, ".settings-dialog", CONTROL[LIGHT].ink);
			}
		});
		await page.context().close();
	}
	for (const at of Object.keys(read.off)) same(read.on[at], read.off[at], `${at}: the kept class names on the same elements, switch on as off`);
	const seen = new Set(Object.values(read.on).flatMap((classes) => Object.entries(classes).filter(([, tags]) => tags.length).map(([name]) => name)));
	same(KEPT_CLASSES.filter((name) => !seen.has(name)), [], "kept class names found on no page");
	console.log("  ok  the class names other checks read sit on the same elements with the switch on and off, on all 17 pages");
	// The shared rules: at most one ink button on a page, and colour only on a status dot and a red button.
	for (const [at, { inked, coloured }] of Object.entries(inkAndColour)) {
		assert(inked.length <= 1, `${at}: ${inked.length} ink buttons at once: ${inked.join(", ")}`);
		same(coloured.map((one) => one.split(" ")[0]), COLOURED_TODAY[at] ?? [], `${at}: colour only on a status dot or a red button (${coloured.join("; ")})`);
	}
	console.log(`  ..  ink buttons: ${Object.entries(inkAndColour).filter(([, { inked }]) => inked.length).map(([at, { inked }]) => `${at} ${inked.join(", ")}`).join("; ")}; words in colour from the pages' own files: ${Object.entries(COLOURED_TODAY).map(([at, kinds]) => `${at} ${kinds.join(", ")}`).join("; ")}`);
	console.log("  ok  at most one ink button on each of the 17 pages, and colour only on status dots and red buttons, but for the words in colour the pages' own files still give");
}

async function checkContrast(browser: Browser): Promise<void> {
	for (const theme of [LIGHT, DARK] as const) {
		const page = await openPage(browser, desktop(1440, 900, theme), "on");
		await installColourTools(page);
		const measured: string[] = [];
		for (const [which, label] of [["settings", "AI setup"], ["room", "Memory"]] as const) {
			await openWindow(page, which);
			await goToPage(page, label);
			await page.mouse.move(5, 5);
			const pairs = await page.evaluate(() => {
				const w = window as any;
				const shown = (element: Element) => element.getClientRects().length > 0;
				const first = (selector: string) => [...document.querySelectorAll(selector)].find(shown) ?? null;
				const words = {
					"window name on the sidebar": first(".settings-dialog-title"),
					"kicker on the sidebar": first(".settings-dialog-kicker"),
					// The last one, clear of the fade a page just left keeps for 100 ms.
					"page in the sidebar": [...document.querySelectorAll(".settings-dialog-nav-item:not(.active, .danger)")].at(-1) ?? null,
					"chosen page on its fill": first(".settings-dialog-nav-item.active"),
					"Archive or delete": first(".settings-dialog-nav-item.danger"),
					"page title": first(".pane-head h2"),
					"lead on the page": first(".pane-lead"),
					"section title on the page": first(".settings-group-kicker"),
					"section help on the page": first(".group-head-line"),
					"row label on a card": first(".settings-rows .settings-row-label"),
					"row help on a card": first(".settings-rows .settings-row-sub"),
				};
				const edges = {
					"card edge on the page": first(".settings-rows"),
				};
				return {
					words: Object.entries(words).filter(([, element]) => element).map(([name, element]) => [name, Number(w.__contrast(element).toFixed(2))] as const),
					edges: Object.entries(edges).filter(([, element]) => element).map(([name, element]) => [name, Number(w.__edgeContrast(element, getComputedStyle(element!).borderTopColor).toFixed(2))] as const),
				};
			});
			for (const [name, ratio] of pairs.words) {
				assert(ratio >= 4.5, `${theme}, ${which} ${label}: ${name} at ${ratio}:1`);
				measured.push(`${which} ${name} ${ratio}`);
			}
			for (const [name, ratio] of pairs.edges) measured.push(`${which} ${name} ${ratio}`);
			await closeWindow(page);
		}
		console.log(`  ..  ${theme}: ${measured.join("; ")}`);
		await page.context().close();
	}
	console.log("  ok  every word the look colours reads at 4.5:1 or more, both themes");
}

// --- The controls, with the switch on ------------------------------------------

/** The specification's colours for the controls, per theme. */
const CONTROL = {
	[LIGHT]: { card: "#ffffff", chosen: "#ffffff", thumb: "#ffffff", field: "#c7c0b6", fieldHover: "#b3aba0", focus: "#111111", ink: "#111111", muted: "#6d675f", soft: "#34312d", text: "#171717", veil: "rgba(17, 17, 17, 0.28)", placeholder: 3.4 },
	[DARK]: { card: "#373737", chosen: "#565655", thumb: "#f4f1ec", field: "#5e5952", fieldHover: "#6f6a64", focus: "#d9d2c6", ink: "#f4f1ec", muted: "#aaa39a", soft: "#d5d0c8", text: "#f2f0ec", veil: "rgba(0, 0, 0, 0.5)", placeholder: 3.2 },
};
/** A share of one colour over another, as a person sees it. */
function mixed(top: string, bottom: string, share: number): string {
	const [over, under] = [top, bottom].map((hex) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16)));
	return `#${under.map((value, i) => Math.round(over[i] * share + value * (1 - share)).toString(16).padStart(2, "0")).join("")}`;
}
/** A share of the text colour over the card: the fills of hover and press. */
const tint = (theme: Theme, share: number) => mixed(CONTROL[theme].text, CONTROL[theme].card, share);
/** The window's ring and a focused field's edge (44's --settings-focus): the focus ink at 60%, so it never reads as a heavy box. */
const FOCUS_SHARE = 60;
/** A colour as the browser writes it in a computed style. */
const computed = (page: Page, colour: string) => page.evaluate((value) => { const probe = document.createElement("i"); probe.style.color = value; document.body.append(probe); const read = getComputedStyle(probe).color; probe.remove(); return read; }, colour);
/** Waits out a 100 to 150 ms fade, then reads. */
async function settled<T>(read: () => Promise<T>, ok: (value: T) => boolean, what: string): Promise<T> {
	await waitUntil(async () => ok(await read()), what, 2000).catch(() => {});
	return read();
}
const visible = (page: Page, selector: string) => page.locator(selector).filter({ visible: true }).first();
/** The colours drawn at points inside an element (CSS px from its top left), as #rrggbb: what a person sees, parts the page cannot read included. */
async function pixelsOf(page: Page, target: ReturnType<Page["locator"]>, points: Array<[number, number]>): Promise<string[]> {
	const picture = (await target.screenshot({ animations: "disabled" })).toString("base64");
	return target.evaluate(async (element, { picture, points }) => {
		const image = new Image();
		image.src = `data:image/png;base64,${picture}`;
		await image.decode();
		const canvas = document.createElement("canvas");
		[canvas.width, canvas.height] = [image.width, image.height];
		const context = canvas.getContext("2d", { willReadFrequently: true })!;
		context.drawImage(image, 0, 0);
		const scale = image.width / element.getBoundingClientRect().width;
		return points.map(([x, y]) => {
			const [r, g, b] = context.getImageData(Math.floor(x * scale), Math.floor(y * scale), 1, 1).data;
			return `#${[r, g, b].map((value) => value.toString(16).padStart(2, "0")).join("")}`;
		});
	}, { picture, points });
}
/** The slider drawn as specified, across its box's middle: a 4 px track in the soft fill, ink up to a 16 px thumb on the paper colour. */
async function checkSliderDrawn(page: Page, slider: ReturnType<Page["locator"]>, theme: Theme, at: string): Promise<void> {
	const want = CONTROL[theme];
	const { part, width, middle } = await slider.evaluate((input) => {
		const range = input as HTMLInputElement;
		const box = range.getBoundingClientRect();
		return { part: (Number(range.value) - Number(range.min)) / (Number(range.max) - Number(range.min)), width: box.width, middle: box.height / 2 };
	});
	const centre = 8 + (width - 16) * part;
	const [thumb, inkSide, fillSide, end, overTrack] = await pixelsOf(page, slider, [[centre, middle], [centre - 12, middle], [centre + 12, middle], [width - 4, middle], [width - 4, middle - 4]]);
	nearColour(thumb, want.thumb, `${at}: the thumb's fill`);
	nearColour(inkSide, want.ink, `${at}: ink up to the thumb`);
	nearColour(fillSide, tint(theme, 0.08), `${at}: the soft fill after it`);
	nearColour(end, tint(theme, 0.08), `${at}: the soft fill to the track's end`);
	nearColour(overTrack, want.card, `${at}: the track 4 px tall`);
}
/** Moves the keyboard onto an element, so it shows the keyboard's ring. */
async function keyboardTo(page: Page, target: ReturnType<Page["locator"]>): Promise<void> {
	await page.mouse.move(5, 5);
	await target.focus();
	await page.keyboard.press("Shift+Tab");
	await page.keyboard.press("Tab");
}
const ringOf = (target: ReturnType<Page["locator"]>) => target.evaluate((element) => { const style = getComputedStyle(element); return [element.matches(":focus-visible"), style.outlineStyle, style.outlineWidth]; });

/** A field's look, as a person sees it; and whether anything around it cuts a ring of `ring` px off. */
async function readField(field: ReturnType<Page["locator"]>, ring = 1) {
	return field.evaluate((element, out) => {
		const w = window as any;
		const style = getComputedStyle(element);
		const box = element.getBoundingClientRect();
		const cut: string[] = [];
		for (let at = element.parentElement; at && at !== document.body; at = at.parentElement) {
			const around = getComputedStyle(at);
			if (around.overflowX === "visible" && around.overflowY === "visible") continue;
			const edge = at.getBoundingClientRect();
			if (box.left - out < edge.left || box.right + out > edge.right || box.top - out < edge.top || box.bottom + out > edge.bottom) cut.push(at.className.split(" ")[0]);
		}
		return {
			height: box.height,
			radius: style.borderTopLeftRadius,
			edge: `${style.borderTopWidth} ${style.borderTopStyle}`,
			edgeColour: w.__seen(element, style.borderTopColor) as string,
			fill: w.__fill(element) as string,
			font: `${style.fontSize}/${style.lineHeight}`,
			padding: style.padding,
			ring: style.boxShadow,
			opacity: style.opacity,
			placeholder: w.__colourContrast(element, getComputedStyle(element, "::placeholder").color) as number,
			mark: [style.backgroundImage.startsWith("url(\"data:image/svg+xml"), style.paddingLeft, style.backgroundPositionX, style.backgroundSize],
			cut,
		};
	}, ring);
}

async function checkFields(browser: Browser): Promise<void> {
	const measured: string[] = [];
	for (const [theme, options] of [[LIGHT, desktop(1440, 900, LIGHT)], [DARK, desktop(1440, 900, DARK)], [LIGHT, phone(LIGHT)]] as const) {
		const page = await openPage(browser, options, "on");
		await installColourTools(page);
		const want = CONTROL[theme];
		const onPhone = isPhone(page);
		for (const [which, label, selector, kind] of [
			["settings", "Connectors", ".connector-dir-search", "search"],
			["settings", "Instructions", ".settings-dialog-pane textarea", "box"],
			["room", "Memory", ".memory-notes-search", "search"],
			["room", "Instructions", ".settings-dialog-pane textarea", "box"],
			// The one plain field either window shows on opening a page.
			["settings", "Profiles", ".settings-dialog-pane .launcher-path-input", "field"],
		] as const) {
			if (onPhone && kind === "box") {
				// A finger cannot drag the box's corner, and 16 px text takes a 24 px line.
				await openWindow(page, which);
				await goToPage(page, label);
				same(await visible(page, selector).evaluate((element) => [getComputedStyle(element).resize, `${getComputedStyle(element).fontSize}/${getComputedStyle(element).lineHeight}`]), ["none", "16px/24px"], `phone, ${which} ${label}, the long text box: no resize corner, 16/24`);
				await closeWindow(page);
				continue;
			}
			await openWindow(page, which);
			await goToPage(page, label);
			const at = `${theme}${onPhone ? ", phone" : ""}, ${which} ${label}, the ${{ box: "long text box", search: "search field", field: "text field" }[kind]}`;
			const field = visible(page, selector);
			await field.waitFor({ timeout: 10000 });
			// The connectors' checks move the field when they answer, out from under the pointer.
			await answered(page, at);
			await page.mouse.move(5, 5);
			const rest = await readField(field);
			same([rest.edge, rest.ring, rest.cut], ["1px solid", "none", []], `${at}: a 1 px edge, no ring at rest, nothing around it cuts a ring`);
			nearColour(rest.fill, want.card, `${at}: its fill`);
			nearColour(rest.edgeColour, want.field, `${at}: its edge`);
			if (kind !== "box") same([rest.height, rest.radius, rest.font], onPhone ? [44, "8px", "16px/20px"] : [32, "8px", "14px/20px"], `${at}: height, radius and text`);
			if (kind === "search") {
				same(rest.mark, [true, "32px", "10px", "14px 14px"], `${at}: its mark 10 px in, the words at 32`);
			} else if (kind === "field") {
				same([rest.mark[0], rest.padding], [false, "0px 10px"], `${at}: no mark, 10 px in`);
			} else {
				same([rest.radius, rest.font, rest.padding.split(" ")[0], rest.padding.split(" ").at(-1)], ["12px", "14px/22px", "12px", "14px"], `${at}: radius, text and padding`);
			}
			assert(Math.abs(rest.placeholder - want.placeholder) <= 0.1, `${at}: the placeholder at ${rest.placeholder.toFixed(2)}:1, the drawing's ${want.placeholder}:1`);
			measured.push(`${at.split(", ").slice(0, -1).join(" ")} placeholder ${rest.placeholder.toFixed(2)}`);
			if (kind === "box") {
				// Clear sits on the line under the box, clear of its text, so a click on the text never lands on it.
				await field.fill("A line of instructions long enough to run the whole width of the box and past Clear.");
				const clear = page.locator(".settings-dialog-pane .room-instructions-foot").filter({ visible: true }).getByRole("button", { name: "Clear" });
				await clear.waitFor();
				const [boxBottom, clearTop] = await field.evaluate((element, button) => [element.getBoundingClientRect().bottom, button!.getBoundingClientRect().top], await clear.elementHandle());
				assert(clearTop >= boxBottom, `${at}: Clear starts at ${clearTop}, above the box's bottom at ${boxBottom}`);
				await field.fill("");
				await field.evaluate((element) => (element as HTMLElement).blur());
			}
			if (!onPhone) {
				await field.hover();
				const hover = await settled(() => readField(field), (read) => read.edgeColour === want.fieldHover, "the hover settles");
				nearColour(hover.edgeColour, want.fieldHover, `${at}: its edge under the pointer`);
			}
			if (kind === "search") {
				// With words in it, its clear mark is a grey cross drawn in the field's last 26 px, never the browser's blue one.
				await field.fill("notes");
				await page.mouse.move(5, 5);
				const { width, height } = (await field.boundingBox())!;
				const points: Array<[number, number]> = [];
				for (let x = Math.ceil(width - 26); x < width - 2; x++) for (let y = 3; y < height - 3; y++) points.push([x, y]);
				const channels = (hex: string) => [1, 3, 5].map((at) => parseInt(hex.slice(at, at + 2), 16));
				const fill = channels(want.card);
				const seen = (await pixelsOf(page, field, points)).map(channels);
				const mark = seen.reduce((far, pixel) => Math.max(...pixel.map((value, i) => Math.abs(value - fill[i]))) > Math.max(...far.map((value, i) => Math.abs(value - fill[i]))) ? pixel : far, fill);
				assert(Math.max(...mark.map((value, i) => Math.abs(value - fill[i]))) >= 48, `${at}: a clear mark drawn at its end`);
				assert(seen.every(([r, g, b]) => b - Math.min(r, g) <= 16), `${at}: its clear mark grey, never blue`);
				await field.fill("");
				await answered(page, at);
			}
			await field.focus();
			const focusEdge = mixed(want.focus, want.card, FOCUS_SHARE / 100);
			const focus = await settled(() => readField(field), (read) => read.edgeColour === focusEdge, "the focus settles");
			nearColour(focus.edgeColour, focusEdge, `${at}: its edge with the focus`);
			const ringColour = await computed(page, `color-mix(in srgb, ${want.focus} ${FOCUS_SHARE}%, transparent)`);
			assert(focus.ring === `${ringColour} 0px 0px 0px 1px`, `${at}: a 1 px ring in the focus colour, got ${focus.ring}`);
			// Something wrong in it: red, with the focus and without it, since a pressed button moves the focus to it.
			await field.evaluate((element) => { (element as HTMLInputElement).value = "!"; element.setAttribute("aria-invalid", "true"); });
			// The window sets its own red (23-room-settings.css), so it is read where the field is.
			const red = await field.evaluate((element) => (window as unknown as { __seen: (on: Element, colour: string) => string }).__seen(element, getComputedStyle(element).getPropertyValue("--error").trim()));
			const held = await settled(() => readField(field), (read) => read.edgeColour === red, "the mark settles");
			nearColour(held.edgeColour, red, `${at}: wrong, with the focus`);
			await field.evaluate((element) => (element as HTMLElement).blur());
			await page.mouse.move(5, 5);
			const wrong = await settled(() => readField(field), (read) => read.edgeColour === red, "the blur settles");
			nearColour(wrong.edgeColour, red, `${at}: wrong, without the focus`);
			await field.evaluate((element) => { (element as HTMLInputElement).value = ""; element.removeAttribute("aria-invalid"); });
			await field.evaluate((element) => { (element as HTMLInputElement).disabled = true; });
			same((await readField(field)).opacity, "0.45", `${at}: disabled`);
			await field.evaluate((element) => { (element as HTMLInputElement).disabled = false; });
			await closeWindow(page);
		}
		await page.context().close();
	}
	console.log(`  ..  ${measured.join("; ")}`);
	console.log("  ok  fields: the search field and the long text box on a page of each window, and Profiles' text field, white with the field's edge, darker under the pointer, an edge and 1 px ring with the focus that nothing cuts, disabled at 45 %, 32 tall (44 with 16 px text on a phone), the search mark 10 px in and its clear mark a grey cross, placeholders at 3.4:1 light and 3.2:1 dark");
}

async function checkChoices(browser: Browser): Promise<void> {
	for (const theme of [LIGHT, DARK] as const) {
		const page = await openPage(browser, desktop(1440, 900, theme), "on");
		await installColourTools(page);
		const want = CONTROL[theme];
		// The segmented choice: Appearance's theme, a group of pressed buttons.
		await openWindow(page, "settings");
		await goToPage(page, "Appearance");
		let at = `${theme}, Appearance, the segmented choice`;
		const group = page.getByRole("group", { name: "Theme" });
		const segments = group.getByRole("button");
		const readTrack = () => group.evaluate((track) => {
			const w = window as any;
			const style = getComputedStyle(track);
			const row = track.closest(".settings-row")!.getBoundingClientRect();
			const box = track.getBoundingClientRect();
			return {
				track: [box.height, style.paddingTop, style.borderTopLeftRadius],
				toRowEnd: row.right - box.right,
				fill: w.__fill(track) as string,
				segments: [...track.children].map((segment) => {
					const look = getComputedStyle(segment);
					return { height: segment.getBoundingClientRect().height, radius: look.borderTopLeftRadius, font: `${look.fontSize}/${look.lineHeight} ${look.fontWeight}`, pressed: segment.getAttribute("aria-pressed"), fill: w.__fill(segment) as string, words: w.__seen(segment, look.color) as string, contrast: w.__contrast(segment) as number, shadow: look.boxShadow !== "none", opacity: look.opacity };
				}),
			};
		});
		await page.mouse.move(5, 5);
		const track = await readTrack();
		same([track.track, track.toRowEnd], [[32, "2px", "8px"], 0], `${at}: a 32 px track, 2 px in, radius 8, ending on the card's padding`);
		same(track.segments.map((segment) => [segment.height, segment.radius, segment.font]), track.segments.map(() => [28, "6px", "13px/20px 500"]), `${at}: 28 px segments, radius 6, 13/20 at 500`);
		const chosen = track.segments.find((segment) => segment.pressed === "true")!;
		const other = track.segments.find((segment) => segment.pressed === "false")!;
		same(track.segments.map((segment) => contrast(segment.fill, "#000000") > contrast(track.fill, "#000000")), track.segments.map((segment) => segment.pressed === "true"), `${at}: the chosen segment lighter than the track, the others not`);
		nearColour(chosen.fill, want.chosen, `${at}: the chosen segment's fill`);
		assert(chosen.contrast >= 4.5, `${at}: the chosen segment's words at ${chosen.contrast.toFixed(2)}:1, under 4.5`);
		assert(chosen.shadow, `${at}: the chosen segment carries the small shadow`);
		nearColour(chosen.words, want.text, `${at}: the chosen segment's words`);
		nearColour(other.fill, tint(theme, 0.08), `${at}: the track's fill around the others`);
		// Muted words on the track fall under 4.5:1 in dark, so dark's are a step lighter, and so is its hover.
		const [otherRest, otherUnder] = theme === DARK ? [want.soft, want.text] : [want.muted, want.soft];
		nearColour(other.words, otherRest, `${at}: the other segments' words`);
		const otherContrast = await segments.filter({ hasNotText: /^System$/ }).first().evaluate((segment) => (window as any).__contrast(segment) as number);
		assert(otherContrast >= 4.5, `${at}: the other segments' words at ${otherContrast.toFixed(2)}:1, under 4.5`);
		const otherButton = segments.filter({ hasNotText: /^System$/ }).first();
		await otherButton.hover();
		nearColour((await settled(readTrack, (read) => read.segments.some((segment) => segment.pressed === "false" && segment.words === otherUnder), "the hover settles")).segments.find((segment) => segment.pressed === "false" && segment.words !== otherRest)?.words ?? "", otherUnder, `${at}: a segment under the pointer`);
		// Pressed, then let go on the page's title, so nothing is chosen (let go on the veil, the click would close the window).
		await page.mouse.down();
		// The quiet fill over the track's own.
		const heldFill = tint(theme, 1 - 0.92 ** 2);
		const held = (await settled(readTrack, (read) => read.segments.some((segment) => segment.pressed === "false" && segment.fill === heldFill), "the press settles")).segments.find((segment) => segment.pressed === "false" && segment.fill !== other.fill);
		nearColour(held?.fill ?? "", heldFill, `${at}: a segment pressed, its fill`);
		nearColour(held?.words ?? "", want.text, `${at}: a segment pressed, its words`);
		await visible(page, ".pane-head h2").hover();
		await page.mouse.up();
		await keyboardTo(page, segments.first());
		same(await ringOf(segments.first()), [true, "solid", "2px"], `${at}: the keyboard's ring on the segment`);
		// The keyboard still chooses: Tab to the next, Space presses it; then back.
		const pressed = async () => JSON.stringify(await segments.evaluateAll((buttons) => buttons.map((button) => button.getAttribute("aria-pressed"))));
		const before = await pressed();
		await page.keyboard.press("Tab");
		await page.keyboard.press("Space");
		await waitUntil(async () => (await segments.nth(1).getAttribute("aria-pressed")) === "true", `${at}: Space chooses the focused segment`);
		await segments.first().focus();
		await page.keyboard.press("Space");
		await waitUntil(async () => (await pressed()) === before, `${at}: Space chooses the first again`);
		await otherButton.evaluate((button) => { (button as HTMLButtonElement).disabled = true; });
		same((await readTrack()).segments.filter((segment) => segment.opacity === "0.45").length, 1, `${at}: a disabled segment`);
		await otherButton.evaluate((button) => { (button as HTMLButtonElement).disabled = false; });

		// The radios: Web search's engines, each a row of its own.
		await goToPage(page, "Web search");
		at = `${theme}, Web search, the radios`;
		const radios = page.locator(".settings-dialog-pane .settings-row-choice input[type=radio]");
		await radios.first().waitFor({ timeout: 10000 });
		const readRadios = () => radios.evaluateAll((inputs) => inputs.map((input) => {
			const w = window as any;
			const style = getComputedStyle(input);
			const dot = getComputedStyle(input, "::after");
			const row = input.closest(".settings-row-choice")!;
			return { checked: (input as HTMLInputElement).checked, toLabel: row.querySelector(".settings-row-main")!.getBoundingClientRect().left - input.getBoundingClientRect().right, size: [input.getBoundingClientRect().width, input.getBoundingClientRect().height], ring: w.__seen(input, style.borderTopColor) as string, dot: (input as HTMLInputElement).checked ? [dot.width, dot.height, w.__seen(input, dot.backgroundColor)] : null, rowHeight: row.getBoundingClientRect().height, rowTint: w.__seen(row, getComputedStyle(row, "::before").backgroundColor) as string, rowFill: w.__fill(row) as string, opacity: style.opacity };
		}));
		await page.mouse.move(5, 5);
		const rest = await readRadios();
		const on = rest.find((radio) => radio.checked)!;
		const off = rest.find((radio) => !radio.checked)!;
		same([on.size, off.size, on.dot?.slice(0, 2)], [[16, 16], [16, 16], ["8px", "8px"]], `${at}: 16 px rings, an 8 px centre in the chosen one`);
		same(rest.map((radio) => radio.toLabel), rest.map(() => 12), `${at}: 12 px from the ring to its words`);
		nearColour(off.ring, want.field, `${at}: an empty ring`);
		nearColour(on.ring, want.ink, `${at}: the chosen ring`);
		nearColour(String(on.dot?.[2]), want.ink, `${at}: the chosen centre`);
		assert(rest.every((radio) => radio.rowHeight >= 56), `${at}: rows at least 56 tall, got ${rest.map((radio) => radio.rowHeight).join(", ")}`);
		same(await page.getByRole("radio", { name: /DuckDuckGo/ }).count(), 1, `${at}: a radio named by its row`);
		const offRow = page.locator(".settings-dialog-pane .settings-row-choice").filter({ has: page.locator("input[type=radio]:not(:checked)") }).first();
		await offRow.hover();
		const hovered = (await settled(readRadios, (read) => read.some((radio) => radio.rowTint === tint(theme, theme === LIGHT ? 0.03 : 0.04)), "the hover settles")).find((radio) => radio.rowTint !== radio.rowFill);
		nearColour(hovered?.rowTint ?? "", tint(theme, theme === LIGHT ? 0.03 : 0.04), `${at}: a row under the pointer`);
		// Pressed, then let go on the page's title, so the choice stays.
		const press = tint(theme, theme === LIGHT ? 0.06 : 0.08);
		await page.mouse.down();
		nearColour((await settled(readRadios, (read) => read.some((radio) => radio.rowTint === press), "the press settles")).find((radio) => radio.rowTint !== radio.rowFill)?.rowTint ?? "", press, `${at}: a row pressed`);
		await visible(page, ".pane-head h2").hover();
		await page.mouse.up();
		same((await readRadios()).map((radio) => radio.checked), rest.map((radio) => radio.checked), `${at}: let go away from the row, the choice stays`);
		const chosenRadio = page.locator(".settings-dialog-pane .settings-row-choice input[type=radio]:checked");
		await keyboardTo(page, chosenRadio);
		same(await ringOf(chosenRadio), [true, "solid", "2px"], `${at}: the keyboard's ring`);
		await radios.first().evaluate((input) => { (input as HTMLInputElement).disabled = true; });
		same((await readRadios())[0].opacity, "0.45", `${at}: a disabled radio`);
		await radios.first().evaluate((input) => { (input as HTMLInputElement).disabled = false; });
		await closeWindow(page);

		// The slider: Memory's budget, ink, its value in a 72 px slot.
		await openWindow(page, "room");
		await goToPage(page, "Memory");
		at = `${theme}, Memory, the slider`;
		const slider = page.locator(".settings-dialog-pane").getByRole("slider").filter({ visible: true }).first();
		await waitUntil(async () => !(await slider.isDisabled()), `${at}: the budget is read`);
		const readSlider = () => slider.evaluate((input) => {
			const value = input.parentElement!.querySelector(".memory-budget-value")!;
			const look = getComputedStyle(value);
			const box = input.getBoundingClientRect();
			const slot = value.getBoundingClientRect();
			const row = input.closest(".settings-row")!.getBoundingClientRect();
			return { width: box.width, accent: getComputedStyle(input).accentColor, gap: slot.left - box.right, slot: [slot.width, look.textAlign, `${look.fontSize} ${look.fontWeight}`, look.fontVariantNumeric], toRowEnd: row.right - slot.right, value: value.textContent };
		});
		const read = await readSlider();
		same([read.width, read.gap, read.slot, read.toRowEnd], [200, 12, [72, "right", "13px 500", "tabular-nums"], 0], `${at}: 200 wide, 12 to a 72 px slot of tabular figures on the row's end`);
		same(read.accent, await computed(page, want.ink), `${at}: in ink`);
		await checkSliderDrawn(page, slider, theme, at);
		// Under the pointer the thumb's edge turns ink: read on the thumb's right edge, across its middle.
		const thumbEdge = async () => {
			const { part, width, middle } = await slider.evaluate((input) => { const range = input as HTMLInputElement; const box = range.getBoundingClientRect(); return { part: (Number(range.value) - Number(range.min)) / (Number(range.max) - Number(range.min)), width: box.width, middle: box.height / 2 }; });
			return (await pixelsOf(page, slider, [[8 + (width - 16) * part + 7.5, middle]]))[0];
		};
		// A 1 px round edge is blended with the thumb's white where the pixels cut it: near, not equal.
		const apart = (one: string, other: string) => Math.max(...[1, 3, 5].map((i) => Math.abs(parseInt(one.slice(i, i + 2), 16) - parseInt(other.slice(i, i + 2), 16))));
		const edgeAtRest = await thumbEdge();
		assert(apart(edgeAtRest, want.field) <= 24, `${at}: the thumb's edge at rest the field's edge, got ${edgeAtRest}`);
		await slider.hover();
		const edgeUnder = await settled(thumbEdge, (seen) => apart(seen, want.ink) <= 24, "the hover settles");
		assert(apart(edgeUnder, want.ink) <= 24, `${at}: the thumb's edge ink under the pointer, got ${edgeUnder}`);
		await page.mouse.move(5, 5);
		await slider.evaluate((input) => { (input as HTMLInputElement).disabled = true; });
		same(await slider.evaluate((input) => getComputedStyle(input).opacity), "0.45", `${at}: disabled, as while the budget is read`);
		await slider.evaluate((input) => { (input as HTMLInputElement).disabled = false; });
		await keyboardTo(page, slider);
		same(await ringOf(slider), [true, "solid", "2px"], `${at}: the keyboard's ring`);
		await page.keyboard.press("ArrowRight");
		const moved = await readSlider();
		assert(moved.value !== read.value && moved.width === read.width && moved.gap === read.gap, `${at}: the keyboard moves it (${read.value} to ${moved.value}) and nothing moves with the number`);
		await page.keyboard.press("ArrowLeft");
		await waitUntil(async () => (await readSlider()).value === read.value, `${at}: and back`);
		await page.context().close();
	}
	// On a phone a segmented choice that drops under its words takes the row's width, in equal segments; so do the radios' 12 px.
	const page = await openPage(browser, phone(LIGHT), "on");
	await openWindow(page, "settings");
	for (const label of ["Appearance", "Remote access"]) {
		await goToPage(page, label);
		const at = `phone, ${label}, the segmented choice`;
		const track = visible(page, ".settings-dialog-pane .settings-segments");
		await track.waitFor();
		const read = await track.evaluate((element) => {
			const row = element.closest(".settings-row")!.getBoundingClientRect();
			return { width: element.getBoundingClientRect().width, row: row.width, segments: [...element.children].map((segment) => Math.round(segment.getBoundingClientRect().width)) };
		});
		same(read.width, read.row, `${at}: the row's full width`);
		assert(Math.max(...read.segments) - Math.min(...read.segments) <= 1, `${at}: equal segments, got ${read.segments.join(", ")}`);
	}
	await goToPage(page, "Web search");
	same(await visible(page, ".settings-dialog-pane .settings-row-choice").evaluate((row) => row.querySelector(".settings-row-main")!.getBoundingClientRect().left - row.querySelector("input")!.getBoundingClientRect().right), 12, "phone, Web search: 12 px from the ring to its words");
	// The slider is 44 tall to a finger, drawn across its middle.
	await closeWindow(page);
	await openWindow(page, "room");
	await goToPage(page, "Memory");
	// Read in the window once it shows the look, as the room's window takes it on as it opens.
	const slider = page.locator(".settings-dialog.settings-look-next .settings-dialog-pane").getByRole("slider").filter({ visible: true }).first();
	await waitUntil(async () => !(await slider.isDisabled()), "phone, Memory, the slider: the budget is read");
	same(await slider.evaluate((input) => input.getBoundingClientRect().height), 44, "phone, Memory, the slider: 44 tall to a finger");
	await checkSliderDrawn(page, slider, LIGHT, "phone, Memory, the slider");
	await page.context().close();
	console.log("  ok  choices: the segmented choice a 32 px track of 28 px segments, the chosen one lighter than it, white in light, with the small shadow, ending on the card's padding; radios 16 px with an 8 px ink centre 12 px before their words on rows that tint under the pointer and deeper pressed; a segment under the pointer and pressed; on a phone a dropped choice the row's width in equal segments; the slider a 4 px soft track, ink up to a 16 px thumb whose edge turns ink under the pointer, disabled at 45 %, 200 wide (44 tall to a finger), its value in a 72 px slot; each still a group of pressed buttons, a named radio or a slider, with its ring and its keys, both themes");
}

async function checkMenu(browser: Browser): Promise<void> {
	for (const [theme, options] of [[LIGHT, desktop(1440, 900, LIGHT)], [DARK, desktop(1440, 900, DARK)], [LIGHT, phone(LIGHT)]] as const) {
		const page = await openPage(browser, options, "on");
		await installColourTools(page);
		const onPhone = isPhone(page);
		const at = `${theme}${onPhone ? ", phone" : ""}, an AI profile's menu`;
		await openWindow(page, "settings");
		await goToPage(page, "AI setup");
		// The made-up profile's menu: a built-in one has no red item.
		const button = page.getByRole("button", { name: "Manage Synthetic" }).filter({ visible: true }).first();
		await button.waitFor({ timeout: 10000 });
		await button.click();
		const menu = page.locator(".ai-profile-menu");
		await menu.waitFor();
		const readMenu = () => page.evaluate(() => {
			const w = window as any;
			const menu = document.querySelector(".ai-profile-menu")!;
			const style = getComputedStyle(menu);
			const box = menu.getBoundingClientRect();
			const anchor = document.querySelector("[aria-haspopup=menu][aria-expanded=true]")!.getBoundingClientRect();
			const frame = document.querySelector(".settings-dialog")!.getBoundingClientRect();
			return {
				radius: style.borderTopLeftRadius, padding: style.paddingTop, width: box.width,
				// Under its button, or over it where the menu's own code finds more room above (ai-profile-switcher.tsx).
				gap: Math.round((box.top >= anchor.bottom ? box.top - anchor.bottom : anchor.top - box.bottom) * 10) / 10, rightToRight: Math.round((box.right - anchor.right) * 10) / 10,
				inside: box.left >= frame.left && box.right <= frame.right,
				fill: w.__fill(menu) as string,
				items: [...menu.querySelectorAll(".ai-profile-menu-item")].map((item) => {
					const look = getComputedStyle(item);
					return { name: item.textContent, height: item.getBoundingClientRect().height, font: `${look.fontSize} ${look.fontWeight}`, fill: w.__fill(item) as string, words: w.__seen(item, look.color) as string, red: item.classList.contains("danger"),
						line: getComputedStyle(item, "::before").content !== "none", opacity: look.opacity };
				}),
			};
		});
		await page.mouse.move(5, 5);
		const rest = await readMenu();
		same([rest.radius, rest.padding, rest.inside], ["12px", "4px", true], `${at}: radius 12, inside the window`);
		same([rest.gap, rest.rightToRight], [6, 0], `${at}: 6 px from its button, their right edges together`);
		assert(rest.width >= 200 && rest.width <= 280, `${at}: ${rest.width} px wide`);
		nearColour(rest.fill, CONTROL[theme].card, `${at}: its fill`);
		same(rest.items.map((item) => [item.height, item.font]), rest.items.map(() => [onPhone ? 44 : 32, "13px 400"]), `${at}: items ${onPhone ? 44 : 32} tall, 13 px`);
		const red = rest.items.find((item) => item.red);
		assert(red && red === rest.items.at(-1) && red.line, `${at}: the red item last, under a line`);
		same(await readInkAndColour(page, ".ai-profile-menu", CONTROL[theme].ink), { inked: [], coloured: [] }, `${at}: no ink button, colour only on the red item`);
		if (!onPhone) {
			const first = menu.locator(".ai-profile-menu-item").first();
			await first.hover();
			nearColour((await settled(readMenu, (read) => read.items[0].fill === tint(theme, 0.08), "the hover settles")).items[0].fill, tint(theme, 0.08), `${at}: an item under the pointer`);
			await menu.locator(".ai-profile-menu-item.danger").hover();
			const redHover = (await settled(readMenu, (read) => read.items.at(-1)!.fill === tint(theme, 0.08), "the hover settles")).items.at(-1)!;
			same(redHover.words, red.words, `${at}: the red item stays red under the pointer`);
			await first.hover();
			// Pressed, then let go away from it so nothing is chosen; the press left the focus on it, so Escape is the menu's.
			await page.mouse.down();
			nearColour((await settled(readMenu, (read) => read.items[0].fill === tint(theme, 0.12), "the press settles")).items[0].fill, tint(theme, 0.12), `${at}: an item pressed`);
			await page.mouse.move(5, 5);
			await page.mouse.up();
			await page.keyboard.press("Escape");
			await menu.waitFor({ state: "detached" });
			// By keyboard, on Connectors' Add connector menu, which takes the focus into its items (AI setup's menu has no keys of its own): its button opens it on its first item, with the ring and the fill.
			await goToPage(page, "Connectors");
			const addButton = visible(page, ".connector-add-btn");
			await addButton.waitFor({ timeout: 10000 });
			await addButton.focus();
			await page.keyboard.press("Enter");
			await menu.waitFor();
			const item = menu.locator(".ai-profile-menu-item").first();
			await waitUntil(async () => item.evaluate((element) => element === document.activeElement), `${at}: the keyboard lands on the first item`);
			same(await ringOf(item), [true, "solid", "2px"], `${at}: the keyboard's ring on an item`);
			nearColour((await settled(readMenu, (read) => read.items[0].fill === tint(theme, 0.08), "the fill settles")).items[0].fill, tint(theme, 0.08), `${at}: an item with the keyboard`);
			await item.evaluate((element) => { (element as HTMLButtonElement).disabled = true; });
			same((await readMenu()).items[0].opacity, "0.45", `${at}: a disabled item`);
			// Disabling it took its focus; back on it, Escape is the menu's again.
			await item.evaluate((element) => { (element as HTMLButtonElement).disabled = false; });
			await item.focus();
			await page.keyboard.press("Escape");
			await menu.waitFor({ state: "detached" });
			assert(await addButton.evaluate((element) => element === document.activeElement), `${at}: Escape gives the focus back to its button`);
		}
		await page.context().close();
	}
	console.log("  ok  menu: opened from a settings window, radius 12, 200 to 280 wide, 6 px under its button, items 32 tall (44 to a finger), hover, pressed, the keyboard's ring and disabled, the red item last under a line and the only colour, no ink button, inside the window at 390, both themes");
}

/** The question on screen: its look, where the focus is and its answers in order. */
async function readQuestion(page: Page) {
	return page.evaluate(() => {
		const w = window as any;
		const backdrop = document.querySelector(".confirm-dialog-backdrop")!;
		const card = backdrop.querySelector(".maintain-confirm-card")!;
		const style = getComputedStyle(card);
		const title = getComputedStyle(card.querySelector("h2")!);
		const body = card.querySelector("p");
		const box = card.getBoundingClientRect();
		const answers = [...card.querySelectorAll(".checkpoint-preview-actions button")];
		return {
			look: backdrop.classList.contains("settings-look-next"),
			veil: getComputedStyle(backdrop).backgroundColor,
			card: [box.width, style.borderTopLeftRadius, style.paddingTop, w.__fill(card)],
			title: `${title.fontFamily.split(",")[0]} ${title.fontSize}/${title.lineHeight} ${title.fontWeight}`,
			body: body ? `${getComputedStyle(body).fontSize}/${getComputedStyle(body).lineHeight} ${w.__seen(body, getComputedStyle(body).color)}` : null,
			wrap: body ? getComputedStyle(body).getPropertyValue("text-wrap-style") : null,
			answers: answers.map((answer) => answer.textContent),
			focused: document.activeElement?.textContent ?? null,
			red: answers.filter((answer) => answer.classList.contains("rs-btn-danger")).map((answer) => answer.textContent),
			boxes: answers.map((answer) => { const at = answer.getBoundingClientRect(); return { top: Math.round(at.top), left: Math.round(at.left), right: Math.round(at.right), width: Math.round(at.width) }; }),
			cardRight: Math.round(box.right - parseFloat(style.paddingRight) - parseFloat(style.borderRightWidth)),
			cardInner: Math.round(box.width - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight) - 2),
		};
	});
}

async function checkQuestion(browser: Browser): Promise<void> {
	for (const [theme, options] of [[LIGHT, desktop(1440, 900, LIGHT)], [DARK, desktop(1440, 900, DARK)], [LIGHT, phone(LIGHT)]] as const) {
		const page = await openPage(browser, options, "on");
		await installColourTools(page);
		const want = CONTROL[theme];
		const onPhone = isPhone(page);
		const where = `${theme}${onPhone ? ", phone" : ""}`;
		const width = onPhone ? 390 - 32 : 400;
		const question = page.locator(".confirm-dialog-backdrop");
		await openWindow(page, "room");

		// A destructive question: Delete room. It is never answered yes here.
		await goToPage(page, "Archive or delete");
		let at = `${where}, Delete room's question`;
		await visible(page, ".settings-dialog-pane button.rs-btn-danger").click();
		await question.waitFor();
		const red = await readQuestion(page);
		same([red.look, red.veil, red.card.slice(0, 3), red.title, red.answers, red.focused, red.red], [true, await computed(page, want.veil), [width, "16px", "24px"], "Sen 18px/24px 700", ["Cancel", "Delete room"], "Cancel", ["Delete room"]], `${at}: the look, ${width} wide on its veil, the safe answer first with the focus as today, the red one last`);
		nearColour(String(red.card[3]), want.card, `${at}: its fill`);
		same(await readInkAndColour(page, ".confirm-dialog-backdrop .maintain-confirm-card", want.ink), { inked: [], coloured: [] }, `${at}: no ink button, colour only on the red one`);
		assert(red.body?.startsWith("14px/20px"), `${at}: its words 14/20, got ${red.body}`);
		nearColour(String(red.body?.split(" ").at(-1)), want.soft, `${at}: its words in soft text`);
		same(red.wrap, "pretty", `${at}: its words wrap with no word left alone on the last line`);
		if (onPhone) {
			same(red.boxes.map((box) => box.width), [red.cardInner, red.cardInner], `${at}: the answers full width`);
			assert(red.boxes[1].top < red.boxes[0].top, `${at}: the confirming answer on top`);
		} else {
			same([red.boxes[0].top === red.boxes[1].top, red.boxes[1].left - red.boxes[0].right, red.boxes[1].right], [true, 8, red.cardRight], `${at}: side by side, 8 apart, at the right`);
		}
		// Enter on the focused safe answer and Escape keep the room.
		await page.keyboard.press("Enter");
		await question.waitFor({ state: "detached" });
		await visible(page, ".settings-dialog-pane button.rs-btn-danger").click();
		await question.waitFor();
		await page.keyboard.press("Escape");
		await question.waitFor({ state: "detached" });
		assert(await page.locator(".settings-dialog").count() === 1, `${at}: Enter on Cancel and Escape each leave the window open`);

		// A plain question with three answers: unsaved instructions when the window closes.
		await goToPage(page, "Instructions");
		at = `${where}, the unsaved instructions' question`;
		const box = visible(page, ".settings-dialog-pane textarea");
		const typed = `Answer in short lines, ${theme}${onPhone ? " phone" : ""}.`;
		await box.fill(typed);
		const ask = async () => { await page.locator(".settings-dialog-close").filter({ visible: true }).first().click(); await question.waitFor(); };
		await ask();
		const plain = await readQuestion(page);
		same([plain.look, plain.card.slice(0, 3), plain.answers, plain.focused, plain.red], [true, [width, "16px", "24px"], ["Keep editing", "Close without saving", "Save and close"], "Save and close", []], `${at}: the look, the safe answer first, the focus on the confirming answer as today, no red`);
		same(plain.boxes.map((answer) => answer.width), [plain.cardInner, plain.cardInner, plain.cardInner], `${at}: three answers full width`);
		assert(plain.boxes[2].top < plain.boxes[1].top && plain.boxes[1].top < plain.boxes[0].top, `${at}: the confirming answer on top`);
		same(await readInkAndColour(page, ".confirm-dialog-backdrop .maintain-confirm-card", want.ink), { inked: ['button.rs-btn.rs-btn-primary "Save and close"'], coloured: [] }, `${at}: one ink button, no colour`);
		if (!onPhone) {
			// Its answers are the button family's: a fill under the pointer, a deeper one pressed, the keyboard's ring, disabled at 45 %.
			const keep = question.getByRole("button", { name: "Keep editing" });
			const fillOf = () => keep.evaluate((button) => (window as any).__fill(button) as string);
			await page.mouse.move(5, 5);
			nearColour(await fillOf(), tint(theme, 0.08), `${at}: Keep editing's fill at rest`);
			await keep.hover();
			nearColour(await settled(fillOf, (fill) => fill === tint(theme, 0.12), "the hover settles"), tint(theme, 0.12), `${at}: Keep editing under the pointer`);
			await page.mouse.down();
			nearColour(await settled(fillOf, (fill) => fill === tint(theme, 0.16), "the press settles"), tint(theme, 0.16), `${at}: Keep editing pressed`);
			// Let go on the question's title, so nothing is answered.
			await question.locator("h2").hover();
			await page.mouse.up();
			same(await question.count(), 1, `${at}: let go away from it, the question stays`);
			await keyboardTo(page, keep);
			same(await ringOf(keep), [true, "solid", "2px"], `${at}: the keyboard's ring on Keep editing`);
			await keep.evaluate((button) => { (button as HTMLButtonElement).disabled = true; });
			same(await keep.evaluate((button) => getComputedStyle(button).opacity), "0.45", `${at}: a disabled answer`);
			await keep.evaluate((button) => { (button as HTMLButtonElement).disabled = false; });
		}
		// Enter as today: on a focused answer it is that answer; anywhere else in the question, the confirming one.
		await question.getByRole("button", { name: "Keep editing" }).focus();
		await page.keyboard.press("Enter");
		await question.waitFor({ state: "detached" });
		same(await box.inputValue(), typed, `${at}: Enter on a focused Keep editing keeps the words and the window`);
		await ask();
		await page.keyboard.press("Escape");
		await question.waitFor({ state: "detached" });
		same([await page.locator(".settings-dialog").count(), await box.inputValue()], [1, typed], `${at}: Escape keeps editing`);
		// Enter right after the question opens saves the words and closes the window.
		await ask();
		await page.keyboard.press("Enter");
		await page.locator(".settings-dialog").waitFor({ state: "detached", timeout: 10000 });
		await openWindow(page, "room");
		await goToPage(page, "Instructions");
		// The box fills in from its own request.
		const saved = visible(page, ".settings-dialog-pane textarea");
		await waitUntil(async () => (await saved.inputValue()) === typed, `${at}: Enter right after it opens saves and closes`);
		await page.context().close();
	}
	console.log("  ok  question: asked from a settings window, 400 wide (the screen less 16 a side on a phone), radius 16, on the 28 % veil (50 % black in dark), the safe answer first, the focus on the confirming answer (on Cancel when it is a destructive one, which keeps its red answer), as today; Enter on the focused answer is that answer, elsewhere the confirming one, and Escape the safe one; three answers stack with the confirming one on top; at most one ink button and colour only on the red one; its answers the button family's, with hover, pressed, the keyboard's ring and disabled");
}

async function checkInfoMark(browser: Browser): Promise<void> {
	for (const options of [desktop(1440, 900, LIGHT), phone(LIGHT)]) {
		const page = await openPage(browser, options, "on");
		await installColourTools(page);
		const onPhone = isPhone(page);
		const at = `${onPhone ? "phone" : "desktop"}, Memory's info mark`;
		await openWindow(page, "room");
		await goToPage(page, "Memory");
		const mark = page.locator(".settings-dialog-pane").getByRole("button", { name: "More information" }).filter({ visible: true }).first();
		await mark.waitFor({ timeout: 10000 });
		const look = await mark.evaluate((button) => {
			const box = button.getBoundingClientRect();
			const svg = button.querySelector("svg")?.getBoundingClientRect();
			const lands = (x: number, y: number) => button.contains(document.elementFromPoint(x, y));
			const out = 7;
			return {
				box: [box.width, box.height], mark: svg ? [svg.width, svg.height] : null, after: getComputedStyle(button.parentElement!).marginLeft,
				reach: [lands(box.left + box.width / 2, box.top - out), lands(box.left + box.width / 2, box.bottom + out), lands(box.left - out, box.top + box.height / 2), lands(box.right + out, box.top + box.height / 2)],
			};
		});
		same([look.box, look.mark, look.after], [[28, 28], [16, 16], "4px"], `${at}: a 16 px mark in a 28 px button, 4 px after the words`);
		same(look.reach, onPhone ? [true, true, true, true] : [false, false, false, false], `${at}: ${onPhone ? "44 px to a finger" : "28 px to the pointer"}`);
		// The mark's line is no taller for it and holds its words as without it: the help 22 under the label, as under Memory budget, and the second label on one line on a phone too.
		const lines = await page.locator(".settings-dialog-pane .settings-rows").filter({ visible: true }).first().evaluate((list) => [...list.querySelectorAll(".settings-row")].map((row) => {
			const label = row.querySelector(".settings-row-label")!.getBoundingClientRect();
			const help = row.querySelector(".settings-row-sub")?.getBoundingClientRect();
			return { mark: row.querySelector(".rs-info") !== null, height: label.height, help: help ? help.top - label.bottom : null };
		}));
		same(lines.map((line) => [line.mark, line.height % 20, line.help]), [[true, 0, 2], [true, 0, null], [false, 0, 2]], `${at}: each label on 20 px lines, its help 2 under it, with the mark or without`);
		same(lines[1].height, 20, `${at}: "Remember without the preview" and its mark on one line`);
		if (!onPhone) {
			// Quiet at rest; under the pointer, and pressed, the open fill and the text colour.
			const markLook = () => mark.evaluate((button) => { const w = window as any; return { fill: w.__fill(button) as string, words: w.__seen(button, getComputedStyle(button).color) as string }; });
			await page.mouse.move(5, 5);
			const markRest = await markLook();
			nearColour(markRest.fill, CONTROL[LIGHT].card, `${at}: no fill at rest`);
			nearColour(markRest.words, CONTROL[LIGHT].muted, `${at}: muted at rest`);
			const open = { fill: tint(LIGHT, 0.12), words: CONTROL[LIGHT].text };
			await mark.hover();
			const markUnder = await settled(markLook, (read) => read.fill === open.fill && read.words === open.words, "the hover settles");
			same([markUnder.fill, markUnder.words], [open.fill, open.words], `${at}: under the pointer, the open fill and the text colour`);
			await page.mouse.down();
			const markHeld = await settled(markLook, (read) => read.fill === open.fill, "the press settles");
			same([markHeld.fill, markHeld.words], [open.fill, open.words], `${at}: pressed, the same`);
			// Let go on the page's title, so the window stays.
			await visible(page, ".pane-head h2").hover();
			await page.mouse.up();
			await mark.evaluate((button) => (button as HTMLElement).blur());
		}
		// A click focuses the button in this browser and then toggles it shut; the focus alone opens it.
		if (onPhone) await mark.focus(); else await keyboardTo(page, mark);
		const tip = page.locator(".rs-info-tip");
		await tip.waitFor();
		if (!onPhone) same([...await ringOf(mark), await mark.evaluate((button) => getComputedStyle(button).outlineOffset)], [true, "solid", "2px", "-2px"], `${at}: the keyboard's ring, inside the button so it stays clear of the words, and the keyboard opens it`);
		const bubble = await tip.evaluate((element) => {
			const style = getComputedStyle(element);
			const box = element.getBoundingClientRect();
			const row = element.closest(".settings-row")!;
			const label = row.querySelector(".settings-row-label")!.getBoundingClientRect();
			const help = row.querySelector(".settings-row-sub")!.getBoundingClientRect();
			const button = row.querySelector(".rs-info")!.getBoundingClientRect();
			const toggle = row.querySelector("input[type=checkbox]")!.getBoundingClientRect();
			const others = [...document.querySelectorAll(".settings-dialog-pane .rs-info")].filter((mark) => !row.contains(mark)).map((mark) => mark.getBoundingClientRect())
				.filter((mark) => mark.top >= box.top && mark.bottom <= box.bottom && mark.left >= box.left && mark.right <= box.right);
			return {
				radius: style.borderTopLeftRadius, font: `${style.fontSize}/${style.lineHeight}`, fill: (window as any).__fill(element), shadow: style.boxShadow !== "none", width: box.width, inside: box.left >= 0 && box.right <= window.innerWidth, role: element.getAttribute("role"),
				fromLineFoot: box.top <= help.top && box.top >= label.bottom - 0.5, buttonOnTop: row.querySelector(".rs-info")!.contains(document.elementFromPoint(button.left + button.width / 2, button.bottom - 1)),
				clearOfSwitch: box.right <= toggle.left - 8 || box.top >= toggle.bottom, othersUnder: others.every((mark) => element.contains(document.elementFromPoint(mark.left + mark.width / 2, mark.top + mark.height / 2))),
			};
		});
		same([bubble.fromLineFoot, bubble.buttonOnTop, bubble.clearOfSwitch, bubble.othersUnder], [true, true, true, true], `${at}: the bubble opens at the line's foot over the help line whole, under its own button, clear of the switch, over every other mark`);
		same([bubble.radius, bubble.font, bubble.shadow, bubble.inside, bubble.role], ["12px", "13px/18px", true, true, "tooltip"], `${at}: its bubble drawn as a menu, 13/18, on the screen`);
		// On a phone it starts at its row's left edge instead, so a mark near the edge never pushes it off the screen.
		assert(bubble.width <= 280, `${at}: the bubble ${bubble.width} px wide`);
		nearColour(bubble.fill, CONTROL[LIGHT].card, `${at}: the bubble's fill`);
		await page.context().close();
	}
	console.log("  ok  info mark: a 16 px mark in a 28 px quiet button 4 px after its words, the open fill under the pointer and pressed, 44 px to a finger, still a button named More information that the keyboard opens, its line no taller and its words on one line as without it; its bubble drawn as a menu at most 280 wide, from the line's foot over the help, under its own button, clear of the switch");
}

/** Everything that decides how a part looks, element by element, for two renders side by side; read once its fades have ended and its fonts are in (a weight first used by the part is fetched then, and its words change width when it lands). */
async function lookOf(page: Page, selector: string): Promise<string[]> {
	await waitUntil(() => page.evaluate(() => document.getAnimations().every((animation) => animation.playState !== "running")), `${selector}: its fades end`);
	await waitUntil(() => page.evaluate(() => document.fonts.status === "loaded"), `${selector}: its fonts are in`);
	return page.evaluate((root) => {
		const top = document.querySelector(root);
		if (!top) return [`no ${root}`];
		const properties = ["color", "background-color", "background-image", "border-top", "border-right", "border-bottom", "border-left", "border-radius", "box-shadow", "font-family", "font-size", "font-weight", "line-height", "padding", "margin", "opacity", "outline", "width", "height", "accent-color", "backdrop-filter"];
		return [top, ...top.querySelectorAll("*")].map((element) => {
			const style = getComputedStyle(element);
			return `${element.tagName.toLowerCase()}.${element.getAttribute("class") ?? ""} ${properties.map((name) => style.getPropertyValue(name)).join(" | ")}`;
		});
	}, selector);
}

async function checkOutside(browser: Browser): Promise<void> {
	const read: Record<string, Record<string, string[] | string>> = { off: {}, on: {} };
	for (const look of ["off", "on"] as const) {
		const seen = read[look];
		const home = await openPage(browser, desktop(1440, 900), look);
		// The gear's menu, with its own theme choice.
		await home.locator(".product-sidebar-footer button, .home-gear, button[aria-label='Settings']").first().click();
		await home.locator(".sidebar-config-menu").waitFor();
		seen["the gear's menu"] = await lookOf(home, ".sidebar-config-menu");
		await home.keyboard.press("Escape");
		// Create a room, its name field with the focus.
		await home.getByRole("button", { name: "Create a new room" }).click();
		const form = home.locator(".create-room-overlay");
		await form.waitFor();
		await form.locator("input").first().focus();
		seen["Create a room"] = await lookOf(home, ".create-room-overlay");
		await home.context().close();
		// Maintain, then Review's choice of how much to tidy (shown without a first read too, so the model need not answer).
		const maintain = await openPage(browser, desktop(1440, 900), look);
		requestsFromNow(maintain);
		await maintain.locator(".persistent-agent-card").filter({ hasText: ROOM }).getByRole("button", { name: /^Maintain/ }).click();
		await maintain.locator(".maintain-workspace").waitFor({ timeout: 10000 });
		await answered(maintain, `${look}, Maintain`);
		seen["Maintain"] = await lookOf(maintain, ".maintain-workspace");
		await maintain.locator(".maintain-action").filter({ hasText: "Review" }).click();
		await maintain.getByRole("radiogroup", { name: "How much to tidy" }).waitFor({ timeout: 20000 });
		await answered(maintain, `${look}, Review`);
		seen["Review's choice"] = await lookOf(maintain, ".review-workspace");
		// One message in a discussion, then Cancel: Maintain asks before the discussion goes.
		await maintain.getByRole("button", { name: "Discuss first" }).click();
		await maintain.locator(".review-workspace textarea").fill("Keep the client notes.");
		await maintain.locator(".review-workspace textarea").press("Enter");
		await answered(maintain, `${look}, the discussion`);
		await maintain.locator(".review-workspace").getByRole("button", { name: /^Cancel$/ }).click();
		await maintain.locator(".maintain-confirm-backdrop").waitFor();
		seen["a Maintain question"] = await lookOf(maintain, ".maintain-confirm-backdrop");
		seen["a Maintain question, focus"] = await maintain.evaluate(() => document.activeElement?.textContent ?? "");
		await maintain.context().close();
		// In a room with commands on: the Bash chip's menu, and the question it asks.
		const room = await openPage(browser, desktop(1440, 900), look);
		await room.locator(".persistent-agent-card").filter({ hasText: DESK_ROOM }).getByRole("button", { name: /^(Enter|Resume)$/ }).click();
		await room.locator(".bash-mode-chip").waitFor({ timeout: 15000 });
		await room.locator(".bash-mode-chip").click();
		await room.locator(".bash-mode-menu").waitFor();
		seen["the Bash chip's menu"] = await lookOf(room, ".bash-mode-menu");
		await room.locator(".bash-mode-option").filter({ has: room.locator(".bash-mode-option-name", { hasText: new RegExp(`^${MODE_NAMES.auto}$`) }) }).click();
		await room.locator(".confirm-dialog-backdrop").waitFor();
		seen["the Bash chip's question"] = await lookOf(room, ".confirm-dialog-backdrop");
		seen["the Bash chip's question, focus"] = await room.evaluate(() => document.activeElement?.textContent ?? "");
		await room.keyboard.press("Escape");
		await room.locator(".confirm-dialog-backdrop").waitFor({ state: "detached" });
		await room.context().close();
	}
	for (const place of Object.keys(read.off)) same(read.on[place], read.off[place], `switch on, ${place}: as with the switch off`);
	console.log(`  ok  outside the two windows nothing changes with the switch on: ${Object.keys(read.off).join(", ")}`);
}

/** What under `root` is a button filled with ink, and what has a colour of its own rather than a grey, as a person sees it; a status dot and a red button are let be. Needs installColourTools. */
async function readInkAndColour(page: Page, root: string, ink: string) {
	return page.evaluate(({ root, ink }) => {
		const w = window as any;
		const shown = (element: Element) => {
			const box = element.getBoundingClientRect();
			const style = getComputedStyle(element);
			return box.width > 0 && box.height > 0 && style.visibility !== "hidden" && style.opacity !== "0";
		};
		const chroma = (hex: string) => { const rgb = [1, 3, 5].map((at) => parseInt(hex.slice(at, at + 2), 16)); return Math.max(...rgb) - Math.min(...rgb); };
		const name = (element: Element) => `${element.tagName.toLowerCase()}${[...element.classList].map((one) => `.${one}`).join("")} "${(element.textContent ?? "").trim().slice(0, 24)}"`;
		const all = [...document.querySelectorAll(`${root}, ${root} *`)].filter(shown);
		const inked = all.filter((element) => element.matches("button, a, [role=button]") && w.__painted(getComputedStyle(element).backgroundColor) && w.__seen(element, getComputedStyle(element).backgroundColor) === ink).map(name);
		const coloured: string[] = [];
		for (const element of all) {
			const style = getComputedStyle(element);
			const paints: Array<[string, string]> = [];
			if ([...element.childNodes].some((node) => node.nodeType === Node.TEXT_NODE && node.textContent!.trim())) paints.push(["words", style.color]);
			if (w.__painted(style.backgroundColor)) paints.push(["fill", style.backgroundColor]);
			for (const side of ["Top", "Right", "Bottom", "Left"]) if (parseFloat(style.getPropertyValue(`border-${side.toLowerCase()}-width`)) > 0 && style.getPropertyValue(`border-${side.toLowerCase()}-style`) !== "none") paints.push(["edge", style.getPropertyValue(`border-${side.toLowerCase()}-color`)]);
			if (element instanceof SVGElement) for (const part of ["fill", "stroke"]) if (style.getPropertyValue(part) !== "none") paints.push([part, style.getPropertyValue(part)]);
			if (element.matches("input[type=checkbox], input[type=radio], input[type=range]") && style.appearance !== "none" && style.accentColor === "auto") paints.push(["the browser's own colour", "rgb(0, 102, 255)"]);
			for (const [part, colour] of paints) {
				if (!w.__painted(colour)) continue;
				const seen = w.__seen(element, colour) as string;
				if (chroma(seen) > 24 && !element.closest("[class*='-dot'], .rs-btn-danger, .ai-profile-menu-item.danger")) coloured.push(`${name(element)} ${part} ${seen}`);
			}
		}
		return { inked, coloured: [...new Set(coloured)] };
	}, { root, ink });
}
/** Words in colour that pages this task does not restyle still show with the switch on (each page's own file): the later parts give them a dot. A page that loses one fails too, so the list stays true. */
const COLOURED_TODAY: Record<string, string[]> = {
};

async function checkControlsOff(browser: Browser): Promise<void> {
	const page = await openPage(browser, desktop(1440, 900), "off");
	await openWindow(page, "room");
	await goToPage(page, "Memory");
	const mark = visible(page, ".settings-dialog-pane .rs-info");
	same(await mark.evaluate((button) => [button.textContent, button.querySelector("svg") === null]), ["i", true], "switch off: the info mark is today's letter");
	await goToPage(page, "Archive or delete");
	await visible(page, ".settings-dialog-pane button.rs-btn-danger").click();
	await page.locator(".confirm-dialog-backdrop").waitFor();
	same(await page.evaluate(() => [document.querySelector(".confirm-dialog-backdrop")!.classList.contains("settings-look-next"), document.activeElement?.textContent]), [false, "Cancel"], "switch off: Delete room's question as today, its focus on Cancel");
	await page.keyboard.press("Escape");
	await page.locator(".confirm-dialog-backdrop").waitFor({ state: "detached" });
	await goToPage(page, "Instructions");
	await visible(page, ".settings-dialog-pane textarea").fill("Off look words.");
	await page.locator(".settings-dialog-close").first().click();
	await page.locator(".confirm-dialog-backdrop").waitFor();
	same(await page.evaluate(() => [document.querySelector(".confirm-dialog-backdrop")!.classList.contains("settings-look-next"), document.activeElement?.textContent]), [false, "Save and close"], "switch off: the question as today, its focus on the confirming answer");
	await page.keyboard.press("Escape");
	await page.context().close();
	console.log("  ok  switch off: the info mark, and a plain and a destructive question asked from a window, as today");
}

let model: http.Server | undefined;
try {
	const agents = await import("../src/persistent-agents.js");
	const lookRoom = agents.createPersistentAgentFromScaffoldInput({ displayName: ROOM, userName: "Synthetic User", preferredUserAddress: "Synthetic User" }).agent.agentId;
	const deskRoom = agents.createPersistentAgentFromScaffoldInput({ displayName: DESK_ROOM, userName: "Synthetic User", preferredUserAddress: "Synthetic User" }).agent.agentId;
	// A model that answers every ask with "None.", so a room can be entered (the Bash chip lives in one) and Review reaches its choice; its key goes in through the app below.
	const modelPort = await freePort();
	model = http.createServer((req, res) => {
		req.resume();
		req.on("end", () => {
			res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
			const base = { id: "cmpl_look", object: "chat.completion.chunk", created: Math.floor(Date.now() / 1000), model: "room-model" };
			res.write(`data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: { role: "assistant", content: "None." }, finish_reason: null }] })}\n\n`);
			res.write(`data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 } })}\n\n`);
			res.end("data: [DONE]\n\n");
		});
	}).listen(modelPort, "127.0.0.1");
	const appDir = path.join(tempHome, ".exxperts", "app");
	fs.writeFileSync(path.join(agentDir, "models.json"), JSON.stringify({ providers: { synthetic: { name: "Synthetic", baseUrl: `http://127.0.0.1:${modelPort}/v1`, api: "openai-completions", models: [{ id: "room-model", name: "Room Model", input: ["text"], contextWindow: 128000, maxTokens: 16384 }] } } }));
	fs.writeFileSync(path.join(appDir, "custom-ai-profiles.json"), JSON.stringify({ version: 1, profiles: [{ id: "custom-synthetic", providerId: "synthetic", label: "Synthetic", roomModels: ["room-model"], learnModel: "room-model", reviewMemoryModel: "room-model" }] }));
	fs.writeFileSync(path.join(appDir, "persistent-agent-ai-profile.json"), JSON.stringify({ profileId: "custom-synthetic" }));
	await startServer();
	const seed = async (method: "POST" | "PUT", route: string, body: unknown): Promise<void> => {
		const answer = await authedFetch(`${baseUrl}${route}`, { method, headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
		assert(answer.ok, `seeding ${route}: ${answer.status} ${await answer.text()}`);
	};
	await seed("POST", "/api/auth/api-key", { provider: "synthetic", key: "synthetic-test-key" });
	const room = `/api/persistent-agents/${encodeURIComponent(lookRoom)}`;
	// Enough on Memory and Connectors that they scroll, and a row or two on every list.
	for (const [topic, text] of [["General", "Reports go out on Fridays."], ["Clients", "Acme prefers short summaries."], ["Style", "Plain words, short sentences."], ["People", "Dana owns the budget."]]) {
		await seed("POST", `${room}/memory/entries`, { topic, kind: "fact", text, newTopic: true });
	}
	await seed("POST", `${room}/schedules`, { name: "Weekly summary", type: "once", schedule: "+30m", prompt: "Write the weekly summary.", enabled: true });
	for (const id of ["cite-sources", "plain-words"]) {
		await seed("POST", "/api/skills", { id, displayName: id, description: "A synthetic skill.", instructions: "Answer plainly." });
		await seed("PUT", `${room}/skill-settings`, { action: "enable", name: id });
	}
	for (const name of ["notes-server", "tickets-server"]) {
		await seed("POST", "/api/mcp/servers", { name, url: "http://127.0.0.1:9/mcp" });
		await seed("PUT", `${room}/mcp-connectors`, { action: "grant", name });
	}

	// In the home's own folders: the server refuses a room folder in the system's temporary one.
	const deskFolder = path.join(tempHome, "Projects", "Desk");
	fs.mkdirSync(deskFolder, { recursive: true });
	await seed("PUT", `/api/persistent-agents/${encodeURIComponent(deskRoom)}/workspace-default`, { root: deskFolder, workspaceAccessMode: "localFiles", bashEnabled: true });

	const browser = await chromium.launch({ ignoreDefaultArgs: ["--hide-scrollbars"] });
	try {
		await checkRulesUnderSwitch(browser);
		await checkDefault(browser);
		await checkOff(browser);
		await checkFrame(browser);
		await checkSidebar(browser);
		await checkHeader(browser);
		await checkParts(browser);
		await checkPhone(browser);
		await checkClassNames(browser);
		await checkContrast(browser);
		// Each control's row runs on its own and the run fails at the end with every row that failed, so a missing rule shows in each.
		const failed: string[] = [];
		for (const row of [checkControlsOff, checkFields, checkChoices, checkMenu, checkQuestion, checkInfoMark, checkOutside]) {
			try {
				await row(browser);
			} catch (error) {
				// The first line, and for a wait the locator it waited for.
				failed.push(`${row.name}: ${(error as Error).message.split("\n").filter((line, i) => i === 0 || /waiting for/.test(line)).slice(0, 2).join(" ").replace(/\u001b\[\d+m/g, "")}`);
				console.log(`  FAIL ${failed.at(-1)}`);
				for (const context of browser.contexts()) await context.close();
			}
		}
		assert(failed.length === 0, `${failed.length} control rows failed:\n${failed.join("\n")}`);
	} finally {
		await browser.close();
	}
	console.log("settings look next ui smoke passed");
} finally {
	model?.close();
	await stopSmokeServer(server);
	fs.rmSync(tempRoot, { recursive: true, force: true });
}
