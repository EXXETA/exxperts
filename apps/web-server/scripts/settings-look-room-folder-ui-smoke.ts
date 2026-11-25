// The settings windows' new look on a room's Folder, Scheduled tasks,
// Conversation and Archive or delete pages (46-settings-look-room-folder.css)
// and the soft red button (01-base.css). Every rule of the page file sits
// under the switch's class, and the page loads it after the look's first file.
// With the switch off the four pages render as before: the folder's "×" named
// "Stop using this folder", today's classes on Delete room and
// Forget, and no element of the look's own. With it on: the folder's
// name alone, its path whole in its tip and to a screen reader and nowhere as
// text, and no path where the page has none; "Stop
// using this folder" a quiet button beside "Change folder" that asks today's
// question; "Choose folder" its page's one ink button, Scheduled tasks with none;
// task rows with the Enabled switch on one edge, their state in plain words
// beside a dot, run rows with a dot and the time ending on the card's edge; Forget, Delete
// room and a task's Delete in soft red at 4.5:1; Archive and Delete as two
// cards 12 apart with their buttons on one edge, and Delete room's question
// as today; the soft red button's rest, hover, pressed, focus and disabled;
// in both themes, with nothing scrolling sideways at 390 px. Set
// LOOK_OFF_READING to a file to keep the switch-off reading (markup and every
// element's computed style) for comparing two builds, and LOOK_ROWS to a
// comma list of row names to run only those.
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, type Browser, type Locator, type Page } from "playwright";
import { authedFetch, SMOKE_SERVER_AUTH_ENV, SMOKE_SERVER_SPAWN_TREE_OPTIONS, smokeHomeEnv, stopSmokeServer, freePort, waitForServer } from "./smoke-server-process.js";
import { waitEvery } from "./smoke-wait.js";
import { answered, assert, closeWindow, contrast, DARK, desktop, goToPage, installColourTools, LIGHT, LOOK_FILE, lookPages, nearColour, notLookPageFilesAfterLook, phone, redEdges, rulesOutsideRoots, same, SWITCH_CLASS, type Theme } from "./settings-look-smoke-parts.js";
import { CHANGE_FOLDER, CHOOSE_FOLDER, STOP_USING_FOLDER, STOP_USING_FOLDER_BODY, stopUsingFolderTitle } from "../src/room-box/card-text.js";

const waitUntil = waitEvery(100);

{
	const p = typeof chromium?.executablePath === "function" ? chromium.executablePath() : "";
	if (!p || !fs.existsSync(p)) {
		console.log("settings look room folder ui smoke skipped (Chromium not installed)");
		process.exit(0);
	}
}

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const webServerDir = path.resolve(scriptDir, "..");
const repoRoot = path.resolve(webServerDir, "..", "..");
const stylesDir = path.join(repoRoot, "apps", "web-ui", "src", "styles");
const PAGES_FILE = "46-settings-look-room-folder.css";
const port = await freePort();
const baseUrl = `http://127.0.0.1:${port}`;

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "exxperts-settings-look-room-folder-"));
const tempHome = path.join(tempRoot, "home");
const agentsRoot = path.join(tempHome, ".exxperts", "app", "personalized-agents");
const agentDir = path.join(tempHome, ".exxperts", "agent");
for (const dir of [agentsRoot, agentDir]) fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
process.env.HOME = tempHome;
process.env.USERPROFILE = tempHome;
process.env.EXXPERTS_CODING_AGENT_DIR = agentDir;
process.env.EXXETA_PERSISTENT_AGENTS_ROOT = agentsRoot;

// A room with a folder far down the home, two tasks, two runs and an open conversation; and one with none of them.
const ROOM = "Look Room";
const BARE_ROOM = "Bare Room";
const FOLDER_NAME = "Monthly reporting";
const FOLDER = path.join(tempHome, "Documents", "Cloud storage", "Shared with the finance team", "Quarterly and monthly reports", "Reports", FOLDER_NAME);
const look = lookPages({ baseUrl, room: ROOM });
const bare = lookPages({ baseUrl, room: BARE_ROOM });
const { openPage } = look;
/** The four pages: the page's name in Room settings and its root. */
const ROOTS: Record<string, string> = {
	"Folder": ".room-workspace-section",
	"Scheduled tasks": ".room-schedules-section",
	"Conversation": ".room-session-section",
	"Archive or delete": ".room-danger-zone",
};
const INK = { [LIGHT]: "#111111", [DARK]: "#f4f1ec" };

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

/** Opens one of the four pages in a room's window, with its requests answered and the pointer away. */
async function openOn(page: Page, label: string, rooms = look): Promise<Locator> {
	await rooms.openWindow(page, "room");
	await goToPage(page, label);
	const root = visible(page, `.settings-dialog-pane ${ROOTS[label]}`);
	await root.waitFor({ timeout: 10000 });
	await answered(page, label);
	await page.mouse.move(5, 5);
	return root;
}

type Box = { left: number; right: number; top: number; bottom: number; width: number; height: number };
const boxOf = (target: Locator): Promise<Box> => target.evaluate((element) => { const { left, right, top, bottom, width, height } = element.getBoundingClientRect(); return { left, right, top, bottom, width, height }; });
const near = (a: number, b: number, what: string, within = 1) => assert(Math.abs(a - b) <= within, `${what}: ${a.toFixed(1)} against ${b.toFixed(1)}`);
/** Whether the page or the settings pane scrolls sideways. */
const sideways = (page: Page) => page.evaluate(() => { const pane = document.querySelector(".settings-dialog-pane")!; return [document.scrollingElement!.scrollWidth > window.innerWidth, pane.scrollWidth > pane.clientWidth]; });

/** The ink-filled buttons and anything coloured that is not a status dot or a red button, under `root`. Needs installColourTools. */
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
			const paints = [style.backgroundColor, style.borderTopColor];
			if ([...element.childNodes].some((node) => node.nodeType === Node.TEXT_NODE && node.textContent!.trim())) paints.push(style.color);
			return paints.filter((colour) => w.__painted(colour) && chroma(w.__seen(element, colour)) > 24 && !element.closest("[class*='-dot'], .rs-btn-danger")).map((colour) => `${element.className} ${w.__seen(element, colour)}`);
		});
		return { inked, coloured: [...new Set(coloured)] };
	}, { root, ink });
}

// --- The page file -------------------------------------------------------------

async function checkRulesUnderSwitch(browser: Browser): Promise<void> {
	const page = await openPage(browser, desktop(1280), "off");
	const css = fs.readFileSync(path.join(stylesDir, PAGES_FILE), "utf8");
	same(await rulesOutsideRoots(page, css, [SWITCH_CLASS]), [], `rules in ${PAGES_FILE} outside ${SWITCH_CLASS}`);
	// The check finds a rule outside, in a media query too, and a longer class name is not the root.
	same(await rulesOutsideRoots(page, `.room-danger-zone .settings-row { color: red; } ${SWITCH_CLASS}-more .x { color: red; } @media (max-width: 760px) { ${SWITCH_CLASS} .a, .folder-pane-location { color: red; } } .rs-btn-danger-soft { color: red; }`, [SWITCH_CLASS]), [".room-danger-zone .settings-row", `${SWITCH_CLASS}-more .x`, ".folder-pane-location", ".rs-btn-danger-soft"], "the check's own probe");
	const imports = [...fs.readFileSync(path.join(repoRoot, "apps", "web-ui", "src", "styles.css"), "utf8").matchAll(/@import "\.\/styles\/([^"]+)";/g)].map((match) => match[1]);
	same(notLookPageFilesAfterLook(imports), [], `the style files after ${LOOK_FILE} that are not the look's page files`);
	assert(imports.indexOf(PAGES_FILE) > imports.indexOf(LOOK_FILE), `${PAGES_FILE} loads after ${LOOK_FILE}`);
	const loaded = await page.evaluate(() => [...document.styleSheets].some((sheet) => [...sheet.cssRules].some((rule) => rule instanceof CSSStyleRule && rule.selectorText.includes(".also-allowed-icon") && rule.selectorText.startsWith(".settings-dialog.settings-look-next"))));
	assert(loaded, "the page's stylesheet carries the page file's rules");
	await page.context().close();
	console.log(`  ok  every rule of ${PAGES_FILE} sits under ${SWITCH_CLASS}, and it loads after ${LOOK_FILE}`);
}

// --- With the switch off ---------------------------------------------------------

/** The run's own temp folder, as the page may show it, blanked in a reading so two runs compare. */
const TEMP_ROOTS = [...new Set([fs.realpathSync(tempRoot), tempRoot])];

/** A page's markup, with React's generated ids, the moments it shows and the run's temp folder blanked, and every element's computed style, its properties in name order (custom ones come in no fixed order). */
async function readOffPage(root: Locator) {
	return root.evaluate((element, temps) => {
		const blank = (text: string) => temps.reduce((done, temp) => done.split(temp).join("#temp"), text).replace(/«[^»]*»|:r[0-9a-z]+:/g, "#id").replace(/\b\d{1,2} [A-Z][a-z]{2}(, \d{2}:\d{2})?/g, "#when").replace(/\b\d{2}:\d{2}\b/g, "#time");
		const styles = [element, ...element.querySelectorAll("*")].map((one) => {
			const style = getComputedStyle(one);
			return `${one.tagName.toLowerCase()}.${[...one.classList].join(".")} ${[...style].sort().map((name) => `${name}:${style.getPropertyValue(name)}`).join(";")}`;
		});
		return { markup: blank(element.outerHTML), styles: styles.map(blank) };
	}, TEMP_ROOTS);
}

async function checkOff(browser: Browser): Promise<void> {
	const reading: Record<string, unknown> = {};
	const READS: Array<[string, string, typeof look]> = [["Folder", "with a folder", look], ["Folder", "with none", bare], ["Scheduled tasks", "with tasks", look], ["Conversation", "with one open", look], ["Conversation", "with none", bare], ["Archive or delete", "", look]];
	for (const [where, options] of [["1440 light", desktop(1440, 900, LIGHT)], ["390 light", phone(LIGHT)]] as const) {
		const page = await openPage(browser, options, "off");
		for (const [label, state, rooms] of READS) {
			const at = `${where}, switch off, ${label} ${state}`.trim();
			const root = await openOn(page, label, rooms);
			same(await page.locator(".settings-look-next, [data-look-only], .room-schedules-state-dot, .room-schedules-run-dot, .rs-btn-danger-soft").count(), 0, `${at}: elements of the new look`);
			reading[at] = await readOffPage(root);
			if (label === "Folder" && rooms === look) {
				same(await root.locator(".folder-pane-location .also-allowed-actions button").evaluateAll((buttons) => buttons.map((button) => [button.className, button.textContent, button.getAttribute("aria-label")])), [["rs-btn", CHANGE_FOLDER, null], ["rs-btn rs-btn-icon rs-btn-sm also-allowed-cross", "", STOP_USING_FOLDER]], `${at}: Change folder, then the "×" named ${STOP_USING_FOLDER}`);
			}
			if (label === "Archive or delete") same(await root.getByRole("button", { name: "Delete room" }).getAttribute("class"), "rs-btn rs-btn-danger", `${at}: Delete room's classes`);
			if (label === "Conversation" && rooms === look) same(await root.getByRole("button", { name: "Forget" }).getAttribute("class"), "rs-btn", `${at}: Forget's classes`);
			if (label === "Scheduled tasks") same(await root.locator(".room-schedules-job-actions").first().getByRole("button").allTextContents(), ["Edit", "Disable", "Delete"], `${at}: a task's buttons`);
			await closeWindow(page);
		}
		await page.context().close();
	}
	if (process.env.LOOK_OFF_READING) fs.writeFileSync(process.env.LOOK_OFF_READING, JSON.stringify(reading, null, 1));
	console.log(`  ok  switch off: Folder (with and without a folder), Scheduled tasks, Conversation (with and without one open) and Archive or delete at 1440 and 390 with nothing of the new look, the "×" named "${STOP_USING_FOLDER}" and today's classes on Delete room and Forget${process.env.LOOK_OFF_READING ? ` (reading kept in ${process.env.LOOK_OFF_READING})` : ""}`);
}

/** The element only the look adds carries its own mark; none shows with the switch off, and each sits in a parent the switch-off page has too. */
async function checkLookOnly(browser: Browser): Promise<void> {
	const chainsOf = (page: Page, selector: string) => page.evaluate((selector) => [...document.querySelectorAll(selector)].map((element) => {
		const chain: string[] = [];
		for (let at = element.parentElement; at && !at.matches(".settings-dialog-pane"); at = at.parentElement) chain.push(`${at.tagName.toLowerCase()}.${[...at.classList].join(".")}`);
		return chain.join(" < ");
	}), selector);
	const read: Record<string, string[]> = {};
	for (const switchOn of [false, true]) {
		const page = await openPage(browser, desktop(1440), switchOn ? "on" : "off");
		await openOn(page, "Scheduled tasks");
		read[`${switchOn}`] = await chainsOf(page, switchOn ? "[data-look-only]" : ".settings-dialog-pane *");
		if (!switchOn) same(await page.locator("[data-look-only]").count(), 0, "switch off: elements marked as the look's own");
		await page.context().close();
	}
	same(read.true.length, 2, "switch on: the two tasks' Enabled switches carry the look's mark");
	for (const chain of read.true) assert(read.false.includes(chain), `switch on: a marked element's parents are not the switch-off page's: ${chain}`);
	console.log("  ok  the look's own element carries its mark only with the switch on, inside parents the switch-off page has");
}

// --- With the switch on -----------------------------------------------------------

async function checkFolderName(browser: Browser): Promise<void> {
	// 800 and 1000 are narrow desktop windows.
	for (const [where, options] of [["1440", desktop(1440)], ["1000", desktop(1000)], ["800", desktop(800)], ["390", phone()]] as const) {
		const page = await openPage(browser, options, "on");
		const root = await openOn(page, "Folder");
		const at = `${where}, Folder`;
		const read = await root.locator(".folder-pane-location").evaluate((row) => {
			const name = row.querySelector(".workspace-folder-name")!;
			const style = getComputedStyle(name);
			const spoken = row.querySelector(".sr-only");
			const main = row.querySelector(".settings-row-main")!;
			const button = row.querySelector(".also-allowed-actions")!;
			const box = (one: Element) => one.getBoundingClientRect();
			return {
				words: name.textContent,
				tip: name.getAttribute("title"),
				font: [style.fontFamily.includes("monospace"), style.fontSize, style.lineHeight],
				spoken: spoken?.textContent,
				// What a sighted person sees of it: nothing.
				spokenSize: spoken && [box(spoken).width, box(spoken).height],
				lines: [...main.children].map((line) => line.className),
				beside: box(button).top < box(main).bottom && box(button).left >= box(main).right,
			};
		});
		// The folder's name alone: its path in the tip and to a screen reader, never as text.
		same([read.words, read.tip, read.spoken, read.spokenSize, read.lines], [FOLDER_NAME, FOLDER, FOLDER, [1, 1], ["settings-row-label", "settings-row-sub"]], `${at}: the name alone, the whole path in its tip and to a screen reader`);
		same(read.font, [false, "13px", "18px"], `${at}: the name in the text face at 13/18`);
		same(read.beside, where !== "390", `${at}: the row's buttons beside the name${where === "390" ? ", on a phone under it" : ""}`);
		assert((await root.locator(".folder-pane-location").ariaSnapshot()).includes(FOLDER), `${at}: what a screen reader gets holds the whole path`);
		same(await sideways(page), [false, false], `${at}: sideways scrolling`);
		await closeWindow(page);
		// A room with no folder, and a page that is sent no path: nothing of a path.
		await openOn(page, "Folder", bare);
		same(await page.locator(".folder-pane-location .sr-only, .folder-pane-location [title]").count(), 0, `${at}, a room with no folder: a path's tip or words`);
		await closeWindow(page);
		await page.route("**/workspace-default", async (route) => {
			const answer = await route.fetch();
			const body = await answer.json();
			for (const root of body.policy?.roots ?? []) delete root.path;
			await route.fulfill({ response: answer, json: body });
		});
		const sent = await openOn(page, "Folder");
		await visible(page, ".workspace-folder-name").waitFor();
		same([await sent.locator(".workspace-folder-name").getAttribute("title"), await sent.locator(".folder-pane-location .settings-row-sub .sr-only").count()], [null, 0], `${at}, a page sent no path: the name's tip and spoken path`);
		await page.context().close();
	}
	console.log("  ok  Folder: the folder's name alone in the text face, its path whole in its tip and to a screen reader and nowhere as text, its buttons beside it above a phone's width; no path in a room with no folder or on a page sent none; nothing scrolls sideways at 1440, 1000, 800 or 390");
}

async function checkStopUsing(browser: Browser): Promise<void> {
	for (const [where, options] of [["1440", desktop(1440)], ["390", phone()]] as const) {
		const page = await openPage(browser, options, "on");
		await installColourTools(page);
		const root = await openOn(page, "Folder");
		const at = `${where}, Folder`;
		const buttons = root.locator(".folder-pane-location .also-allowed-actions button");
		const read = await buttons.evaluateAll((all) => all.map((button) => {
			const box = button.getBoundingClientRect();
			return { words: button.textContent, name: button.getAttribute("aria-label"), tip: button.getAttribute("title"), classes: button.className, fill: (window as any).__painted(getComputedStyle(button).backgroundColor), fits: button.scrollWidth <= button.clientWidth, left: box.left, right: box.right, middle: box.top + box.height / 2 };
		}));
		// As the released version's Location row: the filled "Change folder", then the small cross named and tipped "Stop using this folder".
		same(read.map(({ words, name, tip, classes, fill, fits }) => [words, name, tip, classes, fill, fits]), [[CHANGE_FOLDER, null, null, "rs-btn", true, true], ["", STOP_USING_FOLDER, STOP_USING_FOLDER, "rs-btn rs-btn-icon rs-btn-sm also-allowed-cross", false, true]], `${at}: the filled "${CHANGE_FOLDER}" then the cross "${STOP_USING_FOLDER}", both whole`);
		near(read[0].middle, read[1].middle, `${at}: the two buttons on one line`);
		// On a phone the cross stands at the card's edge, over an allowed folder's.
		if (where === "390") near(read[1].right, (await boxOf(root.locator(".folder-pane-location"))).right, `${at}: the cross at the card's edge`);
		same(await sideways(page), [false, false], `${at}: sideways scrolling`);
		// Pressing the cross asks today's question; Cancel keeps the folder.
		await buttons.nth(1).click();
		const question = page.locator(".confirm-dialog-backdrop");
		await question.waitFor();
		same([await question.locator("h2, .confirm-dialog-title").first().textContent(), (await question.textContent())!.includes(STOP_USING_FOLDER_BODY)], [stopUsingFolderTitle(FOLDER_NAME), true], `${at}: the question it asks`);
		await question.getByRole("button", { name: "Cancel" }).click();
		await question.waitFor({ state: "detached" });
		await visible(page, ".workspace-folder-name").waitFor();
		await closeWindow(page);
		// No folder yet: Choose folder is the page's one ink button.
		await openOn(page, "Folder", bare);
		same((await inkAndColour(page, ".settings-dialog-pane .room-workspace-section", INK[LIGHT])).inked, [CHOOSE_FOLDER], `${at}, a room with no folder: ink buttons`);
		await page.context().close();
	}
	console.log(`  ok  Folder: "${CHANGE_FOLDER}" then the cross "${STOP_USING_FOLDER}" on one line, both whole at 1440 and 390, asking today's question; "${CHOOSE_FOLDER}" the one ink button while no folder is chosen`);
}

/** A run row with a task name of 160 characters, the longest a task may have: its state stays whole, inside the card and clear of the time. */
async function longRunName(root: Locator, at: string): Promise<void> {
	const read = await root.locator(".room-schedules-run-list > .room-schedules-run").first().evaluate((run) => {
		const primary = run.querySelector(".room-schedules-run-primary")!;
		primary.querySelector("strong")!.textContent = "Quarterly summary of the reports ".repeat(5).slice(0, 160);
		const card = run.parentElement!.getBoundingClientRect();
		const status = primary.querySelector(".room-schedules-run-status")!;
		const time = primary.lastElementChild!.getBoundingClientRect();
		const box = status.getBoundingClientRect();
		return { whole: status.scrollWidth <= status.clientWidth, inside: box.right <= card.right, clear: box.right <= time.left || box.bottom <= time.top + 1 };
	});
	same(read, { whole: true, inside: true, clear: true }, `${at}: a run's state beside a 160-character name`);
}

async function checkSchedules(browser: Browser): Promise<void> {
	const measured: string[] = [];
	for (const theme of [LIGHT, DARK] as const) {
		const page = await openPage(browser, desktop(1440, 900, theme), "on");
		await installColourTools(page);
		const at = `${theme}, Scheduled tasks`;
		// No tasks: the muted line, no card, no ink button.
		await openOn(page, "Scheduled tasks", bare);
		const empty = visible(page, ".settings-dialog-pane .room-schedules-section");
		same([await empty.locator(".settings-empty").filter({ visible: true }).allTextContents(), await empty.locator(".room-schedules-list, .room-schedules-run-list, .settings-rows").filter({ visible: true }).count()], [["No scheduled tasks yet."], 0], `${at}, none: the muted line and no card`);
		same((await inkAndColour(page, ".settings-dialog-pane .room-schedules-section", INK[theme])).inked, [], `${at}, none: ink buttons`);
		await closeWindow(page);
		const root = await openOn(page, "Scheduled tasks");
		const seen = await inkAndColour(page, ".settings-dialog-pane .room-schedules-section", INK[theme]);
		same(seen.inked, [], `${at}: ink buttons`);
		same(seen.coloured, [], `${at}: colour other than dots and red buttons`);
		// Task rows: the Enabled switch on the card's text edge on every row; the state in plain words after a dot.
		const rows = await root.locator(".room-schedules-list > .room-schedules-job").evaluateAll((jobs) => jobs.map((job) => {
			const card = job.parentElement!;
			const cardStyle = getComputedStyle(card);
			const edge = card.getBoundingClientRect().right - parseFloat(cardStyle.borderRightWidth) - parseFloat(cardStyle.paddingRight);
			const toggle = job.querySelector<HTMLInputElement>("input.room-schedules-enabled")!;
			const state = job.querySelector(".room-schedules-record-state")!;
			const dot = state.previousElementSibling!;
			const w = window as any;
			const dotBox = dot.getBoundingClientRect();
			return {
				edge, switchRight: toggle.getBoundingClientRect().right, switchName: [toggle.getAttribute("role"), toggle.getAttribute("aria-label"), document.getElementById(toggle.getAttribute("aria-describedby")!)?.textContent], on: toggle.checked,
				state: state.textContent, stateWords: w.__seen(state, getComputedStyle(state).color), dot: [dot.className.split(" ")[0], dotBox.width, dotBox.height, Math.round(state.getBoundingClientRect().left - dotBox.right)],
				height: job.getBoundingClientRect().height,
			};
		}));
		same(rows.length, 2, `${at}: task rows`);
		for (const row of rows) {
			near(row.switchRight, row.edge, `${at}, ${row.switchName[2]}: the switch on the card's text edge`);
			same([row.switchName, row.on], [["switch", "Enabled", row.switchName[2]], true], `${at}: the switch's role and name`);
			same(row.dot, ["room-schedules-state-dot", 8, 8, 6], `${at}, ${row.state}: an 8 px dot 6 px before the state`);
			nearColour(row.stateWords, theme === LIGHT ? "#6d675f" : "#aaa39a", `${at}, ${row.state}: the state in muted words`);
		}
		same(rows[0].switchRight, rows[1].switchRight, `${at}: the switches on one edge`);
		// The switch turns the task off and on, as Disable and Enable did.
		const first = root.locator("input.room-schedules-enabled").first();
		await first.click();
		await waitUntil(async () => !(await first.isChecked()) && (await root.locator(".room-schedules-job").first().locator(".room-schedules-record-state").textContent()) === "Disabled", `${at}: the switch turns the task off`);
		await first.click();
		await waitUntil(async () => (await first.isChecked()) && !(await first.isDisabled()), `${at}: and on again`);
		// While a task's form is open its switch is gone, as Disable and Enable were: the form's Save would put the old value back.
		const job = root.locator(".room-schedules-job").first();
		await job.getByRole("button", { name: "Edit" }).click();
		await job.locator("form.room-schedules-form").waitFor();
		same(await job.locator("input.room-schedules-enabled").count(), 0, `${at}: a task's switch while its form is open`);
		await job.getByRole("button", { name: "Cancel" }).click();
		await job.locator("input.room-schedules-enabled").waitFor();
		// A new task saved with its two fields empty saves nothing: both are marked, red with the focus in the first, until filled.
		await root.getByRole("button", { name: "New task" }).click();
		const form = root.locator("form.room-schedules-form").first();
		const needed = form.locator(":is(input, textarea).launcher-path-input").filter({ visible: true });
		const made: string[] = [];
		// Its buttons stand under its fields, on their left edge, and none in the page's header.
		const foot = await form.evaluate((element) => {
			const left = (one: Element) => Math.round(one.getBoundingClientRect().left);
			const buttons = [...element.querySelectorAll(".settings-form-foot button")];
			return { words: buttons.map((one) => one.textContent), off: buttons.length && left(buttons[0]) - left(element.querySelector("input")!), under: buttons.length > 0 && buttons[0].getBoundingClientRect().top >= element.querySelector(".settings-rows")!.getBoundingClientRect().bottom };
		});
		same([foot, await root.locator(".pane-head-actions button").filter({ visible: true }).count()], [{ words: ["Save task", "Cancel"], off: 0, under: true }, 0], `${at}: a new task's buttons`);
		page.on("request", (request) => { if (request.method() === "POST" && /schedules/.test(request.url())) made.push(request.url()); });
		await page.getByRole("button", { name: "Save task", exact: true }).click();
		same([await needed.evaluateAll((all) => all.slice(0, 2).map((field) => [field.getAttribute("aria-invalid"), field === document.activeElement])), (await redEdges(needed)).slice(0, 2), made], [[["true", true], ["true", false]], [true, true], []], `${at}: Save task pressed empty`);
		await needed.nth(0).fill("Weekly letter");
		await needed.nth(1).fill("Draft the weekly letter.");
		same((await redEdges(needed)).slice(0, 2), [false, false], `${at}: both filled, the marks gone`);
		// Weekly with two days chosen: the chosen days lighter than their track, the others not, once the fade is over.
		await form.getByRole("radio", { name: "Weekly" }).click();
		for (const day of ["Monday", "Thursday"]) await form.getByRole("button", { name: day }).click();
		const days = await form.locator(".room-schedules-day-row").evaluate(async (track) => {
			await Promise.all(track.getAnimations({ subtree: true }).map((fade) => fade.finished));
			const w = window as any;
			return { fill: w.__fill(track) as string, days: [...track.children].map((day) => ({ name: day.getAttribute("aria-label"), chosen: day.getAttribute("aria-pressed") === "true", fill: w.__fill(day) as string, words: w.__contrast(day) as number })) };
		});
		same(days.days.filter((day) => day.chosen).map((day) => day.name), ["Monday", "Thursday"], `${at}: the days chosen`);
		same(days.days.map((day) => contrast(day.fill, "#000000") > contrast(days.fill, "#000000")), days.days.map((day) => day.chosen), `${at}: the chosen days lighter than the track, the others not (${days.days.map((day) => day.fill).join(", ")} on ${days.fill})`);
		for (const day of days.days.filter((one) => one.chosen)) {
			nearColour(day.fill, theme === LIGHT ? "#ffffff" : "#565655", `${at}: the fill of ${day.name}`);
			assert(day.words >= 4.5, `${at}: the words of ${day.name} at ${day.words.toFixed(2)}:1, under 4.5`);
		}
		await root.getByRole("button", { name: "Cancel" }).first().click();
		await root.locator("form.room-schedules-form").waitFor({ state: "detached" });
		// Run rows: a dot, and the time's words ending on the card's text edge.
		const runs = await root.locator(".room-schedules-run-list > .room-schedules-run").evaluateAll((all) => all.map((run) => {
			const card = run.parentElement!;
			const cardStyle = getComputedStyle(card);
			const edge = card.getBoundingClientRect().right - parseFloat(cardStyle.borderRightWidth) - parseFloat(cardStyle.paddingRight);
			const primary = run.querySelector(".room-schedules-run-primary")!;
			const dot = primary.firstElementChild!;
			const words = document.createRange();
			words.selectNodeContents(primary.lastElementChild!);
			return { edge, time: words.getBoundingClientRect().right, name: primary.querySelector("strong")!.getBoundingClientRect().left, dot: [dot.className.split(" ")[0], dot.getBoundingClientRect().width], line: primary.getBoundingClientRect().height, status: primary.querySelector(".room-schedules-run-status")!.textContent };
		}));
		same(runs.length, 2, `${at}: run rows`);
		near(runs[0].name, runs[1].name, `${at}: the runs' names on one edge, whatever their state`);
		await longRunName(root, at);
		for (const run of runs) {
			same([run.dot, run.line <= 20], [["room-schedules-run-dot", 8], true], `${at}, ${run.status}: a run's dot, on one line`);
			near(run.time, run.edge, `${at}, ${run.status}: the run's time ending on the card's text edge`);
		}
		// A task's Edit a box, as Delete is, starting on the task's text edge.
		const edit = root.locator(".room-schedules-job-actions").first().getByRole("button", { name: "Edit" });
		same(await edit.getAttribute("class"), "rs-btn rs-btn-sm rs-quiet", `${at}: a task's Edit`);
		near((await boxOf(edit)).left, (await boxOf(root.locator(".room-schedules-when-summary").first())).left, `${at}: a task's Edit on the text edge`);
		// A task's Delete is soft red.
		const remove = root.locator(".room-schedules-job-actions").first().getByRole("button", { name: "Delete" });
		same(await remove.getAttribute("class"), "rs-btn rs-btn-danger rs-btn-danger-soft rs-btn-sm rs-quiet", `${at}: a task's Delete`);
		const ratio = await remove.evaluate((button) => Number((window as any).__contrast(button).toFixed(2)));
		assert(ratio >= 4.5, `${at}: a task's Delete at ${ratio}:1`);
		measured.push(`${theme} task Delete ${ratio}`);
		await page.context().close();
	}
	// At 390: Edit's box on the task's text edge, and the runs' names on one edge.
	const small = await openPage(browser, phone(), "on");
	const tasks = await openOn(small, "Scheduled tasks");
	near((await boxOf(tasks.locator(".room-schedules-job-actions").first().getByRole("button", { name: "Edit" }))).left, (await boxOf(tasks.locator(".room-schedules-when-summary").first())).left, "390, Scheduled tasks: a task's Edit on the text edge");
	const names = await tasks.locator(".room-schedules-run-primary strong").evaluateAll((all) => all.map((name) => name.getBoundingClientRect().left));
	near(names[0], names[1], "390, Scheduled tasks: the runs' names on one edge");
	await longRunName(tasks, "390, Scheduled tasks");
	// A task's form: the choice of when stands under its label, both on the card's text edge.
	await tasks.getByRole("button", { name: "New task" }).click();
	const when = tasks.locator("#schedule-create-form .settings-row").first();
	same(await when.evaluate((row) => [...row.children].map((one) => Math.round(one.getBoundingClientRect().left - row.getBoundingClientRect().left))), [0, 0], "390, a new task: Runs and its choices on one edge");
	await small.context().close();
	console.log(`  ..  ${measured.join("; ")}`);
	console.log("  ok  Scheduled tasks, both themes: none, a muted line and no card; no ink button; the Enabled switch on the card's text edge on every task row, turning it off and on, and gone while the task's form is open; the state in muted words after an 8 px dot; run rows with a dot, their names on one edge, their state whole beside a 160-character name, and their times ending on the card's text edge; a task's Edit a box on the text edge at 1440 and 390; a task's Delete in soft red at 4.5:1; a new task's chosen days lighter than their track, the others not; no other colour");
}

async function checkConversationAndDelete(browser: Browser): Promise<void> {
	const measured: string[] = [];
	for (const theme of [LIGHT, DARK] as const) {
		const page = await openPage(browser, desktop(1440, 900, theme), "on");
		await installColourTools(page);
		const at = `${theme}`;
		// None open: the muted line, no card.
		await openOn(page, "Conversation", bare);
		const none = visible(page, ".settings-dialog-pane .room-session-section");
		same([await none.locator(".settings-empty").count(), await none.locator(".settings-rows").count()], [1, 0], `${at}, Conversation with none open: the muted line and no card`);
		await closeWindow(page);
		const conversation = await openOn(page, "Conversation");
		const forget = conversation.getByRole("button", { name: "Forget" });
		same(await forget.getAttribute("class"), "rs-btn rs-btn-danger rs-btn-danger-soft", `${at}: Forget's classes`);
		const forgetRatio = await forget.evaluate((button) => Number((window as any).__contrast(button).toFixed(2)));
		assert(forgetRatio >= 4.5, `${at}: Forget at ${forgetRatio}:1`);
		const card = await boxOf(conversation.locator(".settings-rows"));
		near((await boxOf(forget)).right, card.right - 17, `${at}: Forget ends on the card's padding`);
		same((await inkAndColour(page, ".settings-dialog-pane .room-session-section", INK[theme])).coloured, [], `${at}, Conversation: colour other than red buttons`);
		await closeWindow(page);
		// Archive or delete: two cards 12 apart, their buttons 32 tall and ending on one edge.
		const zone = await openOn(page, "Archive or delete");
		const cards = await zone.locator(".settings-row").evaluateAll((rows) => rows.map((row) => {
			const style = getComputedStyle(row);
			const button = row.querySelector("button")!;
			const box = row.getBoundingClientRect();
			const buttonBox = button.getBoundingClientRect();
			return { words: button.textContent, card: [style.borderTopWidth, style.borderTopStyle, style.borderTopLeftRadius], top: box.top, bottom: box.bottom, right: box.right, buttonRight: buttonBox.right, buttonHeight: buttonBox.height, classes: button.className };
		}));
		same(cards.map(({ words, card, buttonHeight, classes }) => [words, card, buttonHeight, classes]), [["Archive", ["1px", "solid", "12px"], 32, "rs-btn"], ["Delete room", ["1px", "solid", "12px"], 32, "rs-btn rs-btn-danger rs-btn-danger-soft"]], `${at}: Archive and Delete as two cards with 32 px buttons`);
		near(cards[1].top - cards[0].bottom, 12, `${at}: 12 px between the cards`);
		near(cards[0].buttonRight, cards[1].buttonRight, `${at}: the buttons end on one edge`);
		near(cards[1].buttonRight, cards[1].right - 17, `${at}: on the card's padding`);
		const deleteRoom = zone.getByRole("button", { name: "Delete room" });
		const deleteRatio = await deleteRoom.evaluate((button) => Number((window as any).__contrast(button).toFixed(2)));
		assert(deleteRatio >= 4.5, `${at}: Delete room at ${deleteRatio}:1`);
		measured.push(`${theme} Forget ${forgetRatio}, Delete room ${deleteRatio}`);
		same((await inkAndColour(page, ".settings-dialog-pane .room-danger-zone", INK[theme])).coloured, [], `${at}, Archive or delete: colour other than the red button`);
		// Its question as today: the red fill on the confirming answer, the focus on Cancel.
		await deleteRoom.click();
		const question = page.locator(".confirm-dialog-backdrop");
		await question.waitFor();
		const confirm = question.getByRole("button", { name: "Delete room" });
		same([await confirm.getAttribute("class"), await page.evaluate(() => document.activeElement?.textContent)], ["rs-btn rs-btn-primary rs-btn-danger", "Cancel"], `${at}: Delete room's question`);
		const fill = await confirm.evaluate((button) => (window as any).__fill(button));
		nearColour(fill, theme === LIGHT ? "#b42323" : "#d03030", `${at}: the confirming answer's red fill`);
		await page.keyboard.press("Escape");
		await question.waitFor({ state: "detached" });
		await page.context().close();
	}
	// At 390 a row with a red button turns into a column: the soft red box starts on its words' edge, not pulled out as red words are.
	const small = await openPage(browser, phone(), "on");
	for (const [label, name] of [["Conversation", "Forget"], ["Archive or delete", "Delete room"]] as const) {
		const root = await openOn(small, label);
		const row = root.locator(".settings-row").filter({ has: small.getByRole("button", { name }) });
		near((await boxOf(row.getByRole("button", { name }))).left, (await boxOf(row.locator(".settings-row-label"))).left, `390, ${label}: ${name}'s box starts on the words' edge`);
		await closeWindow(small);
	}
	// And Archive or delete's two cards share one shape there: each button under its words, on their edge, the same distance below them.
	const zone = await openOn(small, "Archive or delete");
	const shapes = await zone.locator(".settings-row").evaluateAll((rows) => rows.map((row) => {
		const words = row.querySelector(".settings-row-main")!.getBoundingClientRect();
		const button = row.querySelector("button")!.getBoundingClientRect();
		return { name: row.querySelector("button")!.textContent, onEdge: Math.abs(button.left - words.left) <= 1, below: Math.round(button.top - words.bottom) };
	}));
	same(shapes.map(({ name, onEdge }) => [name, onEdge]), [["Archive", true], ["Delete room", true]], "390, Archive or delete: each button on its words' edge");
	same(shapes[0].below, shapes[1].below, "390, Archive or delete: each button the same distance under its words");
	await small.context().close();
	console.log(`  ..  ${measured.join("; ")}`);
	console.log("  ok  Conversation and Archive or delete, both themes: none open, a muted line and no card; Forget and Delete room in soft red at 4.5:1 on the card's padding, and at 390 starting on their words' edge, Archive's and Delete room's cards in one shape; Archive and Delete two cards 12 apart with 32 px buttons on one edge; Delete room's question with its red answer and the focus on Cancel");
}

async function checkSoftRed(browser: Browser): Promise<void> {
	// The red fill's colour at 8, 12 and 16 % over the card, per theme.
	const want = { [LIGHT]: { red: "#b42323", card: "#ffffff" }, [DARK]: { red: "#d03030", card: "#373737" } };
	const mix = (theme: Theme, share: number) => {
		const [over, under] = [want[theme].red, want[theme].card].map((hex) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16)));
		return `#${under.map((value, i) => Math.round(over[i] * share + value * (1 - share)).toString(16).padStart(2, "0")).join("")}`;
	};
	const measured: string[] = [];
	for (const theme of [LIGHT, DARK] as const) {
		const page = await openPage(browser, desktop(1440, 900, theme), "on");
		await installColourTools(page);
		const zone = await openOn(page, "Archive or delete");
		const button = zone.getByRole("button", { name: "Delete room" });
		const read = () => button.evaluate((element) => { const w = window as any; return { fill: w.__fill(element) as string, ratio: Number(w.__contrast(element).toFixed(2)) }; });
		const settle = async (share: number, what: string) => {
			await waitUntil(async () => { try { nearColour((await read()).fill, mix(theme, share), ""); return true; } catch { return false; } }, `${theme}: ${what} settles`, 2000).catch(() => {});
			const seen = await read();
			nearColour(seen.fill, mix(theme, share), `${theme}: Delete room ${what}`);
			assert(seen.ratio >= 4.5, `${theme}: Delete room ${what} at ${seen.ratio}:1`);
			measured.push(`${theme} ${what} ${seen.ratio}`);
		};
		await settle(0.08, "at rest");
		await button.hover();
		await settle(0.12, "under the pointer");
		await page.mouse.down();
		await settle(0.16, "pressed");
		// Let go inside the pane: over the backdrop it would close the window.
		const pane = (await page.locator(".settings-dialog-pane").first().boundingBox())!;
		await page.mouse.move(pane.x + 8, pane.y + 8);
		await page.mouse.up();
		await button.focus();
		await page.keyboard.press("Shift+Tab");
		await page.keyboard.press("Tab");
		same(await button.evaluate((element) => { const style = getComputedStyle(element); return [element.matches(":focus-visible"), style.outlineStyle, style.outlineWidth, style.outlineOffset]; }), [true, "solid", "2px", "2px"], `${theme}: Delete room's keyboard ring`);
		await button.evaluate((element) => { (element as HTMLButtonElement).disabled = true; });
		same(await button.evaluate((element) => getComputedStyle(element).opacity), "0.45", `${theme}: Delete room disabled`);
		await page.context().close();
	}
	console.log(`  ..  ${measured.join("; ")}`);
	console.log("  ok  the soft red button, both themes: the red fill's colour at 8, 12 and 16 % at rest, under the pointer and pressed, its words at 4.5:1 on each; the 2 px keyboard ring; disabled at 45 %");
}

let model: http.Server | undefined;
try {
	const agents = await import("../src/persistent-agents.js");
	const lookRoom = agents.createPersistentAgentFromScaffoldInput({ displayName: ROOM, userName: "Synthetic User", preferredUserAddress: "Synthetic User" }).agent.agentId;
	agents.createPersistentAgentFromScaffoldInput({ displayName: BARE_ROOM, userName: "Synthetic User", preferredUserAddress: "Synthetic User" });
	// A model server is never asked here: the room's conversation is stored, not answered.
	const modelPort = await freePort();
	model = http.createServer((_req, res) => { res.writeHead(500); res.end(); }).listen(modelPort, "127.0.0.1");
	const appDir = path.join(tempHome, ".exxperts", "app");
	fs.writeFileSync(path.join(agentDir, "models.json"), JSON.stringify({ providers: { synthetic: { name: "Synthetic", baseUrl: `http://127.0.0.1:${modelPort}/v1`, api: "openai-completions", models: [{ id: "room-model", name: "Room Model", input: ["text"], contextWindow: 128000, maxTokens: 16384 }] } } }));
	fs.writeFileSync(path.join(appDir, "custom-ai-profiles.json"), JSON.stringify({ version: 1, profiles: [{ id: "custom-synthetic", providerId: "synthetic", label: "Synthetic", roomModels: ["room-model"], learnModel: "room-model", reviewMemoryModel: "room-model" }] }));
	fs.writeFileSync(path.join(appDir, "persistent-agent-ai-profile.json"), JSON.stringify({ profileId: "custom-synthetic" }));
	await startServer();
	const seed = async (method: "POST" | "PUT", route: string, body: unknown) => {
		const answer = await authedFetch(`${baseUrl}${route}`, { method, headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
		const text = await answer.text();
		assert(answer.ok, `seeding ${route}: ${answer.status} ${text}`);
		return JSON.parse(text) as { jobs?: Array<{ id: string; name: string }> };
	};
	await seed("POST", "/api/auth/api-key", { provider: "synthetic", key: "synthetic-test-key" });
	// What's new seen before any page opens: a window of it showing late would be closed, and its request sent, while a settings window waits for its own.
	await seed("POST", "/api/whats-new/seen", {});
	const room = `/api/persistent-agents/${encodeURIComponent(lookRoom)}`;
	fs.mkdirSync(FOLDER, { recursive: true });
	await seed("PUT", `${room}/workspace-default`, { root: FOLDER, workspaceAccessMode: "localFiles", bashEnabled: true });
	await seed("POST", `${room}/schedules`, { name: "Weekly summary", type: "cron", schedule: "0 0 9 * * 1", prompt: "Write the weekly summary of the reports.", enabled: true });
	const { jobs } = await seed("POST", `${room}/schedules`, { name: "Check the new figures", type: "once", schedule: "+30m", prompt: "Check the figures that came in today.", enabled: true });
	const weekly = jobs!.find((job) => job.name === "Weekly summary")!.id;
	// Two runs of the weekly task on fixed days, one done and one failed.
	const { createBackgroundRun } = await import("../src/background-runs.js");
	for (const [status, day] of [["succeeded", "2026-01-05T09:00:00.000Z"], ["failed", "2026-01-12T09:00:00.000Z"]] as const) {
		createBackgroundRun({ kind: "scheduled-prompt", scope: { kind: "persistent-room", roomId: lookRoom }, source: { trigger: "schedule-due", schedulerJobId: weekly, dueAt: day }, status, reason: status === "failed" ? "model_error" : "completed", message: "Synthetic run.", target: { kind: "none", roomId: lookRoom }, warnings: [], ...(status === "failed" ? { error: { code: "model_error", message: "The model did not answer." } } : {}), now: new Date(day) });
	}
	// An open conversation, so Conversation shows Forget.
	await seed("PUT", `${room}/threads/pi_look_conversation_0001`, { state: "active", origin: "launcher", model: { provider: "synthetic", model: "room-model" }, items: [] });

	const browser = await chromium.launch({ ignoreDefaultArgs: ["--hide-scrollbars"] });
	try {
		// Each row runs on its own and the run fails at the end with every row that failed.
		const only = process.env.LOOK_ROWS?.split(",").map((name) => name.trim()).filter(Boolean);
		const failed: string[] = [];
		for (const row of [checkRulesUnderSwitch, checkOff, checkLookOnly, checkFolderName, checkStopUsing, checkSchedules, checkConversationAndDelete, checkSoftRed]) {
			if (only && !only.includes(row.name)) continue;
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
	console.log("settings look room folder ui smoke passed");
} finally {
	model?.close();
	await stopSmokeServer(server);
	fs.rmSync(tempRoot, { recursive: true, force: true });
}
