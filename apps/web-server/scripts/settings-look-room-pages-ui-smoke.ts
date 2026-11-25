// The settings windows' new look on a room's Model and Memory pages and on
// both Instructions pages (45-settings-look-room-pages.css). With the switch
// off, each page renders as before and "Show" still sits beside an empty
// archive. Every rule of the page file sits under the switch's class or the
// model list's root on <body>, and the page loads it after the look's first
// file. With the switch on, in both themes and on a phone: the model picker's
// words on the card's text edge and its list in the menu's look, with today's
// role and keys; Memory's switches and the slider's value on one edge, the two
// small section actions on their title lines, the search and the topics' rows;
// no "Show" while the archive is empty; and on both Instructions pages the box
// 320 tall, with Save, Discard, Clear, the save state and the counter on one
// line under it. Set LOOK_OFF_READING to a file to keep the
// switch-off reading (markup and every element's computed style) for comparing
// two builds.
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, type Browser, type Locator, type Page } from "playwright";
import { authedFetch, SMOKE_SERVER_AUTH_ENV, SMOKE_SERVER_SPAWN_TREE_OPTIONS, smokeHomeEnv, stopSmokeServer, freePort, waitForServer } from "./smoke-server-process.js";
import { waitEvery } from "./smoke-wait.js";
import { answered, assert, closeWindow, DARK, desktop, goToPage, installColourTools, LIGHT, LOOK_FILE, lookPages, notLookPageFilesAfterLook, phone, rulesOutsideRoots, same, SWITCH_CLASS, type Theme } from "./settings-look-smoke-parts.js";

const waitUntil = waitEvery(100);

{
	const p = typeof chromium?.executablePath === "function" ? chromium.executablePath() : "";
	if (!p || !fs.existsSync(p)) {
		console.log("settings look room pages ui smoke skipped (Chromium not installed)");
		process.exit(0);
	}
}

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const webServerDir = path.resolve(scriptDir, "..");
const repoRoot = path.resolve(webServerDir, "..", "..");
const stylesDir = path.join(repoRoot, "apps", "web-ui", "src", "styles");
const PAGES_FILE = "45-settings-look-room-pages.css";
const MENU_ROOT = `body:has(${SWITCH_CLASS}) > .room-model-menu`;
const port = await freePort();
const baseUrl = `http://127.0.0.1:${port}`;

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "exxperts-settings-look-room-pages-"));
const tempHome = path.join(tempRoot, "home");
const agentsRoot = path.join(tempHome, ".exxperts", "app", "personalized-agents");
const agentDir = path.join(tempHome, ".exxperts", "agent");
for (const dir of [agentsRoot, agentDir]) fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
process.env.HOME = tempHome;
process.env.USERPROFILE = tempHome;
process.env.EXXPERTS_CODING_AGENT_DIR = agentDir;
process.env.EXXETA_PERSISTENT_AGENTS_ROOT = agentsRoot;

// A room with notes in three topics (and Open items, always there) and one in the archive, and one whose archive is empty.
const ROOM = "Look Room";
const QUIET_ROOM = "Quiet Room";
/** The quiet room's id and its one note's, and the look room's id and a note of its kept for the archive, once seeded. */
const quietSeed = { room: "", note: "" };
const lookSeed = { room: "", spare: "" };
const look = lookPages({ baseUrl, room: ROOM });
const quiet = lookPages({ baseUrl, room: QUIET_ROOM });
const { openPage } = look;
/** The four pages: the window, the page's name in it and its root. */
const PAGES = [
	["room", "Model", ".room-model-section"],
	["room", "Memory", ".room-maintenance-section"],
	["room", "Instructions", ".room-instructions-section"],
	["settings", "Instructions", ".room-instructions-section"],
] as const;

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

const visible = (page: Page, selector: string) => page.locator(selector).filter({ visible: true }).first();

/** Opens a page of the four, with its requests answered and the pointer away. */
async function openOn(page: Page, which: "room" | "settings", label: string, rooms = look): Promise<Locator> {
	await rooms.openWindow(page, which);
	await goToPage(page, label);
	const root = PAGES.find(([w, l]) => w === which && l === label)![2];
	const element = visible(page, `.settings-dialog-pane ${root}`);
	await element.waitFor({ timeout: 10000 });
	await answered(page, `${which} ${label}`);
	await page.mouse.move(5, 5);
	return element;
}

type Box = { left: number; right: number; top: number; bottom: number; width: number; height: number };
const boxOf = (target: Locator): Promise<Box> => target.evaluate((element) => { const { left, right, top, bottom, width, height } = element.getBoundingClientRect(); return { left, right, top, bottom, width, height }; });
/** Where the words or marks inside an element end and start, by its content rather than its box. */
const contentOf = (target: Locator): Promise<Box> => target.evaluate((element) => { const range = document.createRange(); range.selectNodeContents(element); const { left, right, top, bottom, width, height } = range.getBoundingClientRect(); return { left, right, top, bottom, width, height }; });
/** A card's text edge on the right: its box less its edge and padding. */
const textEdgeOf = (card: Locator): Promise<number> => card.evaluate((element) => { const style = getComputedStyle(element); return element.getBoundingClientRect().right - parseFloat(style.borderRightWidth) - parseFloat(style.paddingRight); });
const near = (a: number, b: number, what: string, within = 1) => assert(Math.abs(a - b) <= within, `${what}: ${a.toFixed(1)} against ${b.toFixed(1)}`);

// --- The page file -------------------------------------------------------------

async function checkRulesUnderSwitch(browser: Browser): Promise<void> {
	const page = await openPage(browser, desktop(1280), "off");
	const roots = [SWITCH_CLASS, MENU_ROOT];
	const css = fs.readFileSync(path.join(stylesDir, PAGES_FILE), "utf8");
	same(await rulesOutsideRoots(page, css, roots), [], `rules in ${PAGES_FILE} outside ${SWITCH_CLASS} and the model list on <body>`);
	// The check finds a rule outside, in a media query too, and a longer class name is not the root.
	same(await rulesOutsideRoots(page, `.room-model-menu { color: red; } body > .room-model-menu .x { color: red; } ${MENU_ROOT}-note { color: red; } .settings-dialog .memory-topics { color: red; } @media (max-width: 720px) { ${SWITCH_CLASS} .a, .b { color: red; } }`, roots), [".room-model-menu", "body > .room-model-menu .x", `${MENU_ROOT}-note`, ".settings-dialog .memory-topics", ".b"], "the check's own probe");
	const imports = [...fs.readFileSync(path.join(repoRoot, "apps", "web-ui", "src", "styles.css"), "utf8").matchAll(/@import "\.\/styles\/([^"]+)";/g)].map((match) => match[1]);
	same(notLookPageFilesAfterLook(imports), [], `the style files after ${LOOK_FILE} that are not the look's page files`);
	assert(imports.indexOf(PAGES_FILE) > imports.indexOf(LOOK_FILE), `${PAGES_FILE} loads after ${LOOK_FILE}`);
	same(notLookPageFilesAfterLook(["01-base.css", LOOK_FILE, PAGES_FILE, "47-memory.css"]), ["47-memory.css"], "the order check's own probe");
	const loaded = await page.evaluate((prefix) => [...document.styleSheets].some((sheet) => [...sheet.cssRules].some((rule) => rule instanceof CSSStyleRule && rule.selectorText.startsWith(prefix))), MENU_ROOT);
	assert(loaded, "the page's stylesheet carries the page file's rules");
	await page.context().close();
	console.log(`  ok  every rule of ${PAGES_FILE} sits under ${SWITCH_CLASS} or on the model list a window in the look shows, and it loads after ${LOOK_FILE}`);
}

// --- With the switch off ---------------------------------------------------------

/** A page's markup, with React's generated ids and the moments it shows blanked, and every element's computed style. */
async function readOffPage(root: Locator) {
	return root.evaluate((element) => {
		const blank = (text: string) => text.replace(/«[^»]*»|:r[0-9a-z]+:/g, "#id").replace(/\b\d{1,2} [A-Z][a-z]{2}(, \d{2}:\d{2})?/g, "#when");
		const styles = [element, ...element.querySelectorAll("*")].map((one) => {
			const style = getComputedStyle(one);
			// Sorted: the browser lists custom properties in an order that changes between runs.
			return `${one.tagName.toLowerCase()}.${[...one.classList].join(".")} ${[...style].sort().map((name) => `${name}:${style.getPropertyValue(name)}`).join(";")}`;
		});
		return { markup: blank(element.outerHTML), styles: styles.map(blank) };
	});
}

async function checkOff(browser: Browser): Promise<void> {
	const reading: Record<string, unknown> = {};
	for (const [where, options] of [["1440 light", desktop(1440, 900, LIGHT)], ["390 light", phone(LIGHT)]] as const) {
		const page = await openPage(browser, options, "off");
		for (const [which, label] of PAGES) {
			const root = await openOn(page, which, label);
			same(await page.locator(".settings-look-next").count(), 0, `${where}, switch off, ${which} ${label}: elements with the look's class`);
			reading[`${where}, ${which} ${label}`] = await readOffPage(root);
			await closeWindow(page);
		}
		// Today's "Show" beside an empty archive, as an ordinary button.
		await openOn(page, "room", "Memory", quiet);
		const show = page.locator(".settings-dialog-pane .memory-archive-head .pane-head-actions button");
		await waitUntil(async () => (await page.locator(".settings-dialog-pane .memory-archive-head .group-head-line").filter({ visible: true }).first().innerText()) === "The archive is empty.", `${where}: the archive reads empty`);
		same(await show.evaluate((button) => [button.textContent, button.className]), ["Show", "rs-btn"], `${where}, switch off: "Show" beside an empty archive`);
		await closeWindow(page);
		await page.context().close();
	}
	if (process.env.LOOK_OFF_READING) fs.writeFileSync(process.env.LOOK_OFF_READING, JSON.stringify(reading, null, 1));
	console.log(`  ok  switch off: the four pages at 1440 and 390 with no look class, and "Show" beside an empty archive${process.env.LOOK_OFF_READING ? ` (reading kept in ${process.env.LOOK_OFF_READING})` : ""}`);
}

// --- With the switch on -----------------------------------------------------------

const INK = { [LIGHT]: "#111111", [DARK]: "#f4f1ec" };

/** The ink-filled buttons and the coloured words and fills on the open page, as a person sees them. Needs installColourTools. */
async function inkAndColour(page: Page, root: string, ink: string) {
	return page.evaluate(({ root, ink }) => {
		const w = window as any;
		const scope = [...document.querySelectorAll(root)].find((element) => element.getClientRects().length)!;
		const shown = (element: Element) => element.getClientRects().length > 0 && getComputedStyle(element).visibility !== "hidden";
		const chroma = (hex: string) => { const rgb = [1, 3, 5].map((at) => parseInt(hex.slice(at, at + 2), 16)); return Math.max(...rgb) - Math.min(...rgb); };
		const all = [scope, ...scope.querySelectorAll("*")].filter(shown);
		const inked = all.filter((element) => element.matches("button") && w.__painted(getComputedStyle(element).backgroundColor) && w.__seen(element, getComputedStyle(element).backgroundColor) === ink).map((element) => element.textContent);
		const coloured = all.flatMap((element) => {
			const style = getComputedStyle(element);
			const paints = [style.backgroundColor];
			if ([...element.childNodes].some((node) => node.nodeType === Node.TEXT_NODE && node.textContent!.trim())) paints.push(style.color);
			return paints.filter((colour) => w.__painted(colour) && chroma(w.__seen(element, colour)) > 24 && !element.closest("[class*='-dot'], .rs-btn-danger")).map((colour) => `${element.className} ${w.__seen(element, colour)}`);
		});
		return { inked, coloured };
	}, { root, ink });
}

/** A text's contrast on what is behind it, for each first visible match. Needs installColourTools. */
async function contrastOf(page: Page, selectors: Record<string, string>): Promise<Array<[string, number]>> {
	return page.evaluate((selectors) => Object.entries(selectors).flatMap(([name, selector]) => {
		const element = [...document.querySelectorAll(selector)].find((one) => one.getClientRects().length);
		return element ? [[name, Number((window as any).__contrast(element).toFixed(2))] as [string, number]] : [];
	}), selectors);
}

async function checkModel(browser: Browser): Promise<void> {
	const measured: string[] = [];
	for (const theme of [LIGHT, DARK] as const) {
		const page = await openPage(browser, desktop(1440, 900, theme), "on");
		await installColourTools(page);
		await openOn(page, "room", "Model");
		const at = `${theme}, Model`;
		const card = visible(page, ".settings-dialog-pane .room-model-section .settings-rows");
		const edge = await textEdgeOf(card);
		const picks = page.locator(".settings-dialog-pane .room-model-pick").filter({ visible: true });
		same(await picks.count(), 2, `${at}: two pickers`);
		for (let i = 0; i < 2; i++) near((await contentOf(picks.nth(i))).right, edge, `${at}: picker ${i + 1}'s words end on the card's text edge`);
		same(await page.locator(".settings-dialog-pane .room-model-section .room-model-row").filter({ visible: true }).evaluateAll((rows) => rows.map((row) => row.getBoundingClientRect().height - parseFloat(getComputedStyle(row).borderTopWidth))), [64, 64], `${at}: two form rows of 64 under their dividers`);

		// The Memory row's list: a model too small for the room's memory has its reason on a second line.
		const pick = picks.nth(1);
		await pick.click();
		const menu = page.locator(".room-model-menu");
		await menu.waitFor();
		await waitUntil(async () => (await menu.evaluate((element) => getComputedStyle(element).visibility)) === "visible", `${at}: the list is placed`);
		const list = await menu.evaluate((element) => {
			const style = getComputedStyle(element);
			const options = [...element.querySelectorAll("[role=option]")];
			return {
				role: element.getAttribute("role"),
				radius: style.borderRadius,
				box: element.getBoundingClientRect().toJSON() as DOMRect,
				items: options.map((option) => [option.querySelector(".room-model-option-reason") !== null, option.getBoundingClientRect().height]),
				// Each item's name, whether it carries the check, and its name's weight.
				weights: options.map((option) => [option.querySelector(".room-model-option-name")!.textContent, option.querySelector(".room-model-option-check svg") !== null, getComputedStyle(option.querySelector(".room-model-option-name")!).fontWeight]),
				cut: [...element.querySelectorAll(".room-model-option-name")].filter((name) => name.scrollWidth > name.clientWidth + 0.5).map((name) => name.textContent),
				focused: document.activeElement?.className,
			};
		});
		const button = await boxOf(pick);
		// The focus stays on the picker as today: the list asks for it while it is still hidden.
		same([list.role, list.radius, list.focused], ["listbox", "12px", "room-model-pick inherited"], `${at}: the list's role, radius and the focus as today`);
		assert(list.items.some(([second]) => second) && list.items.some(([second]) => !second), `${at}: items with and without a second line (${JSON.stringify(list.items)})`);
		for (const [second, height] of list.items) same(height, second ? 48 : 32, `${at}: an item ${second ? "with" : "without"} a second line`);
		// Only the chosen item, the one with the check, reads at 500: the model a default stands for stays at 400.
		assert(list.weights.some(([, checked]) => checked), `${at}: an item with the check`);
		for (const [name, checked, weight] of list.weights) same(weight, checked ? "500" : "400", `${at}: ${name}'s weight`);
		near(list.box.top >= button.bottom ? list.box.top - button.bottom : button.top - list.box.bottom, 6, `${at}: 6 px from its button`, 0.5);
		near(list.box.right, button.right, `${at}: its right edge on its button's`);
		same(list.cut, [], `${at}: names cut`);
		assert(list.box.width >= 200, `${at}: the list is ${list.box.width} wide, at least 200`);
		// Wider than 280 only where a name would be cut at 280.
		if (list.box.width > 280.5) {
			const cutAt280 = await menu.evaluate((element) => { (element as HTMLElement).style.width = "280px"; const cut = [...element.querySelectorAll(".room-model-option-name")].some((name) => name.scrollWidth > name.clientWidth + 0.5); (element as HTMLElement).style.width = ""; return cut; });
			assert(cutAt280, `${at}: the list is ${list.box.width} wide though every name fits 280`);
		}
		measured.push(`${theme} list ${list.box.width.toFixed(0)} wide`);
		// An item: the quiet fill under the pointer and pressed, a ring by the keyboard.
		const item = menu.locator("[role=option]:not(.unpickable)").last();
		const fillOf = () => item.evaluate((element) => (window as any).__seen(element, getComputedStyle(element).backgroundColor));
		// Each fill read once its fade has settled: the same twice in a row, and changed.
		const settled = async (from: string[], what: string) => { let last = ""; let fill = ""; await waitUntil(async () => { [last, fill] = [fill, await fillOf()]; return fill === last && !from.includes(fill); }, what); return fill; };
		const rest = await fillOf();
		await item.hover();
		const hover = await settled([rest], `${at}: an item under the pointer fills (${rest})`);
		// The item's words on its own fill under the pointer. A second line belongs to a model
		// that cannot be picked, which never fills, so it is read on the list's surface below.
		const onFill = await item.evaluate((element) => [["model name", ".room-model-option-name"], ["context", ".room-model-option-context"]].flatMap(([name, selector]) => { const part = element.querySelector(selector); return part ? [[name, Number((window as any).__colourContrast(part, getComputedStyle(part).color).toFixed(2))] as const] : []; }));
		same(onFill.map(([name]) => name), ["model name", "context"], `${at}: the hovered item's parts`);
		for (const [name, ratio] of onFill) { assert(ratio >= 4.5, `${at}: a hovered item's ${name} at ${ratio}:1`); measured.push(`${theme} hovered item ${name} ${ratio}`); }
		await page.mouse.down();
		await settled([rest, hover], `${at}: a pressed item fills more`);
		await page.mouse.move(5, 5);
		await page.mouse.up();
		// The keys as today, from an item: arrows move, Escape closes and gives the focus back.
		const focusName = () => page.evaluate(() => document.activeElement?.textContent ?? "");
		await menu.locator("[role=option]").first().focus();
		const first = await focusName();
		await page.keyboard.press("ArrowDown");
		assert((await focusName()) !== first, `${at}: ArrowDown moves the focus`);
		// The arrow key's item fills as the pointer's does, the ring in addition.
		let keyFill = "";
		await waitUntil(async () => { const last = keyFill; keyFill = await page.evaluate(() => (window as any).__seen(document.activeElement, getComputedStyle(document.activeElement!).backgroundColor)); return keyFill === hover && keyFill === last; }, `${at}: the arrow key's item fills as under the pointer (${keyFill} against ${hover})`);
		same(await page.evaluate(() => { const element = document.activeElement!; const style = getComputedStyle(element); return [element.matches(":focus-visible"), style.outlineStyle, style.outlineWidth]; }), [true, "solid", "2px"], `${at}: the keyboard's ring on an item`);
		await page.keyboard.press("ArrowUp");
		same(await focusName(), first, `${at}: ArrowUp moves it back`);
		const words = await contrastOf(page, { "provider name": ".room-model-menu-kicker", "model name": ".room-model-option-name", "second line": ".room-model-option-reason", "context": ".room-model-option-context" });
		for (const [name, ratio] of words) { assert(ratio >= 4.5, `${at}: the list's ${name} at ${ratio}:1`); measured.push(`${theme} list ${name} ${ratio}`); }
		same((await inkAndColour(page, ".room-model-menu", INK[theme])).coloured, [], `${at}: colour in the list`);
		await page.keyboard.press("Escape");
		await menu.waitFor({ state: "detached" });
		assert(await pick.evaluate((element) => element === document.activeElement), `${at}: Escape gives the focus back to its picker`);
		// Enter picks, as today: the Conversation row takes the model, then its default again.
		await picks.first().click();
		await menu.waitFor();
		await menu.locator("[role=option]", { hasText: "Narrow Model" }).focus();
		await page.keyboard.press("Enter");
		await menu.waitFor({ state: "detached" });
		await waitUntil(async () => (await picks.first().innerText()).includes("Narrow Model") && !(await picks.first().isDisabled()), `${at}: Enter picks the model`);
		await picks.first().click();
		await menu.locator("[role=option]").first().click();
		await waitUntil(async () => (await picks.first().innerText()).startsWith("Default") && !(await picks.first().isDisabled()), `${at}: the default again`);
		await closeWindow(page);
		await page.context().close();
	}
	// On a phone the list is today's sheet from the bottom, inside the screen.
	const page = await openPage(browser, phone(LIGHT), "on");
	await openOn(page, "room", "Model");
	await visible(page, ".settings-dialog-pane .room-model-pick").click();
	const sheet = page.locator(".room-model-menu");
	await sheet.waitFor();
	const box = await boxOf(sheet);
	assert(box.left >= 0 && box.right <= 390 && box.top >= 0 && box.bottom <= 844, `phone: the list inside the screen (${JSON.stringify(box)})`);
	for (const height of await sheet.locator("[role=option]").evaluateAll((items) => items.map((item) => item.getBoundingClientRect().height))) assert(height >= 44, `phone: an item ${height} tall`);
	await page.context().close();
	console.log(`  ..  ${measured.join("; ")}`);
	console.log("  ok  Model: the pickers' words on the card's text edge, two rows of 64; the list white with radius 12, items 32 and 48, 6 px from its button, no name cut, its states, keys and role as today; on a phone inside the screen");
}

async function checkMemory(browser: Browser): Promise<void> {
	const measured: string[] = [];
	for (const [theme, options] of [[LIGHT, desktop(1440, 900, LIGHT)], [DARK, desktop(1440, 900, DARK)]] as const) {
		const page = await openPage(browser, options, "on");
		await installColourTools(page);
		const root = await openOn(page, "room", "Memory");
		const at = `${theme}, Memory`;
		await waitUntil(async () => (await root.locator(".memory-topic-head").count()) === 4, `${at}: the topics are read`).catch(async (error) => { throw new Error(`${(error as Error).message}; read: ${JSON.stringify(await root.locator(".memory-topic-title").allInnerTexts())}`); });
		const saving = root.locator(".settings-group .settings-rows").first();
		const edge = await textEdgeOf(saving);
		const ends = await root.locator(".settings-group .settings-rows .workspaces-tool-switch, .memory-budget-value").evaluateAll((elements) => elements.map((element) => element.getBoundingClientRect().right));
		same(ends.length, 3, `${at}: two switches and the slider's value`);
		for (const end of ends) near(end, edge, `${at}: a switch or the slider's value ends on the card's text edge`);
		// The two section actions: 28 px family buttons, their middles on their titles' lines.
		const card = await boxOf(saving);
		for (const [name, head, kind] of [["Add note", ".room-memory-entries > .group-head", "rs-btn-sm"], ["Show", ".memory-archive-head .group-head", "rs-btn-quiet"]] as const) {
			const action = root.locator(`${head} .pane-head-actions .rs-btn`);
			same(await action.innerText(), name, `${at}: the action on the ${name === "Show" ? "Archive" : "Notes"} line`);
			const [box, title] = [await boxOf(action), await boxOf(root.locator(`${head} .settings-group-kicker`))];
			same([box.height, await action.evaluate((element, kind) => element.classList.contains("rs-btn-sm") && element.classList.contains(kind), kind)], [28, true], `${at}: ${name} is a small ${kind === "rs-btn-sm" ? "secondary" : "quiet"} family button`);
			near(box.top + box.height / 2, title.top + title.height / 2, `${at}: ${name}'s middle on its title's line`);
			// A secondary button ends on the card's edge; a quiet one's words do.
			if (kind === "rs-btn-sm") near(box.right, card.right, `${at}: ${name} ends on the cards' edge`);
			else near((await contentOf(action)).right, card.right, `${at}: ${name}'s words end on the cards' edge`);
		}
		const search = await boxOf(root.locator(".memory-notes-search"));
		const help = await boxOf(root.locator(".room-memory-entries > .group-head .group-head-line"));
		const topics = await boxOf(root.locator(".memory-topics"));
		same([search.height, search.left, search.right], [32, card.left, card.right], `${at}: the search 32 tall across the column`);
		same([Math.round(search.top - help.bottom), Math.round(topics.top - search.bottom)], [8, 8], `${at}: the search 8 under the help and 8 above the topics`);
		// With the note form open, the search keeps the column's 12 under it.
		await root.getByRole("button", { name: "Add note" }).click();
		const form = await boxOf(root.locator(".memory-entry-add"));
		same(Math.round((await boxOf(root.locator(".memory-notes-search"))).top - form.bottom), 12, `${at}: the search under the open note form`);
		await root.locator(".memory-entry-add").getByRole("button", { name: "Cancel" }).click();
		await root.locator(".memory-entry-add").waitFor({ state: "detached" });
		// The archive's notes open 8 under its help, as the search sits under the Notes help.
		await root.locator(".memory-archive-head").getByRole("button", { name: "Show" }).click();
		const archiveHelp = await boxOf(root.locator(".memory-archive-head .group-head-line"));
		await root.locator(".memory-archive-entries").waitFor();
		same(Math.round((await boxOf(root.locator(".memory-archive-entries"))).top - archiveHelp.bottom), 8, `${at}: the archive's notes under its help`);
		await root.locator(".memory-archive-head").getByRole("button", { name: "Hide" }).click();
		await root.locator(".memory-archive-entries").waitFor({ state: "detached" });
		// A section ending in its help, with no card, keeps the same room to the next title as a card does.
		const [cardToArchive, helpToHistory] = [(await boxOf(root.locator(".memory-archive-head .settings-group-kicker"))).top - (await boxOf(root.locator(".memory-topics"))).bottom, (await boxOf(root.locator(".room-memory-history .settings-group-kicker"))).top - (await boxOf(root.locator(".memory-archive-head .group-head-line"))).bottom];
		near(helpToHistory, cardToArchive, `${at}: from the Archive line's help to History, as from the topics to Archive`);
		// Each topic's count in the value's column, its words ending on the card's text edge.
		const topicsEdge = await textEdgeOf(root.locator(".memory-topics"));
		const rows = await root.locator(".memory-topic-head").evaluateAll((heads) => heads.map((head) => { const count = head.querySelector(".memory-topic-count")!; const range = document.createRange(); range.selectNodeContents(count); return [head.getBoundingClientRect().height, range.getBoundingClientRect().right, count.getBoundingClientRect().width]; }));
		for (const [height] of rows) same(height, 48, `${at}: a topic row's height`);
		for (const [, right] of rows) near(right, topicsEdge, `${at}: a topic's count ends on the card's text edge`);
		same(rows[0][2], 128, `${at}: the count's column`);
		// A topic row: the row's tint under the pointer and pressed, the keyboard's ring, and its chevron turning.
		const topic = root.locator(".memory-topic-head").first();
		const fillOf = () => topic.evaluate((element) => (window as any).__seen(element, getComputedStyle(element).backgroundColor));
		const settled = async (from: string[], what: string) => { let last = ""; let fill = ""; await waitUntil(async () => { [last, fill] = [fill, await fillOf()]; return fill === last && !from.includes(fill); }, what); return fill; };
		const rest = await fillOf();
		await topic.hover();
		const hover = await settled([rest], `${at}: a topic row tints under the pointer (${rest})`);
		await page.mouse.down();
		await settled([rest, hover], `${at}: a pressed topic row tints more`);
		await page.mouse.up();
		await waitUntil(async () => (await topic.getAttribute("aria-expanded")) === "true", `${at}: the topic opens`);
		await waitUntil(async () => (await topic.locator(".disclosure-chevron").evaluate((element) => getComputedStyle(element).transform)) === "matrix(0, 1, -1, 0, 0, 0)", `${at}: the chevron turns a quarter`);
		await topic.click();
		await page.mouse.move(5, 5);
		await topic.focus();
		await page.keyboard.press("Shift");
		same(await topic.evaluate((element) => [element.matches(":focus-visible"), getComputedStyle(element).outlineWidth, getComputedStyle(element).outlineOffset, getComputedStyle(element).borderTopLeftRadius]), [true, "2px", "-2px", "8px"], `${at}: the keyboard's ring inside the row, radius 8`);
		// The row inside the card's edge, so the card's rounded clip leaves the ring whole.
		const [ringRow, ringCard] = [await boxOf(topic), await boxOf(root.locator(".memory-topics"))];
		assert(ringRow.left >= ringCard.left + 1 && ringRow.right <= ringCard.right - 1 && ringRow.top >= ringCard.top + 1, `${at}: the focused row inside the card's edge (${JSON.stringify(ringRow)} in ${JSON.stringify(ringCard)})`);
		await page.mouse.move(5, 5);
		// The chevron tells open from closed: a graphic's 3:1 against the card.
		const chevron = await topic.evaluate((element) => Number((window as any).__colourContrast(element, getComputedStyle(element.querySelector(".disclosure-chevron")!).backgroundColor).toFixed(2)));
		assert(chevron >= 3, `${at}: the topic's chevron at ${chevron}:1`);
		measured.push(`${theme} topic chevron ${chevron}`);
		const words = await contrastOf(page, { "topic name": ".memory-topic-title", "topic count": ".memory-topic-count", "history moment": ".memory-history-when", "history words": ".memory-history-what", "section help": ".memory-archive-head .group-head-line" });
		for (const [name, ratio] of words) { assert(ratio >= 4.5, `${at}: ${name} at ${ratio}:1`); measured.push(`${theme} ${name} ${ratio}`); }
		const seen = await inkAndColour(page, ".settings-dialog-pane .room-maintenance-section", INK[theme]);
		same([seen.inked, seen.coloured], [[], []], `${at}: ink buttons and colour`);
		await closeWindow(page);
		await page.context().close();
	}
	// On a phone: the budget's slider inside its row, and nothing scrolls sideways.
	const page = await openPage(browser, phone(LIGHT), "on");
	const root = await openOn(page, "room", "Memory");
	const row = await boxOf(root.locator(".memory-budget-row"));
	const slider = await boxOf(root.locator(".memory-budget-slider"));
	assert(slider.top >= row.top && slider.bottom <= row.bottom && slider.left >= row.left && slider.right <= row.right, `phone: the slider inside its row (${JSON.stringify(slider)} in ${JSON.stringify(row)})`);
	same(await page.evaluate(() => { const pane = document.querySelector(".settings-dialog-pane")!; return [pane.scrollWidth - pane.clientWidth, document.documentElement.scrollWidth - window.innerWidth]; }), [0, 0], "phone, Memory: sideways scroll");
	// History's rows: one height inside the hairline between them, the moment on its own line and the words on one line beside "What changed", its word on the card's text edge.
	const history = await root.locator(".memory-history-row").evaluateAll((rows) => rows.map((row) => { const range = document.createRange(); range.selectNodeContents(row.querySelector(".memory-history-what")!); return [row.clientHeight, range.getBoundingClientRect().height]; }));
	same(new Set(history.map(([height]) => height)).size, 1, `phone: history rows of one height (${history.map(([height]) => height).join(", ")})`);
	for (const [, words] of history) assert(words <= 21, `phone: a history row's words on one line (${words} tall)`);
	// As much room above the moment as under the words.
	const [above, below] = await root.locator(".memory-history-row").first().evaluate((row) => { const box = row.getBoundingClientRect(); const range = document.createRange(); range.selectNodeContents(row.querySelector(".memory-history-what")!); return [row.querySelector(".memory-history-when")!.getBoundingClientRect().top - box.top, box.bottom - range.getBoundingClientRect().bottom]; });
	near(above, below, "phone: a history row's room above its moment and under its words", 2);
	near((await contentOf(root.locator(".memory-history-toggle").first())).right, await textEdgeOf(root.locator(".memory-history-rows")), "phone: What changed's word on the history card's text edge");
	// A quiet button's words on the column's edge, and the archive's notes under its help in the column's rhythm.
	const column = await boxOf(root.locator(".memory-topics"));
	const show = root.locator(".memory-archive-head").getByRole("button", { name: "Show" });
	near((await contentOf(show)).right, column.right, "phone: Show's word on the column's edge");
	const phoneSearchGap = (await boxOf(root.locator(".memory-notes-search"))).top - (await boxOf(root.locator(".room-memory-entries > .group-head .group-head-line"))).bottom;
	await show.click();
	await root.locator(".memory-archive-entries").waitFor();
	same(Math.round((await boxOf(root.locator(".memory-archive-entries"))).top - (await boxOf(root.locator(".memory-archive-head .group-head-line"))).bottom), Math.round(phoneSearchGap), "phone: the archive's notes under its help as the search under the Notes help");
	await page.context().close();
	console.log(`  ..  ${measured.join("; ")}`);
	console.log("  ok  Memory: switches and the slider's value on the card's text edge; Add note and Show 28 px on their titles' lines; the search 32 tall across the column; topic rows 48 with the count at one x, their states; no ink button and no colour; on a phone the slider in its row, history rows of one height, the quiet buttons' words on the edge");
}

async function checkArchive(browser: Browser): Promise<void> {
	const page = await openPage(browser, desktop(1440, 900, LIGHT), "on");
	// An empty archive: its line, and no "Show".
	const quietRoot = await openOn(page, "room", "Memory", quiet);
	const line = quietRoot.locator(".memory-archive-head .group-head-line");
	await waitUntil(async () => (await line.innerText()) === "The archive is empty.", "the empty archive's line");
	same(await quietRoot.locator(".memory-archive-head button").count(), 0, "an empty archive: buttons on its line");
	await closeWindow(page);
	// A note in the archive: "Show" opens it, "Hide" closes it.
	const root = await openOn(page, "room", "Memory");
	const action = root.locator(".memory-archive-head .pane-head-actions .rs-btn");
	await waitUntil(async () => (await action.count()) === 1 && (await action.innerText()) === "Show", "Show beside a note in the archive");
	await action.click();
	await root.locator(".memory-archive-entries .memory-entry").first().waitFor();
	same(await action.innerText(), "Hide", "the archive open: its action");
	const list = await boxOf(root.locator(".memory-archive-entries"));
	assert(list.top > (await boxOf(root.locator(".memory-archive-head .group-head-line"))).bottom, "the archive's notes under its line");
	await action.click();
	await root.locator(".memory-archive-entries").waitFor({ state: "detached" });
	same(await action.innerText(), "Show", "the archive closed: its action");
	await closeWindow(page);
	// The notes could not be read: the archive's count is unknown, not 0, so "Show" stays and opens it once the server answers,
	// and stays after one of its two notes is restored.
	const second = await authedFetch(`${baseUrl}/api/persistent-agents/${encodeURIComponent(lookSeed.room)}/memory/entries/${encodeURIComponent(lookSeed.spare)}`, { method: "DELETE" });
	assert(second.ok, `archiving a second note: ${second.status}`);
	let refused = 0;
	await page.route((url) => url.pathname.endsWith("/memory/entries"), (route) => {
		if (route.request().method() !== "GET" || refused > 0) return route.fallback();
		refused++;
		return route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ error: "Service Unavailable" }) });
	});
	const unread = await openOn(page, "room", "Memory");
	await unread.locator(".room-maintenance-error").first().waitFor();
	same(refused, 1, "the notes read refused once");
	const unknown = unread.locator(".memory-archive-head .pane-head-actions .rs-btn");
	same(await unknown.allInnerTexts(), ["Show"], "the notes unread: Show beside the archive");
	await unknown.click();
	const archivedRows = unread.locator(".memory-archive-entries .memory-entry");
	await waitUntil(async () => (await archivedRows.count()) === 2, "the notes unread: the archive's two notes");
	await archivedRows.first().getByRole("button", { name: "Restore" }).click();
	await waitUntil(async () => (await archivedRows.count()) === 1, "the notes unread: one note restored");
	await unknown.click();
	await unread.locator(".memory-archive-entries").waitFor({ state: "detached" });
	same(await unknown.allInnerTexts(), ["Show"], "the notes unread, one of two restored: Show beside the archive");
	await unknown.click();
	await waitUntil(async () => (await archivedRows.count()) === 1, "the notes unread: the note left in the archive");
	await closeWindow(page);
	await page.unrouteAll();
	// An archive emptied while open: Hide takes its button away, and the keyboard's focus goes to the archive's line.
	const archived = await authedFetch(`${baseUrl}/api/persistent-agents/${encodeURIComponent(quietSeed.room)}/memory/entries/${encodeURIComponent(quietSeed.note)}`, { method: "DELETE" });
	assert(archived.ok, `archiving the quiet room's note: ${archived.status}`);
	const emptied = await openOn(page, "room", "Memory", quiet);
	const head = emptied.locator(".memory-archive-head");
	await head.getByRole("button", { name: "Show" }).click();
	await emptied.locator(".memory-archive-entries").getByRole("button", { name: "Restore" }).click();
	await emptied.locator(".memory-archive-entries .memory-entry").waitFor({ state: "detached" });
	await head.getByRole("button", { name: "Hide" }).focus();
	await page.keyboard.press("Enter");
	await waitUntil(async () => (await head.locator("button").count()) === 0, "the emptied archive: no button on its line");
	same(await page.evaluate(() => document.activeElement?.className), "group-head-line", "the emptied archive: the focus on its line");
	await page.context().close();
	console.log("  ok  the archive: no Show while it is empty; with a note in it, Show opens it and Hide closes it; with the notes unread, Show stays and opens it; Hide on an archive emptied while open hands the focus to its line");
}

async function checkInstructions(browser: Browser): Promise<void> {
	for (const [where, options] of [["1440 light", desktop(1440, 900, LIGHT)], ["1440 dark", desktop(1440, 900, DARK)], ["390 light", phone(LIGHT)]] as const) {
		const page = await openPage(browser, options, "on");
		await installColourTools(page);
		const theme: Theme = where.endsWith("dark") ? DARK : LIGHT;
		for (const which of ["room", "settings"] as const) {
			const at = `${where}, ${which} Instructions`;
			const root = await openOn(page, which, "Instructions");
			const box = root.locator("textarea");
			await waitUntil(async () => !(await box.isDisabled()), `${at}: the box is read`);
			const above = await boxOf(root.locator(which === "room" ? ":scope > .settings-rows" : ":scope > .pane-top > .pane-lead"));
			let rest = await boxOf(box);
			same(rest.height, 320, `${at}: the box at rest`);
			// Under a lead on a phone, the look's phone gap after every page's lead.
			same(Math.round(rest.top - above.bottom), which === "settings" && where.startsWith("390") ? 12 : 24, `${at}: the box under the ${which === "room" ? "card" : "lead"} above it`);
			await box.fill("Answer in German unless I write in English.\nLead with the recommendation.");
			const foot = root.locator(".room-instructions-foot");
			await foot.locator(".rs-btn-primary").waitFor();
			rest = await boxOf(box);
			const counter = await boxOf(root.locator(".room-instructions-count"));
			near(counter.right, rest.right, `${at}: the counter's right edge on the box's`);
			// One row for both, one gap under the box; on a phone the four leave the counter no room, and it stands under them.
			const row = await boxOf(foot.locator(".rs-pane-actions"));
			near(row.top - rest.bottom, 12, `${at}: the line 12 under the box`);
			if (where.startsWith("390")) near(counter.top - row.bottom, 12, `${at}: the counter 12 under the line it finds no room on`);
			else near(counter.top + counter.height / 2, row.top + row.height / 2, `${at}: the counter on the line's middle`);
			const line = await foot.locator(".rs-pane-actions > *").evaluateAll((parts) => parts.map((part) => { const box = part.getBoundingClientRect(); return [part.textContent, box.top + box.height / 2]; }));
			same(line.map(([words]) => words), ["Save", "Discard", "Clear", "Unsaved changes"], `${at}: the line under the box`);
			for (const [words, middle] of line) near(middle as number, line[0][1] as number, `${at}: ${words} on Save's line`);
			const seen = await inkAndColour(page, `.settings-dialog-pane ${PAGES.find(([w, l]) => w === which && l === "Instructions")![2]}`, INK[theme]);
			same(seen.inked, ["Save"], `${at}: Save is the page's one ink button`);
			// Save keeps the family's padding; the words of Discard, Clear and the state line stand as far apart.
			const savePad = await foot.locator(".rs-btn-primary").evaluate((element) => getComputedStyle(element).paddingLeft);
			same(savePad, where.startsWith("390") ? "16px" : "14px", `${at}: Save's padding`);
			const [discardWords, clearWords, stateWords] = [await contentOf(foot.getByRole("button", { name: "Discard" })), await contentOf(foot.getByRole("button", { name: "Clear" })), await contentOf(foot.locator(".room-instructions-state"))];
			near(stateWords.left - clearWords.right, clearWords.left - discardWords.right, `${at}: the state line as far from Clear as Clear from Discard`);
			// Discard and Clear are quiet, as a page's cancel is: no fill at rest.
			same(await foot.locator(".rs-btn:not(.rs-btn-primary)").evaluateAll((buttons) => buttons.map((button) => [button.textContent, getComputedStyle(button).backgroundColor])), [["Discard", "rgba(0, 0, 0, 0)"], ["Clear", "rgba(0, 0, 0, 0)"]], `${at}: Discard and Clear without a fill`);
			same(seen.coloured, [], `${at}: colour`);
			for (const [name, ratio] of await contrastOf(page, { counter: ".room-instructions-count", "save state": ".room-instructions-state" })) assert(ratio >= 4.5, `${at}: the ${name} at ${ratio}:1`);
			// Clear empties the box, and reads Undo in its place on the line.
			await foot.getByRole("button", { name: "Clear" }).click();
			same(await box.inputValue(), "", `${at}: Clear empties the box`);
			await foot.getByRole("button", { name: "Undo" }).click();
			assert((await box.inputValue()).startsWith("Answer in German"), `${at}: Undo puts it back`);
			await foot.getByRole("button", { name: "Discard" }).click();
			await waitUntil(async () => (await box.inputValue()) === "", `${at}: Discard empties the box again`);
			// Saved: Save and Discard go, and Clear starts the line, its word on the box's left edge.
			await box.fill("Lead with the recommendation.");
			await foot.getByRole("button", { name: "Save" }).click();
			await waitUntil(async () => (await foot.locator(".rs-btn-primary").count()) === 0, `${at}: Save goes once the words are saved`);
			const saved = await foot.locator(".rs-pane-actions > *").allTextContents();
			same([saved.length, saved[0], saved[1]?.startsWith("Saved")], [2, "Clear", true], `${at}: the line once saved (${saved.join(" | ")})`);
			near((await contentOf(foot.getByRole("button", { name: "Clear" }))).left, (await boxOf(box)).left, `${at}: Clear's word on the box's left edge`);
			const [savedLine, savedCount] = [await boxOf(foot.locator(".rs-pane-actions")), await boxOf(root.locator(".room-instructions-count"))];
			near(savedCount.top + savedCount.height / 2, savedLine.top + savedLine.height / 2, `${at}: once saved, the counter on the line's middle`);
			near(savedCount.right, (await boxOf(box)).right, `${at}: once saved, the counter's right edge on the box's`);
			await foot.getByRole("button", { name: "Clear" }).click();
			await foot.getByRole("button", { name: "Save" }).click();
			await waitUntil(async () => (await foot.locator(".rs-btn-primary").count()) === 0 && (await box.inputValue()) === "", `${at}: the emptied box saved`);
			await closeWindow(page);
		}
		await page.context().close();
	}
	console.log("  ok  both Instructions pages, desktop and phone: the box 320 tall, 24 under what is above it; 12 under it one line of Save, Discard, Clear and the save state with the counter at its right (on a phone under them while the four fill it), Save the one ink button, Discard and Clear quiet; once saved, Clear starts the line on the box's edge");
}

let model: http.Server | undefined;
try {
	const agents = await import("../src/persistent-agents.js");
	const lookRoom = agents.createPersistentAgentFromScaffoldInput({ displayName: ROOM, userName: "Synthetic User", preferredUserAddress: "Synthetic User" }).agent.agentId;
	const quietRoom = agents.createPersistentAgentFromScaffoldInput({ displayName: QUIET_ROOM, userName: "Synthetic User", preferredUserAddress: "Synthetic User" }).agent.agentId;
	// A model server is never asked here; two models, one too small for a room's memory, so its line in the list has a reason.
	const modelPort = await freePort();
	model = http.createServer((_req, res) => { res.writeHead(500); res.end(); }).listen(modelPort, "127.0.0.1");
	const appDir = path.join(tempHome, ".exxperts", "app");
	fs.writeFileSync(path.join(agentDir, "models.json"), JSON.stringify({ providers: { synthetic: { name: "Synthetic", baseUrl: `http://127.0.0.1:${modelPort}/v1`, api: "openai-completions", models: [{ id: "room-model", name: "Room Model", input: ["text"], contextWindow: 128000, maxTokens: 16384 }, { id: "narrow-model", name: "Narrow Model", input: ["text"], contextWindow: 16000, maxTokens: 4096 }] } } }));
	fs.writeFileSync(path.join(appDir, "custom-ai-profiles.json"), JSON.stringify({ version: 1, profiles: [{ id: "custom-synthetic", providerId: "synthetic", label: "Synthetic", roomModels: ["room-model", "narrow-model"], learnModel: "room-model", reviewMemoryModel: "room-model" }] }));
	fs.writeFileSync(path.join(appDir, "persistent-agent-ai-profile.json"), JSON.stringify({ profileId: "custom-synthetic" }));
	await startServer();
	const seed = async (method: "POST" | "PUT" | "DELETE", route: string, body?: unknown) => {
		const answer = await authedFetch(`${baseUrl}${route}`, { method, ...(body === undefined ? {} : { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }) });
		const text = await answer.text();
		assert(answer.ok, `seeding ${route}: ${answer.status} ${text}`);
		return (text ? JSON.parse(text) : {}) as { entry?: { id: string } };
	};
	await seed("POST", "/api/auth/api-key", { provider: "synthetic", key: "synthetic-test-key" });
	const room = `/api/persistent-agents/${encodeURIComponent(lookRoom)}`;
	const made: string[] = [];
	for (const [topic, text] of [["General", "Reports go out on Fridays."], ["Clients", "Acme prefers short summaries."], ["Clients", "Bosch wants German."], ["Style", "Plain words, short sentences."], ["People", "Dana owns the budget."]]) {
		made.push((await seed("POST", `${room}/memory/entries`, { topic, kind: "fact", text, newTopic: true })).entry!.id);
	}
	lookSeed.room = lookRoom;
	lookSeed.spare = made[0];
	// The last note into the archive, so three of its topics stay.
	await seed("DELETE", `${room}/memory/entries/${encodeURIComponent(made.at(-1)!)}`);
	quietSeed.room = quietRoom;
	quietSeed.note = (await seed("POST", `/api/persistent-agents/${encodeURIComponent(quietRoom)}/memory/entries`, { topic: "General", kind: "fact", text: "Check the budget sheet.", newTopic: true })).entry!.id;

	const browser = await chromium.launch({ ignoreDefaultArgs: ["--hide-scrollbars"] });
	try {
		// Each row runs on its own and the run fails at the end with every row that failed.
		const failed: string[] = [];
		for (const row of [checkRulesUnderSwitch, checkOff, checkModel, checkMemory, checkArchive, checkInstructions]) {
			try {
				await row(browser);
			} catch (error) {
				failed.push(`${row.name}: ${(error as Error).message.split("\n").filter((line, i) => i === 0 || /waiting for/.test(line)).slice(0, 2).join(" ").replace(/\u001b\[\d+m/g, "")}`);
				console.log(`  FAIL ${failed.at(-1)}`);
				for (const context of browser.contexts()) await context.close();
			}
		}
		assert(failed.length === 0, `${failed.length} rows failed:\n${failed.join("\n")}`);
	} finally {
		await browser.close();
	}
	console.log("settings look room pages ui smoke passed");
} finally {
	model?.close();
	await stopSmokeServer(server);
	fs.rmSync(tempRoot, { recursive: true, force: true });
}
