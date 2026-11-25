// The settings look on Settings, Skills and a room's Skills page, and the
// room's sidebar groups, built behind the look's switch. With the switch off
// both pages keep today's markup and styles (a reader writes both to a file,
// to compare a page built from before this change with this one). With it on,
// both themes: the header's one button with its caret and the add menu;
// the table on one grid, its rows, the tag and Update; the lines above the
// table as messages, "Update <name>" when one skill has an update; a room's
// search on the title line, its rows, a reason with "Open skill", groups, no
// match and an empty library; the room's three sidebar groups; at 390 px too.
// The parts skill updates added after the look was drawn (the notice of what
// Update automatically did, Update all and its line) keep their old look with
// it on, and break nothing.
// The repositories are folders on this machine; throwaway HOME.
//
// Run: node scripts/run-smokes.mjs settings-look-skills-ui
// SKILLS_LOOK_OFF_DUMP=<file> runs only the switch-off reader and writes what
// it read, to compare a run on the base commit with one on this branch.
import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, type Browser, type BrowserContextOptions, type Page } from "playwright";
import { authedFetch, freePort, SMOKE_SERVER_AUTH_ENV, SMOKE_SERVER_SPAWN_TREE_OPTIONS, smokeHomeEnv, stopSmokeServer, waitForServer } from "./smoke-server-process.js";
import { waitEvery } from "./smoke-wait.js";
import { answered, assert, DARK, desktop, goToPage, installColourTools, LIGHT, lookPages, nearColour, notLookPageFilesAfterLook, phone, rulesOutsideRoots, same, SWITCH_CLASS, type Theme } from "./settings-look-smoke-parts.js";
// A namespace import, so the switch-off reader also runs against the page's code from before "Open skill" existed.
import * as copy from "../../web-ui/src/skill-source-copy.js";

const waitUntil = waitEvery(100);

{
	const executable = typeof chromium?.executablePath === "function" ? chromium.executablePath() : "";
	if (!executable || !fs.existsSync(executable)) {
		console.log("settings look skills ui smoke skipped (Chromium not installed)");
		process.exit(0);
	}
}

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const webServerDir = path.resolve(scriptDir, "..");
const repoRoot = path.resolve(webServerDir, "..", "..");
const LOOK_FILE = "48-settings-look-skills.css";
const tempRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "exxperts-settings-look-skills-")));
const tempHome = path.join(tempRoot, "home");
const agentDir = path.join(tempHome, ".exxperts", "agent");
const store = path.join(agentDir, "skills");
const repos = path.join(tempRoot, "repos");
fs.mkdirSync(store, { recursive: true });
const port = await freePort();
const baseUrl = `http://127.0.0.1:${port}`;
const ROOM = "Monthly reporting";
const QUIET_ROOM = "Quiet room";
const room = lookPages({ baseUrl, room: ROOM });
const quietRoom = lookPages({ baseUrl, room: QUIET_ROOM });
const { openPage, openWindow } = room;
/** The look's ink, and the colours this page's words take, per theme. */
const INK = { [LIGHT]: "#111111", [DARK]: "#f4f1ec" };

// --- The library ---------------------------------------------------------------

function git(repo: string, args: string[]): void {
	const run = spawnSync("git", ["-c", "user.email=smoke@test", "-c", "user.name=Smoke", ...args], { cwd: repo, encoding: "utf-8" });
	if (run.status !== 0) throw new Error(`git ${args.join(" ")}: ${run.stderr || run.stdout}`);
}
function writeSkill(root: string, name: string, description: string, body = `The ${name} instructions.`, extra = ""): string {
	fs.mkdirSync(path.join(root, name), { recursive: true });
	const manifest = `---\nname: ${name}\ndescription: ${description}\n${extra}---\n\n${body}\n`;
	fs.writeFileSync(path.join(root, name, "SKILL.md"), manifest);
	return manifest;
}
/** A new commit in a repository that changes one skill's instructions. */
function changeUpstream(repo: string, name: string, body: string): void {
	writeSkill(path.join(repos, repo, "skills"), name, DESCRIPTIONS[name], body);
	git(path.join(repos, repo), ["add", "-A"]);
	git(path.join(repos, repo), ["commit", "-q", "-m", body.slice(0, 40)]);
}
/** A skill id as long as an id may be (48 characters), and a long display name in its file. */
const LONG = "quarterly-board-report-from-finance-and-sales-fi";
const LONG_DISPLAY = "Quarterly board report from the finance and sales figures, north region";
const DESCRIPTIONS: Record<string, string> = {
	"internal-comms": "Write internal announcements, newsletters and status updates in the house style.",
	pdf: "Read, fill in and combine PDF files.",
	letters: "Answer customer letters in the house style.",
	[LONG]: "Turn the quarter's figures into the board's report.",
};
async function api(method: string, route: string, body?: unknown): Promise<{ status: number; body: any }> {
	const answer = await authedFetch(`${baseUrl}${route}`, { method, ...(body === undefined ? {} : { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }) });
	const text = await answer.text();
	return { status: answer.status, body: text ? JSON.parse(text) : null };
}

const seeded = (answer: { status: number; body: any }, what: string) => assert(answer.status >= 200 && answer.status < 300, `seeding ${what}: ${answer.status} ${JSON.stringify(answer.body)}`);

// --- Opening the two pages --------------------------------------------------------

/** Settings, Skills, open and filled in; `probe` stands in for the client-context answer (a shared server). */
async function openSkills(browser: Browser, options: BrowserContextOptions, look: "on" | "off" = "on", probe?: Record<string, unknown>): Promise<Page> {
	const page = await openPage(browser, options, look);
	if (probe) {
		await page.route("**/api/remote/client-context", (route) => route.fulfill({ contentType: "application/json", body: JSON.stringify(probe) }));
		await page.reload();
		await page.locator(".persistent-agent-card").first().waitFor({ timeout: 15000 });
		const dismiss = page.locator(".whats-new-close");
		if (await dismiss.count()) await dismiss.click();
	}
	await openWindow(page, "settings");
	await goToPage(page, "Skills");
	await page.locator(".skills-page :is(.skill-table, .settings-empty)").first().waitFor({ timeout: 10000 });
	await answered(page, "Settings, Skills");
	return page;
}
/** A room's Skills page, open and filled in. */
async function openRoomSkills(browser: Browser, options: BrowserContextOptions, look: "on" | "off" = "on", which = room): Promise<Page> {
	const page = await which.openPage(browser, options, look);
	await which.openWindow(page, "room");
	await goToPage(page, "Skills");
	await page.locator(`${ROOM_SKILLS} :is(.room-skill, .settings-empty)`).first().waitFor({ timeout: 10000 });
	await answered(page, "a room's Skills");
	return page;
}
const ROOM_SKILLS = ".room-settings-section:not([hidden]) .room-skills-section:not(.room-connectors-section)";
const SKILLS = ".settings-dialog-pane .skills-page";
const button = (page: Page, name: string | RegExp) => page.locator(".settings-dialog").getByRole("button", { name, exact: typeof name === "string" });

/** The rows whose Update, while it says Updating…, is wider than the room its row keeps for it. */
const updatesOverWords = (page: Page) => page.evaluate((root) => [...document.querySelectorAll(`${root} .skill-row-line`)].filter((line) => {
	const button = line.querySelector(".skill-row-update button");
	if (!button) return false;
	const busy = button.cloneNode() as HTMLElement;
	busy.textContent = "Updating…";
	button.after(busy);
	const over = busy.getBoundingClientRect().width > line.querySelector(".skill-table-update-slot")!.getBoundingClientRect().width + 0.5;
	busy.remove();
	return over;
}).map((line) => line.querySelector(".skill-table-name")!.textContent), SKILLS);

/** For each address cut with "…", how far its drawn end is from its box's end, where the gap to the next words starts. */
async function cutAddressGaps(page: Page): Promise<number[]> {
	const gaps: number[] = [];
	for (const address of await page.locator(`${SKILLS} .skill-table-from`).all()) {
		if (!(await address.evaluate((box) => box.scrollWidth > box.clientWidth))) continue;
		const picture = (await address.screenshot({ animations: "disabled" })).toString("base64");
		gaps.push(await address.evaluate(async (box, picture) => {
			const image = new Image();
			image.src = `data:image/png;base64,${picture}`;
			await image.decode();
			const canvas = document.createElement("canvas");
			[canvas.width, canvas.height] = [image.width, image.height];
			const context = canvas.getContext("2d", { willReadFrequently: true })!;
			context.drawImage(image, 0, 0);
			const { data } = context.getImageData(0, 0, image.width, image.height);
			const drawn = (x: number) => Array.from({ length: image.height }, (_, y) => (y * image.width + x) * 4).some((at) => [0, 1, 2].some((c) => Math.abs(data[at + c] - data[c]) > 40));
			let end = image.width - 1;
			while (end > 0 && !drawn(end)) end--;
			return Math.round((image.width - 1 - end) * box.getBoundingClientRect().width / image.width * 2) / 2;
		}, picture));
	}
	return gaps;
}

/** Presses Check now and waits for its answer and the list read after it. */
async function checkNow(page: Page): Promise<void> {
	await button(page, copy.CHECK_NOW).click();
	await waitUntil(async () => (await page.locator(`${SKILLS} .skill-check-now[aria-busy="true"]`).count()) === 0, "the check is answered", 30000);
	await answered(page, "after the check");
}

/** A colour as the page resolves it, from a probe inside the window (a token's value in this theme). */
const resolved = (page: Page, value: string, property = "color") => page.evaluate(({ value, property }) => {
	const probe = document.createElement("i");
	probe.style.setProperty(property, value);
	document.querySelector(".settings-dialog")!.append(probe);
	const read = getComputedStyle(probe).getPropertyValue(property);
	probe.remove();
	return read;
}, { value, property });

/** At most one ink button, and nothing coloured but a dot (drawn as ::before) or a red button, under `root`. Needs installColourTools. */
async function checkShared(page: Page, root: string, theme: Theme, at: string): Promise<void> {
	await page.mouse.move(2, 2);
	const read = await page.evaluate(({ root, ink }) => {
		const w = window as any;
		const shown = (element: Element) => { const box = element.getBoundingClientRect(); return box.width > 0 && box.height > 0 && getComputedStyle(element).visibility !== "hidden"; };
		const chroma = (hex: string) => { const rgb = [1, 3, 5].map((at) => parseInt(hex.slice(at, at + 2), 16)); return Math.max(...rgb) - Math.min(...rgb); };
		const all = [...document.querySelectorAll(`${root}, ${root} *`)].filter(shown);
		const inked = all.filter((element) => element.matches("button") && w.__painted(getComputedStyle(element).backgroundColor) && w.__seen(element, getComputedStyle(element).backgroundColor) === ink).map((element) => element.textContent!.trim());
		const coloured = all.flatMap((element) => {
			const style = getComputedStyle(element);
			const words = [...element.childNodes].some((node) => node.nodeType === Node.TEXT_NODE && node.textContent!.trim());
			return [words && ["words", style.color], w.__painted(style.backgroundColor) && ["fill", style.backgroundColor]]
				.filter((one): one is [string, string] => Boolean(one))
				.filter(([, colour]) => chroma(w.__seen(element, colour)) > 24 && !element.closest(".rs-btn-danger"))
				.map(([part]) => `${element.className} ${part}`);
		});
		return { inked, coloured };
	}, { root, ink: INK[theme] });
	assert(read.inked.length <= 1, `${at}: ${read.inked.length} ink buttons: ${read.inked.join(", ")}`);
	same(read.coloured, [], `${at}: colour on anything but a dot or a red button`);
}

/** Each word's contrast against what is behind it, for the elements named. Needs installColourTools. */
async function contrasts(page: Page, selectors: string[]): Promise<Record<string, number>> {
	return page.evaluate((selectors) => Object.fromEntries(selectors.map((selector) => {
		const element = [...document.querySelectorAll(selector)].find((one) => one.getClientRects().length > 0);
		return [selector, element ? Math.round((window as any).__contrast(element) * 10) / 10 : 0];
	})), selectors);
}

// --- With the switch off ------------------------------------------------------------

/** One page as it renders: its markup, with React's generated ids, this run's folders and the last check's time blanked, and every element's computed style (with its ::before and ::after) as a hash. */
async function readPane(page: Page, root: string): Promise<{ markup: string; styles: string[]; rootStyle: string[] }> {
	await page.mouse.move(2, 2);
	// A button just pressed is still fading back from its hover: read once every finite transition has ended, or its hash changes from run to run.
	await page.evaluate(async () => {
		await new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done)));
		await Promise.all(document.getAnimations().filter((one) => one.effect?.getComputedTiming().endTime !== Infinity).map((one) => one.finished.catch(() => undefined)));
	});
	const read = await page.evaluate((root) => {
		const element = [...document.querySelectorAll(root)].find((one) => one.getClientRects().length > 0)!;
		const hash = (text: string) => { let h = 0x811c9dc5; for (let i = 0; i < text.length; i++) { h ^= text.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; } return h.toString(16).padStart(8, "0"); };
		// Sorted: the browser lists custom properties in an order that changes between runs.
		const styleOf = (target: Element, pseudo?: string) => { const style = getComputedStyle(target, pseudo); const out: string[] = []; for (let i = 0; i < style.length; i++) out.push(`${style[i]}:${style.getPropertyValue(style[i])}`); return out.sort().join(";"); };
		const styles = [element, ...element.querySelectorAll("*")].map((one) => `${one.tagName.toLowerCase()}.${(one.getAttribute("class") ?? "").trim().split(/\s+/).join(".")} ${hash(styleOf(one))} ${hash(styleOf(one, "::before"))} ${hash(styleOf(one, "::after"))}`);
		// The root's whole style as well, so a difference the hashes find can be named.
		return { markup: element.outerHTML, styles, rootStyle: styleOf(element).split(";") };
	}, root);
	const markup = read.markup
		.split(tempRoot).join("<tmp>")
		.replace(/:r[0-9a-z]+:|«r[0-9a-z]+»/g, "<id>")
		.replace(/Last checked [^<]*\./g, "Last checked <when>.");
	return { markup, styles: read.styles, rootStyle: read.rootStyle };
}

/** Today's shape, which the new look's markup would break: no look class, the header's order and kinds, no message strip, caret or "Open skill". */
async function readOffFacts(page: Page) {
	return page.evaluate(() => ({
		look: document.querySelectorAll(".settings-look-next, .skill-message, .skill-add-caret, .room-skill-open-link").length,
		// The header's kinds only: the notice's Close is quiet in both looks.
		primary: document.querySelectorAll(".skills-page .pane-head-actions :is(.rs-btn-primary, .rs-btn-quiet), .skill-row-update .rs-btn-sm").length,
		actions: [...document.querySelectorAll(".skills-page .pane-head-actions button")].map((one) => one.textContent!.trim()),
	}));
}

const offDump: Record<string, Awaited<ReturnType<typeof readPane>>> = {};
async function readOff(browser: Browser, what: "skills" | "room" | "quiet", label: string, prepare?: (page: Page) => Promise<void>): Promise<void> {
	for (const [width, options] of [["1440", desktop(1440, 900, LIGHT)], ["390", phone(LIGHT)]] as const) {
		const page = what === "skills" ? await openSkills(browser, options, "off") : await openRoomSkills(browser, options, "off", what === "quiet" ? quietRoom : room);
		if (prepare) await prepare(page);
		const at = `switch off, ${label}, ${width}`;
		const facts = await readOffFacts(page);
		same(facts.look, 0, `${at}: the new look's classes`);
		same(facts.primary, 0, `${at}: the new look's button kinds`);
		if (what === "skills") same(facts.actions.map((name) => name.replace(/\W+$/, "")), ["Add skill"], `${at}: the header's one action`);
		offDump[at] = await readPane(page, what === "skills" ? SKILLS : ROOM_SKILLS);
		await page.context().close();
	}
}

async function checkOff(browser: Browser): Promise<void> {
	// Before any check: no skill shows an update.
	await readOff(browser, "skills", "Settings, Skills, on opening", async (page) => {
		same(await page.locator(`${SKILLS} .skill-row-update`).count(), 0, "switch off, on opening: no Update");
	});
	// After a check on the page read: pdf's update found, and a repository that can't be asked.
	await readOff(browser, "skills", "Settings, Skills, after a check", async (page) => {
		fs.renameSync(path.join(repos, "letters"), path.join(repos, "letters-away"));
		try {
			await checkNow(page);
		} finally {
			fs.renameSync(path.join(repos, "letters-away"), path.join(repos, "letters"));
		}
		same(await page.locator(`${SKILLS} .skill-updates-line:not(.skill-updates-checked)`).count(), 2, "switch off, after a check: its two lines");
	});
	await readOff(browser, "room", "a room's Skills");
	await readOff(browser, "room", "a room's Skills, no match", async (page) => {
		await page.locator(`${ROOM_SKILLS} .room-skills-search`).fill("zzz");
		await page.locator(`${ROOM_SKILLS} .room-skills-empty`).waitFor();
	});
	// With the switch on, the two Connectors pages share these pages' classes and stay as they were.
	for (const [label, open] of [
		["switch on, Settings, Connectors", async (one: Page) => { await openWindow(one, "settings"); await goToPage(one, "Connectors"); }],
		["switch on, a room's Connectors", async (one: Page) => { await openWindow(one, "room"); await goToPage(one, "Connectors"); }],
	] as const) {
		const one = await openPage(browser, desktop(1440, 900, LIGHT), "on");
		await open(one);
		await answered(one, label);
		offDump[`${label}, 1440`] = await readPane(one, label.includes("room") ? ".room-settings-section:not([hidden]) .room-connectors-section" : ".settings-dialog-pane .connectors-page, .settings-dialog-pane > *");
		await one.context().close();
	}
	console.log("  ok  switch off: Settings, Skills and a room's Skills (on and off, by hand, files that can't be opened, no match) keep today's header, kinds and parts at 1440 and 390; the room's sidebar starts no group");
}

/** Every rule of the look's skills file starts with the switch's class. */
async function checkRulesUnderSwitch(browser: Browser): Promise<void> {
	const page = await openPage(browser, desktop(1280), "off");
	const css = fs.readFileSync(path.join(repoRoot, "apps", "web-ui", "src", "styles", LOOK_FILE), "utf8");
	same(await rulesOutsideRoots(page, css, [SWITCH_CLASS]), [], `rules in ${LOOK_FILE} outside ${SWITCH_CLASS}`);
	// The check's own probe: a rule outside the class is found, in a media query too, and a longer class name is not the class.
	same(await rulesOutsideRoots(page, `.skill-tag { color: red; } @media (max-width: 760px) { ${SWITCH_CLASS} .skill-row, .skill-row-update { top: 0; } } ${SWITCH_CLASS}-x .skill-tag { color: red; } .settings-dialog .room-skill { color: red; }`, [SWITCH_CLASS]), [".skill-tag", ".skill-row-update", `${SWITCH_CLASS}-x .skill-tag`, ".settings-dialog .room-skill"], "the check's own probe");
	const imports = [...fs.readFileSync(path.join(repoRoot, "apps", "web-ui", "src", "styles.css"), "utf8").matchAll(/@import "\.\/styles\/([^"]+)";/g)].map((match) => match[1]);
	same(notLookPageFilesAfterLook(imports), [], "style files after the look's first that are not its page files");
	assert(imports.includes(LOOK_FILE), `the page loads ${LOOK_FILE}`);
	await page.context().close();
	console.log(`  ok  every rule of ${LOOK_FILE} sits under ${SWITCH_CLASS}, and the page loads it with the look's page files`);
}

// --- With the switch on: the room's sidebar ---------------------------------------------

async function checkRoomGroups(browser: Browser): Promise<void> {
	const page = await openPage(browser, desktop(1440, 900, LIGHT), "on");
	await openWindow(page, "room");
	const gaps = await page.evaluate(() => {
		const items = [...document.querySelectorAll(".settings-dialog-nav-item:not(.danger)")];
		return items.slice(1).map((item, i) => `${item.textContent} ${Math.round(item.getBoundingClientRect().top - items[i].getBoundingClientRect().bottom)}`);
	});
	// One even list: no gap between groups of pages.
	same(gaps, ["Memory 2", "Instructions 2", "Folder 2", "Skills 2", "Connectors 2", "Scheduled tasks 2", "Conversation 2"], "1440: the space before each item of the room's sidebar");
	await page.context().close();
	const small = await openPage(browser, phone(LIGHT), "on");
	await openWindow(small, "room");
	// On a phone the window may open on a page or on the list of pages.
	if (await small.locator(".settings-dialog-back").isVisible()) await small.locator(".settings-dialog-back").click();
	await small.locator(".settings-dialog-nav-item").first().waitFor();
	const lines = await small.evaluate(() => [...document.querySelectorAll(".settings-dialog-nav-item")].map((item) => `${item.textContent} ${parseFloat(getComputedStyle(item).borderBottomWidth) >= 1 ? "line" : "none"}`));
	same(lines, ["Model line", "Memory line", "Instructions line", "Folder line", "Skills line", "Connectors line", "Scheduled tasks line", "Conversation none", "Archive or delete none"], "390: a line under each row but the one before Archive or delete and the last");
	await small.context().close();
	console.log("  ok  the room's sidebar: one even list, 2 px before every item at 1440, at 390 a line under each row but the one before Archive or delete and the last");
}

// --- With the switch on: a room's Skills ------------------------------------------------

/** How many of the room's skills are on, as it shows: where, its words, and, for the phone's line, its space to the list. */
const shownCount = (page: Page) => page.evaluate((root) => {
	const section = document.querySelector(root)!;
	return [...section.querySelectorAll(".pane-head-beside, .room-list-count, .group-head")].filter((one) => one.getClientRects().length > 0).map((one) => [one.className, one.textContent, one.matches(".pane-head-beside") ? null : Math.round(section.querySelector(".room-skills-group > .settings-rows")!.getBoundingClientRect().top - one.getBoundingClientRect().bottom)]);
}, ROOM_SKILLS);

/** Flips the first switch that is off, then back: each time every row keeps its place and the title says how many are on. */
async function flipMovesNothing(page: Page, at: string): Promise<void> {
	const read = () => page.evaluate((root) => [...document.querySelectorAll(`${root} .room-skill`)].map((row) => {
		const toggle = row.querySelector<HTMLInputElement>("input.workspaces-tool-switch")!;
		return { name: row.querySelector(".room-skill-name")!.textContent!, on: toggle.checked, top: Math.round(row.getBoundingClientRect().top - row.parentElement!.getBoundingClientRect().top), busy: toggle.disabled && !row.querySelector(".room-skill-problem") };
	}), ROOM_SKILLS);
	const before = await read();
	const target = before.find((row) => !row.on && !row.busy)!;
	assert(target, `${at}: a switch that is off to flip`);
	for (const on of [true, false]) {
		await page.locator(`${ROOM_SKILLS} input.workspaces-tool-switch[data-skill="${target.name}"]`).click();
		let now = before;
		await waitUntil(async () => {
			now = await read();
			return now.find((row) => row.name === target.name)!.on === on && now.every((row) => !row.busy);
		}, `${at}: ${target.name} switched ${on ? "on" : "off"}`, 10000);
		same(now.map((row) => [row.name, row.top]), before.map((row) => [row.name, row.top]), `${at}: ${target.name} switched ${on ? "on" : "off"}: every row in its place`);
		same(await shownCount(page), [["pane-head-beside", copy.roomListOnCount(now.filter((row) => row.on).length, now.length), null]], `${at}: ${target.name} switched ${on ? "on" : "off"}: the count`);
	}
}

async function checkRoomSkills(browser: Browser): Promise<void> {
	for (const theme of [LIGHT, DARK] as const) {
		const page = await openRoomSkills(browser, desktop(1440, 900, theme));
		await installColourTools(page);
		const at = `${theme}, a room's Skills`;
		const readSearch = () => page.evaluate((root) => {
			const section = document.querySelector(root)!;
			const box = (element: Element | null) => { const r = element!.getBoundingClientRect(); return { top: r.top, middle: r.top + r.height / 2, left: r.left, right: r.right, width: r.width, height: r.height, bottom: r.bottom }; };
			return { search: box(section.querySelector(".room-skills-search")), title: box(section.querySelector(".pane-head h2")), close: box([...document.querySelectorAll(".settings-dialog-close")].find((one) => one.getClientRects().length > 0)!) };
		}, ROOM_SKILLS);
		const at1 = await readSearch();
		same([Math.round(at1.search.width), Math.round(at1.search.height), Math.round(at1.search.middle - at1.title.middle), Math.round(at1.close.left - at1.search.right)], [240, 32, 0, 12], `${at}: the search 240 by 32 on the title line, 12 before close`);
		// A long page scrolled: the search stays where it was.
		await page.evaluate((root) => { const spacer = document.createElement("div"); spacer.className = "smoke-spacer"; spacer.style.cssText = "height: 1600px; flex: none"; document.querySelector(root)!.append(spacer); document.querySelector(".settings-dialog-pane")!.scrollTop = 300; }, ROOM_SKILLS);
		const scrolled = await readSearch();
		same([Math.round(scrolled.search.top), Math.round(scrolled.title.top)], [Math.round(at1.search.top), Math.round(at1.title.top)], `${at}: the search and title after a scroll`);
		await page.evaluate(() => { document.querySelector(".smoke-spacer")!.remove(); document.querySelector(".settings-dialog-pane")!.scrollTop = 0; });

		const rows = await page.evaluate((root) => [...document.querySelectorAll(`${root} .room-skill`)].map((row) => ({
			name: row.querySelector(".room-skill-name")!.textContent,
			// A row is 64 with the line on its top edge, as every settings row (44); the name as a button once made it 65.
			height: Math.round(row.getBoundingClientRect().height),
			how: Boolean(row.querySelector(".room-skill-how")),
			switchLeft: Math.round(row.querySelector("input.workspaces-tool-switch")!.getBoundingClientRect().left),
			on: row.querySelector<HTMLInputElement>("input.workspaces-tool-switch")!.checked,
			target: Boolean(row.querySelector(".room-skill-open")),
			chevron: Boolean(row.querySelector(".room-skill-open .room-skill-chevron")),
			cantWork: Boolean(row.querySelector(".room-skill-problem")),
		})), ROOM_SKILLS);
		same(rows.filter((row) => !row.how && row.height !== 64).map((row) => `${row.name} ${row.height}`), [], `${at}: rows not 64 tall`);
		same([...new Set(rows.map((row) => row.switchLeft))].length, 1, `${at}: the switches' x`);
		// No row links into Settings: a name is plain text; only a row that can't work keeps its one way to the skill's page.
		same(rows.filter((row) => row.target !== row.cantWork || row.chevron !== row.cantWork).map((row) => row.name), [], `${at}: a working row with a target, or a row that can't work without one`);
		assert(rows.some((row) => row.cantWork), `${at}: a row that can't work is shown`);
		// One list, the ones on first, no On or Off headings; how many are on beside the title.
		same(await shownCount(page), [["pane-head-beside", copy.roomListOnCount(rows.filter((row) => row.on).length, rows.length), null]], `${at}: how many are on beside the title, one copy`);
		same(rows.map((row) => row.on), [...rows.filter((row) => row.on), ...rows.filter((row) => !row.on)].map((row) => row.on), `${at}: the ones on first`);
		if (theme === LIGHT) await flipMovesNothing(page, at);

		// The one target left, a row that can't work: underlined under the pointer, a ring the card never cuts on the keyboard's focus.
		const pdf = page.locator(`${ROOM_SKILLS} .room-skill-open`).filter({ hasText: /^scans/ });
		await pdf.hover();
		same(await pdf.locator(".room-skill-name").evaluate((name) => getComputedStyle(name).textDecorationLine), "underline", `${at}: a name under the pointer`);
		await page.mouse.move(2, 2);
		same(await pdf.locator(".room-skill-name").evaluate((name) => getComputedStyle(name).textDecorationLine), "none", `${at}: a name at rest`);
		await pdf.focus();
		await page.keyboard.press("Shift+Tab");
		await page.keyboard.press("Tab");
		const ring = await pdf.evaluate((target) => {
			const style = getComputedStyle(target);
			const box = target.getBoundingClientRect();
			const card = target.closest(".settings-rows")!.getBoundingClientRect();
			const outside = parseFloat(style.outlineWidth) + parseFloat(style.outlineOffset);
			const clips = [...(function* up(at: Element | null): Generator<Element> { for (; at && !at.matches(".settings-dialog-pane"); at = at.parentElement) yield at; })(target.parentElement)].filter((one) => getComputedStyle(one).overflow !== "visible").map((one) => one.className);
			return { focus: target.matches(":focus-visible"), outline: `${style.outlineStyle} ${style.outlineWidth}`, inCard: box.left - outside >= card.left && box.right + outside <= card.right && box.top - outside >= card.top && box.bottom + outside <= card.bottom, clips };
		});
		same(ring, { focus: true, outline: "solid 2px", inCard: true, clips: [] }, `${at}: a name's focus ring`);

		// A skill whose files can't be opened: a red dot, the reason in soft text, and "Open skill" in the same target.
		const reason = await page.evaluate((root) => {
			const line = document.querySelector(`${root} .room-skill-problem`)!;
			const dot = getComputedStyle(line, "::before");
			return { text: line.textContent, target: line.closest("button")?.className ?? "", link: line.querySelector(".room-skill-open-link")?.textContent ?? "", dot: [dot.width, dot.height, dot.borderRadius, dot.backgroundColor], colour: getComputedStyle(line).color };
		}, ROOM_SKILLS);
		same(reason.text, `${copy.ROOM_SKILL_UNREADABLE_LINE} ${copy.OPEN_SKILL}`, `${at}: the reason and its link`);
		assert(reason.target.includes("room-skill-open"), `${at}: "Open skill" inside the name's target`);
		same(reason.dot, ["8px", "8px", "50%", await resolved(page, "var(--error-text)", "background-color")], `${at}: the reason's dot`);
		same(reason.colour, await resolved(page, "var(--fg-soft)"), `${at}: the reason in soft text`);
		const measured = await contrasts(page, [`${ROOM_SKILLS} .room-skill-problem`, `${ROOM_SKILLS} .room-skill-open-link`, `${ROOM_SKILLS} .settings-row-clamp`, `${ROOM_SKILLS} .skill-tag`, `${ROOM_SKILLS} .room-skill-name`]);
		assert(Object.values(measured).every((ratio) => ratio >= 4.5), `${at}: words under 4.5:1: ${JSON.stringify(measured)}`);
		console.log(`  ..  ${at}: contrast ${Object.entries(measured).map(([selector, ratio]) => `${selector.split(" ").at(-1)} ${ratio}`).join(", ")}`);
		await checkShared(page, ROOM_SKILLS, theme, at);

		// A switch that did not take: the same dot and soft words, and its alert.
		await page.route("**/skill-settings", (route) => route.request().method() === "PUT" ? route.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ error: "refused" }) }) : route.fallback());
		await page.locator(`${ROOM_SKILLS} .room-skill`).filter({ hasText: "meeting-notes" }).locator("input.workspaces-tool-switch").click();
		const alert = page.locator(`${ROOM_SKILLS} .room-skill-problem[role="alert"]`);
		await alert.waitFor({ timeout: 10000 });
		same(await alert.evaluate((line) => [getComputedStyle(line, "::before").backgroundColor, getComputedStyle(line).color]), [await resolved(page, "var(--error-text)", "background-color"), await resolved(page, "var(--fg-soft)")], `${at}: a switch that did not take`);
		await page.unroute("**/skill-settings");

		// No match: one muted line where the list was, no card.
		await page.locator(`${ROOM_SKILLS} .room-skills-search`).fill("zzz");
		const none = await page.locator(`${ROOM_SKILLS} .room-skills-empty`).evaluate((line) => { const style = getComputedStyle(line); return { text: line.textContent, edge: style.borderTopWidth, fill: (window as any).__painted(style.backgroundColor), colour: style.color, cards: document.querySelectorAll(".room-settings-section:not([hidden]) .room-skills-section .settings-rows").length }; });
		same(none, { text: copy.roomSkillsNoMatch("zzz"), edge: "0px", fill: false, colour: await resolved(page, "var(--muted)"), cards: 0 }, `${at}: no match`);
		await page.locator(`${ROOM_SKILLS} .room-skills-search`).fill("");

		// "Open skill" opens the skill's page.
		if (theme === LIGHT) {
			await page.locator(`${ROOM_SKILLS} .room-skill-open-link`).click();
			await page.locator(".settings-overlay .skill-detail").waitFor({ timeout: 10000 });
			assert((await page.locator(".settings-overlay .skill-detail .pane-head h2").innerText()).startsWith("scans"), "Open skill opens that skill's page");
		}
		await page.context().close();

		// At 390: the search full width and 44 tall under the lead, above the list; nothing sideways.
		const small = await openRoomSkills(browser, phone(theme));
		const phoneRead = await small.evaluate((root) => {
			const section = document.querySelector(root)!;
			const box = (selector: string) => section.querySelector(selector)!.getBoundingClientRect();
			const pane = document.querySelector(".settings-dialog-pane")!;
			// A phone has no tip to read the rest: every description whole.
			const cut = [...section.querySelectorAll(".room-skill .settings-row-clamp")].filter((line) => line.scrollHeight > line.clientHeight + 1).map((line) => line.textContent);
			return { search: [Math.round(box(".room-skills-search").width), Math.round(box(".room-skills-search").height)], lead: Math.round(box(".pane-lead").width), order: box(".pane-lead").bottom <= box(".room-skills-search").top && box(".room-skills-search").bottom <= box(".room-skills-group").top, sideways: pane.scrollWidth > pane.clientWidth || document.documentElement.scrollWidth > window.innerWidth, cut };
		}, ROOM_SKILLS);
		const phoneRows = await small.locator(`${ROOM_SKILLS} input.workspaces-tool-switch`).evaluateAll((all) => [all.filter((one) => (one as HTMLInputElement).checked).length, all.length]);
		same(await shownCount(small), [["room-list-count", copy.roomListOnCount(phoneRows[0], phoneRows[1]), 8]], `${theme}, 390, a room's Skills: how many are on, a quiet line 8 over the list, one copy`);
		same(phoneRead, { search: [phoneRead.lead, 44], lead: phoneRead.lead, order: true, sideways: false, cut: [] }, `${theme}, 390, a room's Skills`);
		await small.context().close();
	}
	// A room with nothing on: one card, "0 of n on" beside the title.
	const quiet = await openRoomSkills(browser, desktop(1440, 900, LIGHT), "on", quietRoom);
	const quietRows = await quiet.locator(`${ROOM_SKILLS} .room-skill`).count();
	same([(await shownCount(quiet)).map(([, words]) => words), await quiet.locator(`${ROOM_SKILLS} .settings-rows`).count()], [[copy.roomListOnCount(0, quietRows)], 1], "a room with nothing on: its count and cards");
	await quiet.context().close();
	console.log("  ok  a room's Skills: the search 240 by 32 on the title line, staying put; rows 64 with the switch at one x; one list with \"n of m on\" beside the title (on a phone a quiet line 8 over it), the ones on first, a switch flipped moving nothing and the count true after it; names plain, only a row that can't work keeping its target with its chevron, underline and a whole ring; a reason and a refused switch with a red dot in soft text, \"Open skill\" in the same target opening the skill's page; no match a muted line; at 390 the search full width and 44 tall above the list; both themes");
}

// --- With the switch on: Settings, Skills -------------------------------------------------

async function checkSkillsHeader(browser: Browser): Promise<void> {
	for (const theme of [LIGHT, DARK] as const) {
		const page = await openSkills(browser, desktop(1440, 900, theme));
		await installColourTools(page);
		const at = `${theme}, Settings, Skills' header`;
		const head = await page.evaluate((root) => {
			const actions = [...document.querySelectorAll(`${root} .pane-head-actions button`)];
			const close = [...document.querySelectorAll(".settings-dialog-close")].find((one) => one.getClientRects().length > 0)!;
			const add = actions.at(-1)!;
			const caret = add.querySelector(".skill-add-caret");
			return {
				names: actions.map((one) => one.textContent!.trim()),
				caret: caret ? [caret.getAttribute("aria-hidden"), Math.round(caret.querySelector("svg")!.getBoundingClientRect().width), getComputedStyle(caret).marginLeft, getComputedStyle(caret).opacity] : null,
				end: Math.round(close.getBoundingClientRect().left - add.getBoundingClientRect().right),
				markEdge: Math.round(close.querySelector("svg")!.getBoundingClientRect().right - document.querySelector(`${root} .skill-table`)!.getBoundingClientRect().right),
			};
		}, SKILLS);
		same(head.names, ["Add skill"], `${at}: the one action`);
		same(head.caret, ["true", 12, "6px", "0.7"], `${at}: Add skill's caret`);
		same([head.end, head.markEdge], [12, 0], `${at}: the actions end 12 before close, whose mark is on the card's edge`);
		// Check now, a link in the line above the table: the line's own size, its words underlined, its ring whole. The tab order is the order on screen.
		const link = await page.evaluate((root) => {
			const line = document.querySelector(`${root} .skill-updates-checked`)!;
			const check = line.querySelector("button")!;
			const style = getComputedStyle(check);
			return { ends: line.textContent!.endsWith(check.textContent!), words: check.textContent, size: style.fontSize === getComputedStyle(line).fontSize, underlined: style.textDecorationLine, contrast: (window as any).__contrast(check) >= 4.5 };
		}, SKILLS);
		same(link, { ends: true, words: copy.CHECK_NOW, size: true, underlined: "underline", contrast: true }, `${at}: Check now`);
		await button(page, "Add skill").focus();
		for (let presses = 0; presses < 4 && (await page.evaluate(() => document.activeElement?.textContent?.trim())) !== copy.CHECK_NOW; presses += 1) await page.keyboard.press("Tab");
		same(await page.evaluate(() => [document.activeElement?.textContent?.trim(), getComputedStyle(document.activeElement!).outlineStyle]), [copy.CHECK_NOW, "solid"], `${at}: Tab reaches Check now after Add skill, with its ring`);
		await button(page, "Add skill").focus();

		// The menu: 6 under its button, right edges aligned, 200 to 280 wide, items 32; Escape gives the focus back.
		await page.keyboard.press("Enter");
		const menu = page.locator(`${SKILLS} .skill-add-menu`);
		await menu.waitFor();
		const shape = await page.evaluate((root) => {
			const add = document.querySelector(`${root} .skill-add-menu-wrap > button`)!.getBoundingClientRect();
			const list = document.querySelector(`${root} .skill-add-menu`)!;
			const box = list.getBoundingClientRect();
			const style = getComputedStyle(list);
			return { gap: Math.round(box.top - add.bottom), right: Math.round(box.right - add.right), radius: style.borderTopLeftRadius, wide: box.width >= 200 && box.width <= 280, items: [...list.querySelectorAll("[role=menuitem]")].map((item) => Math.round(item.getBoundingClientRect().height)), fill: (window as any).__fill(list) };
		}, SKILLS);
		same({ ...shape, fill: "" }, { gap: 6, right: 0, radius: "12px", wide: true, items: [32, 32, 32, 32], fill: "" }, `${at}: the add menu`);
		nearColour(shape.fill, theme === LIGHT ? "#ffffff" : "#373737", `${at}: the menu's fill`);
		await page.keyboard.press("Tab");
		same(await page.evaluate(() => document.activeElement?.getAttribute("role")), "menuitem", `${at}: Tab reaches the menu`);
		await page.keyboard.press("Escape");
		await menu.waitFor({ state: "detached" });
		same(await page.locator(".settings-overlay").count(), 1, `${at}: one Escape leaves the window open`);
		same(await page.evaluate(() => document.activeElement?.textContent?.trim()), "Add skill", `${at}: Escape gives the focus back to Add skill`);
		// A second Escape, with no menu open, closes the window.
		await page.keyboard.press("Escape");
		await page.locator(".settings-overlay").waitFor({ state: "detached" });
		await page.context().close();

		const small = await openSkills(browser, phone(theme));
		const narrow = await small.evaluate((root) => {
			const lead = document.querySelector(`${root} .pane-lead`)!.getBoundingClientRect();
			const buttons = [...document.querySelectorAll(`${root} .pane-head-actions button`)].map((one) => one.getBoundingClientRect());
			const line = document.querySelector(`${root} .skill-updates-checked`)!;
			// What a finger can press: the words, and what is drawn around them.
			const check = line.querySelector("button")!;
			const reach = getComputedStyle(check, "::after");
			return { add: buttons.map((box) => [Math.round(box.width), Math.round(box.height)]), width: Math.round(lead.width), edge: Math.round(line.getBoundingClientRect().left - lead.left), press: Math.round(parseFloat(reach.height)) >= 44 };
		}, SKILLS);
		same({ one: narrow.add.length, height: narrow.add[0][1], words: narrow.add[0][0] < narrow.width / 2, edge: narrow.edge, press: narrow.press }, { one: 1, height: 44, words: true, edge: 0, press: true }, `${theme}, 390: Add skill at its words' width, 44 tall, the one action; the line above the table on the text edge, its Check now 44 to the finger`);
		await small.context().close();
	}
	console.log("  ok  Settings, Skills' header: Add skill the one action, a small button with its caret, ending 12 before close, Check now a link in the line above the table; the add menu 6 under its button with the right edges aligned, 32 px items, one Escape closing only the menu and giving the focus back to Add skill; at 390 Add skill full width and 44 tall, Check now 44 to the finger; both themes");
}

/** The messages above the table, each with the space to what follows it. */
async function readMessages(page: Page) {
	return page.evaluate((root) => {
		const w = window as any;
		const strips = [...document.querySelectorAll(`${root} .skill-message`)];
		return strips.map((strip) => {
			const box = strip.getBoundingClientRect();
			// The lines after a check sit in skill updates' bar: the last one's next is what follows the bar.
			const next = strip.nextElementSibling ?? strip.closest(".skill-updates-bar")!.nextElementSibling!;
			const dot = getComputedStyle(strip, "::before");
			const style = getComputedStyle(strip);
			return {
				kind: [...strip.classList].find((one) => one.startsWith("skill-message-"))!.slice("skill-message-".length),
				text: [...strip.childNodes].filter((node) => node.nodeType === Node.TEXT_NODE).map((node) => node.textContent).join(""),
				button: strip.querySelector("button")?.textContent ?? null,
				below: [next.matches(".skill-message, .skill-updates-checked"), Math.round(next.getBoundingClientRect().top - box.bottom)] as const,
				shape: [style.borderTopLeftRadius, box.height >= 40, w.__painted(style.backgroundColor), dot.width, dot.height],
				dot: w.__seen(strip, dot.backgroundColor),
				dotContrast: w.__colourContrast(strip, dot.backgroundColor),
				words: style.color,
				contrast: Math.round(w.__contrast(strip) * 10) / 10,
			};
		});
	}, SKILLS);
}
async function checkMessage(page: Page, theme: Theme, at: string, want: Array<{ kind: string; text: string | RegExp; button?: string | null }>): Promise<void> {
	const read = await readMessages(page);
	same(read.map((one) => one.kind), want.map((one) => one.kind), `${at}: the messages' kinds`);
	const dots = { news: INK[theme], done: await resolved(page, "var(--success)"), failed: await resolved(page, "var(--error-text)") };
	const fg = await resolved(page, "var(--fg)");
	for (const [i, one] of read.entries()) {
		const wanted = want[i];
		assert(typeof wanted.text === "string" ? one.text === wanted.text : wanted.text.test(one.text), `${at}: message ${i + 1} says ${JSON.stringify(one.text)}`);
		same(one.button, wanted.button ?? null, `${at}: message ${i + 1}'s button`);
		same(one.below[1], one.below[0] ? 8 : 12, `${at}: message ${i + 1}'s space below`);
		same(one.shape, ["12px", true, true, "8px", "8px"], `${at}: message ${i + 1} is a strip with an 8 px dot`);
		if (one.kind === "news") nearColour(one.dot, dots.news, `${at}: news's dot`);
		else same(await page.evaluate(([a, b]) => { const p = (c: string) => { const i = document.createElement("i"); i.style.color = c; document.body.append(i); const r = getComputedStyle(i).color; i.remove(); return r; }; return p(a) === p(b); }, [one.dot, (dots as any)[one.kind]]), true, `${at}: ${one.kind}'s dot ${one.dot}`);
		assert(one.dotContrast >= 3, `${at}: message ${i + 1}'s dot at ${one.dotContrast}:1`);
		same(one.words, fg, `${at}: message ${i + 1}'s words in the text colour`);
		assert(one.contrast >= 4.5, `${at}: message ${i + 1}'s words at ${one.contrast}:1`);
	}
	console.log(`  ..  ${at}: ${read.map((one) => `${one.kind} ${one.contrast}:1, dot ${Math.round(one.dotContrast * 10) / 10}:1`).join("; ")}`);
}

async function checkSkillsMessage(browser: Browser): Promise<void> {
	// One update found, and a repository that can't be asked: two messages, 8 apart, the first offering the update.
	changeUpstream("team", "pdf", "The pdf instructions, second.");
	fs.renameSync(path.join(repos, "letters"), path.join(repos, "letters-away"));
	for (const theme of [LIGHT, DARK] as const) {
		const page = await openSkills(browser, desktop(1440, 900, theme));
		await installColourTools(page);
		await checkNow(page);
		await checkMessage(page, theme, `${theme}, one update and a check that failed`, [{ kind: "news", text: copy.skillUpdatesFoundLine(1), button: `${copy.UPDATE_SKILL} pdf` }, { kind: "failed", text: /^Couldn't check “letters” for updates\./ }]);
		await checkShared(page, SKILLS, theme, `${theme}, Settings, Skills with messages`);
		await page.context().close();
	}
	fs.renameSync(path.join(repos, "letters-away"), path.join(repos, "letters"));

	// Hidden characters in the new version: "Update pdf" stops at the skill's page and its warning, as the row's Update does.
	changeUpstream("team", "pdf", "The pdf instructions,​ third.");
	{
		const page = await openSkills(browser, desktop(1440, 900, LIGHT));
		await checkNow(page);
		const sent: string[] = [];
		page.on("request", (request) => { if (/\/api\/skills\/[^/]+\/update$/.test(new URL(request.url()).pathname)) sent.push(request.url()); });
		for (const press of [() => page.locator(`${SKILLS} .skill-message`).getByRole("button", { name: `${copy.UPDATE_SKILL} pdf` }), () => page.locator(`${SKILLS} .skill-row-update`).getByRole("button", { name: `${copy.UPDATE_SKILL} pdf` })]) {
			await press().click();
			await page.locator(".skill-detail .skill-update-group .skill-review-banner.danger").waitFor({ timeout: 10000 });
			await page.locator(".pane-head-back").click();
			await page.locator(`${SKILLS} .skill-table`).waitFor();
			// Back on the list, a new check offers the update again.
			await checkNow(page);
		}
		same(sent, [], "hidden characters: nothing is updated before the person decides");
		await page.context().close();
	}

	// A clean new version: "Update pdf" updates it, then Updated; a check after it finds none.
	for (const theme of [LIGHT, DARK] as const) {
		changeUpstream("team", "pdf", `The pdf instructions, ${theme}.`);
		const page = await openSkills(browser, desktop(1440, 900, theme));
		await installColourTools(page);
		await checkNow(page);
		const sent: string[] = [];
		page.on("request", (request) => { if (/\/api\/skills\/[^/]+\/update$/.test(new URL(request.url()).pathname)) sent.push(new URL(request.url()).pathname); });
		await page.locator(`${SKILLS} .skill-message`).getByRole("button", { name: `${copy.UPDATE_SKILL} pdf` }).click();
		await page.locator(`${SKILLS} .skill-message-done`).waitFor({ timeout: 15000 });
		await answered(page, "after the update");
		same(sent, ["/api/skills/pdf/update"], `${theme}: "Update pdf" sends the row's update`);
		assert((await page.locator(".skill-detail").count()) === 0, `${theme}: the update opens nothing`);
		await checkMessage(page, theme, `${theme}, updated`, [{ kind: "done", text: copy.skillUpdatedNotice("pdf") }]);
		await checkNow(page);
		await checkMessage(page, theme, `${theme}, none found`, [{ kind: "done", text: copy.skillUpdatesFoundLine(0) }]);
		await page.context().close();
	}

	// One update to a skill with the longest name: the message's sentence stays whole beside or above "Update <name>", and nothing goes sideways.
	{
		const dir = path.join(repos, "long");
		fs.mkdirSync(path.join(dir, "skills"), { recursive: true });
		git(dir, ["init", "-q", "-b", "main"]);
		writeSkill(path.join(dir, "skills"), LONG, DESCRIPTIONS[LONG], `The ${LONG} instructions.`, `display_name: ${LONG_DISPLAY}\n`);
		git(dir, ["add", "-A"]);
		git(dir, ["commit", "-q", "-m", "first"]);
		const scan = await api("POST", "/api/skills/repo/scan", { source: dir });
		const imported = await api("POST", "/api/skills/repo/import", { token: scan.body.token, path: `skills/${LONG}` });
		assert(imported.status < 300, `the long name's import: ${imported.status} ${JSON.stringify(imported.body)}`);
		writeSkill(path.join(dir, "skills"), LONG, DESCRIPTIONS[LONG], "The report's instructions, second.", `display_name: ${LONG_DISPLAY}\n`);
		git(dir, ["add", "-A"]);
		git(dir, ["commit", "-q", "-m", "second"]);
		for (const [width, options] of [["390", phone(LIGHT)], ["1440", desktop(1440, 900, LIGHT)]] as const) {
			const page = await openSkills(browser, options);
			await checkNow(page);
			const fit = await page.evaluate((root) => {
				const strip = document.querySelector(`${root} .skill-message-news`)!;
				const box = strip.getBoundingClientRect();
				const button = strip.querySelector("button")!.getBoundingClientRect();
				const words = [...strip.childNodes].find((node) => node.nodeType === Node.TEXT_NODE && node.textContent!.trim())!;
				const range = document.createRange();
				range.selectNodeContents(words);
				const lines = [...range.getClientRects()];
				const inside = (one: DOMRect) => one.left >= box.left - 0.5 && one.right <= box.right + 0.5;
				const apart = (one: DOMRect) => one.right <= button.left || one.left >= button.right || one.bottom <= button.top || one.top >= button.bottom;
				const pane = document.querySelector(".settings-dialog-pane")!;
				return {
					sentence: lines.length > 0 && lines.every((one) => inside(one) && apart(one)) && lines.length <= 2,
					button: inside(button) && button.height >= 28,
					sideways: pane.scrollWidth > pane.clientWidth || document.documentElement.scrollWidth > window.innerWidth || strip.scrollWidth > strip.clientWidth,
				};
			}, SKILLS);
			same(await page.locator(`${SKILLS} .skill-message-news button`).innerText(), `${copy.UPDATE_SKILL} ${LONG_DISPLAY}`, `${width}: the long name's button`);
			same(fit, { sentence: true, button: true, sideways: false }, `${width}: one update to a skill with a long name`);
			await page.context().close();
		}
		seeded(await api("DELETE", `/api/skills/${LONG}`), "the long name removed");
	}

	// Two updates: the message offers none of them (Update all, which keeps its old look, is skill updates' own); each row has its own.
	changeUpstream("team", "pdf", "The pdf instructions, fourth.");
	changeUpstream("team", "internal-comms", "The internal-comms instructions, second.");
	const page = await openSkills(browser, desktop(1440, 900, LIGHT));
	await installColourTools(page);
	await checkNow(page);
	await checkMessage(page, LIGHT, "light, two updates", [{ kind: "news", text: copy.skillUpdatesFoundLine(2), button: null }]);
	same(await page.locator(`${SKILLS} .skill-row-update button`).count(), 2, "two updates: Update on two rows");
	await page.context().close();
	console.log("  ok  the lines above the table as messages, 12 above it and 8 apart: ink for an update found with \"Update pdf\" when one has one, which sends the row's update or stops at hidden characters as the row's does, red for a check that failed, green for Updated and none found, none with two updates; words in the text colour at 4.5:1 or more; both themes");
}

async function checkSkillsTable(browser: Browser): Promise<void> {
	for (const theme of [LIGHT, DARK] as const) {
		const page = await openSkills(browser, desktop(1440, 900, theme));
		await installColourTools(page);
		const at = `${theme}, the table`;
		// One row pattern (44): no column heads; the name over one line of facts on one edge, 64 tall; at the right
		// edge the chevron, or Update in its place, at one x down the list.
		const table = await page.evaluate((root) => {
			const card = document.querySelector(`${root} .skill-table`)!;
			const head = card.querySelector(".skill-table-head");
			const left = (element: Element | null) => element ? Math.round(element.getBoundingClientRect().left) : null;
			const rows = [...card.querySelectorAll(".skill-row")];
			const shown = (element: Element | null) => !!element && element.getClientRects().length > 0;
			return {
				headShown: shown(head),
				edges: [...new Set(rows.flatMap((row) => [left(row.querySelector(".skill-table-name")), left(row.querySelector(".skill-table-facts"))]))],
				factsUnder: rows.every((row) => row.querySelector(".skill-table-facts")!.getBoundingClientRect().top >= row.querySelector(".skill-table-name")!.getBoundingClientRect().bottom),
				counts: [...new Set(rows.map((row) => row.querySelector(".skill-table-from + .skill-table-cell")?.textContent ?? "").filter(Boolean))].sort(),
				heights: [...new Set(rows.filter((row) => !row.querySelector(".skill-table-problem")).map((row) => Math.round(row.getBoundingClientRect().height)))],
				// A skill rooms can't use keeps its facts and says why whole on a line of its own under them, as on a phone.
				reasonRows: rows.filter((row) => row.querySelector(".skill-table-problem")).map((row) => [Math.round(row.getBoundingClientRect().height), row.querySelector(".skill-table-problem")!.getBoundingClientRect().top >= row.querySelector(".skill-table-facts")!.getBoundingClientRect().bottom]),
				tag: (() => { const tag = card.querySelector(".skill-table-name .skill-tag")!; const name = tag.previousElementSibling!; const box = tag.getBoundingClientRect(); return [Math.round(box.height), tag.scrollWidth <= tag.clientWidth, Math.round(box.left - name.getBoundingClientRect().right)]; })(),
				// Each row's one action on the right edge: Update where the skill has one, else the chevron.
				actions: rows.map((row) => {
					const update = row.closest(".skill-row-line")?.querySelector(".skill-row-update button") ?? null;
					const chevron = row.querySelector(".skill-table-chevron");
					return { update: shown(update) ? Math.round(update!.getBoundingClientRect().height) : null, chevron: shown(chevron), right: Math.round((shown(update) ? update! : chevron!).getBoundingClientRect().right) };
				}),
			};
		}, SKILLS);
		same([table.headShown, table.edges.length, table.factsUnder], [false, 1, true], `${at}: no column heads, the name over its facts on one edge`);
		// The rooms' count runs on in the line, so it starts small, as a connector's does.
		same([table.counts.includes("no rooms"), table.counts.filter((words) => words !== words.toLowerCase())], [true, []], `${at}: the rooms' count in the line`);
		same(table.heights, [64], `${at}: rows`);
		same(table.reasonRows, [[80, true]], `${at}: a row with a reason`);
		same(table.tag, [20, true, 8], `${at}: the tag 20 tall, whole, 8 after the name`);
		same(table.actions.filter((one) => one.update !== null).map((one) => [one.update, one.chevron]), [[28, false], [28, false]], `${at}: two rows with Update 28 tall in the chevron's place`);
		same(table.actions.filter((one) => one.update === null && !one.chevron).length, 0, `${at}: a row with neither`);
		same(await updatesOverWords(page), [], `${at}: Update keeps its room while it updates`);
		same(new Set(table.actions.map((one) => one.right)).size, 1, `${at}: Update and the chevrons at one x`);
		const measured = await contrasts(page, [`${SKILLS} .skill-table-facts`, `${SKILLS} .skill-table-name-text`, `${SKILLS} .skill-table-cell`, `${SKILLS} .skill-table .skill-tag`, `${SKILLS} .skill-table-problem`]);
		assert(Object.values(measured).every((ratio) => ratio >= 4.5), `${at}: words under 4.5:1: ${JSON.stringify(measured)}`);
		console.log(`  ..  ${at}: contrast ${Object.entries(measured).map(([selector, ratio]) => `${selector.split(" ").at(-1)} ${ratio}`).join(", ")}`);
		await checkShared(page, SKILLS, theme, at);

		// A row under the pointer, pressed, and on the keyboard's focus: a rounded fill and ring inside it.
		const row = page.locator(`${SKILLS} .skill-row`).filter({ hasText: "meeting-notes" });
		const fill = () => row.evaluate((one) => { const style = getComputedStyle(one, "::before"); return [style.backgroundColor, style.borderRadius, `${style.outlineStyle} ${style.outlineWidth}`]; });
		const [hover, press] = [await resolved(page, "var(--exx-row-hover)", "background-color"), await resolved(page, "var(--exx-row-press)", "background-color")];
		await row.hover();
		await waitUntil(async () => (await fill())[0] === hover, `${at}: the hover settles`, 2000).catch(() => {});
		same((await fill()).slice(0, 2), [hover, "8px"], `${at}: a row under the pointer`);
		await page.mouse.down();
		await waitUntil(async () => (await fill())[0] === press, `${at}: the press settles`, 2000).catch(() => {});
		same((await fill())[0], press, `${at}: a row pressed`);
		// Let go over the page's lead, inside the window, so the press opens nothing.
		const lead = (await page.locator(`${SKILLS} .pane-lead`).boundingBox())!;
		await page.mouse.move(lead.x + 4, lead.y + lead.height / 2);
		await page.mouse.up();
		same(await page.locator(".skill-detail").count(), 0, `${at}: a press let go elsewhere opens nothing`);
		await row.focus();
		await page.keyboard.press("Shift+Tab");
		await page.keyboard.press("Tab");
		same([await row.evaluate((one) => one.matches(":focus-visible")), (await fill())[2]], [true, "solid 2px"], `${at}: a row's keyboard ring`);

		// Update is its own target: pressing it opens nothing.
		if (theme === DARK) {
			await page.locator(`${SKILLS} .skill-row-update`).getByRole("button", { name: `${copy.UPDATE_SKILL} internal-comms` }).click();
			await page.locator(`${SKILLS} .skill-message-done`).waitFor({ timeout: 15000 });
			assert((await page.locator(".skill-detail").count()) === 0, `${at}: Update opens nothing`);
		}
		await page.context().close();
	}

	// A company's library: no Used in, the names and their facts on one edge.
	const company = await openSkills(browser, desktop(1440, 900, LIGHT), "on", { remote: false, capability: "full", sharedServer: true, person: { id: "22222222-2222-4222-8222-222222222222", name: "Sample Admin", admin: true } });
	const grid = await company.evaluate((root) => {
		const card = document.querySelector(`${root} .skill-table`)!;
		const rows = [...card.querySelectorAll(".skill-row")];
		return { edges: new Set(rows.flatMap((row) => [".skill-table-name", ".skill-table-facts"].map((selector) => Math.round(row.querySelector(selector)!.getBoundingClientRect().left)))).size, usedIn: card.querySelectorAll(".skill-table-cell:not(.skill-table-from)").length };
	}, SKILLS);
	same(grid, { edges: 1, usedIn: 0 }, "a company's library: no Used in, one edge");
	await company.context().close();

	// At 390: two-line rows, Update 44 tall on the row's middle, nothing sideways.
	for (const theme of [LIGHT, DARK] as const) {
		const small = await openSkills(browser, phone(theme));
		const narrow = await small.evaluate((root) => {
			const rows = [...document.querySelectorAll(`${root} .skill-row`)];
			const pane = document.querySelector(".settings-dialog-pane")!;
			const update = document.querySelector(`${root} .skill-row-update button`);
			const updateRow = update?.closest(".skill-row-line")?.querySelector(".skill-row");
			const middle = (box: DOMRect) => box.top + box.height / 2;
			return {
				lines: rows.filter((row) => !row.querySelector(".skill-table-problem")).map((row) => [Math.round(row.getBoundingClientRect().height), row.querySelector(".skill-table-facts")!.getBoundingClientRect().top >= row.querySelector(".skill-table-name")!.getBoundingClientRect().bottom]),
				// The chevron, where Update doesn't stand in its place, centred on the whole row, a row with a reason included.
				chevrons: rows.filter((row) => row.querySelector(".skill-table-chevron")!.getClientRects().length > 0 && Math.abs(middle(row.querySelector(".skill-table-chevron")!.getBoundingClientRect()) - middle(row.getBoundingClientRect())) > 1).map((row) => row.querySelector(".skill-table-name")!.textContent),
				// Update, 44 to the finger, centred on its row as the chevron is.
				update: update && updateRow ? [Math.round(update.getBoundingClientRect().height), Math.abs(middle(update.getBoundingClientRect()) - middle(updateRow.getBoundingClientRect())) <= 1] : null,
				sideways: pane.scrollWidth > pane.clientWidth || document.documentElement.scrollWidth > window.innerWidth,
			};
		}, SKILLS);
		same({ lines: [...new Set(narrow.lines.map((one) => JSON.stringify(one)))], update: narrow.update, sideways: narrow.sideways, chevrons: narrow.chevrons }, { lines: ["[64,true]"], update: [44, true], sideways: false, chevrons: [] }, `${theme}, 390, the table`);
		const gaps = await cutAddressGaps(small);
		assert(gaps.length > 0 && Math.max(...gaps) <= 2.5, `${theme}, 390: a cut address ends on its "…", so what follows keeps its usual gap (${gaps.join(", ")})`);
		same(await updatesOverWords(small), [], `${theme}, 390: Update keeps its room while it updates`);
		await small.context().close();
	}
	console.log("  ok  the table: no column heads, the name over its facts on one edge, rows 64, a row rooms can't use 80 with its reason whole under the facts; the tag 20 tall, whole, 8 after the name; Update 28 tall in the chevron's place, at one x with the chevrons, opening nothing; a row's hover, press and ring; a company's list without Used in; at 390 two-line rows 64 tall with Update 44 tall on the row's middle, a cut address ending on its … and nothing sideways; both themes");
}

/**
 * A pass of Update automatically, run here on the server's home as skill
 * updates' own smoke runs it: it updates internal-comms and leaves letters,
 * whose new version has hidden characters, for the person, so the notice of
 * what it did shows, and with pdf's update still waiting, Update all.
 */
async function updateAutomatically(): Promise<void> {
	Object.assign(process.env, smokeHomeEnv(tempHome, { EXXETA_SKILLS_ALLOW_LOCAL_REPO: "1" }));
	for (const name of ["EXXPERTS_DATA_DIR", "EXXPERTS_STATE_HOME", "EXXPERTS_CODING_AGENT_DIR"]) delete process.env[name];
	const { runSkillAutoUpdatePass } = await import("../src/skill-updates.js");
	for (const name of ["internal-comms", "letters"]) seeded(await api("PUT", `/api/skills/${name}/auto-update`, { on: true }), `${name}'s Update automatically`);
	changeUpstream("team", "internal-comms", "The internal-comms instructions, updated automatically.");
	changeUpstream("letters", "letters", "The letters instructions,​ with a hidden character.");
	const logger = { info: () => {}, warn: () => {} };
	// The first pass sees what changed; one 13 hours on, on its own clock, takes it.
	await runSkillAutoUpdatePass({ logger });
	await runSkillAutoUpdatePass({ now: () => new Date(Date.now() + 13 * 60 * 60_000), logger });
	const updates = new Map(((await api("GET", "/api/skills")).body as any[]).map((skill) => [skill.name, skill.update]));
	assert(updates.get("internal-comms")?.updated?.automatic && updates.get("letters")?.autoSkipped && updates.get("pdf")?.state === "available", `the pass updated internal-comms and left letters, pdf's update waits: ${JSON.stringify(Object.fromEntries(updates))}`);
}

const NOTICE = `${SKILLS} .skill-auto-notice`;
const UPDATE_ALL = (page: Page) => page.locator(`${SKILLS} .skill-updates-bar`).getByRole("button", { name: copy.UPDATE_ALL, exact: true });

/** With the switch off: the notice of what Update automatically did, and Update all with two updates waiting. */
async function readAutoNoticeOff(browser: Browser): Promise<void> {
	await readOff(browser, "skills", "Settings, Skills, after Update automatically", async (page) => {
		same([await page.locator(NOTICE).count(), await UPDATE_ALL(page).count()], [1, 1], "switch off, after Update automatically: the notice and Update all");
	});
}

/**
 * With the switch on, the parts skill updates added after this look was drawn
 * (the notice of what Update automatically did, Update all and the line after
 * it) keep their look from before, but break nothing: no page goes sideways
 * from 390 to 1440, the table's rows keep their height and x, and the notice's
 * and Update all's keyboard rings are whole.
 */
async function checkNewPartsOn(browser: Browser): Promise<void> {
	for (const [width, options] of [["1440", desktop(1440, 900, LIGHT)], ["1024", desktop(1024, 800, LIGHT)], ["760", desktop(760, 900, LIGHT)], ["390", phone(LIGHT)]] as const) {
		const page = await openSkills(browser, options);
		const at = `switch on, after Update automatically, ${width}`;
		const fit = () => page.evaluate((root) => {
			const pane = document.querySelector(".settings-dialog-pane")!;
			const card = document.querySelector(`${root} .skill-table`)!;
			const rows = [...card.querySelectorAll(".skill-row")];
			return {
				sideways: pane.scrollWidth > pane.clientWidth || document.documentElement.scrollWidth > window.innerWidth || [...document.querySelectorAll(`${root} :is(.skill-auto-notice, .skill-updates-bar)`)].some((one) => one.scrollWidth > one.clientWidth),
				heights: [...new Set(rows.filter((row) => !row.querySelector(".skill-table-problem")).map((row) => Math.round(row.getBoundingClientRect().height)))],
				// The one row pattern at every width: each name and its facts on one edge.
				edges: new Set(rows.flatMap((row) => [".skill-table-name", ".skill-table-facts"].map((selector) => Math.round(row.querySelector(selector)!.getBoundingClientRect().left)))).size,
				updateXs: new Set([...card.querySelectorAll(".skill-row-update button")].map((one) => Math.round(one.getBoundingClientRect().left))).size,
			};
		}, SKILLS);
		const want = { sideways: false, heights: [64], edges: 1, updateXs: 1 };
		same(await fit(), want, `${at}: the page`);
		// A keyboard ring is whole when no box that clips it cuts it.
		for (const [what, control] of [["Close", page.locator(NOTICE).getByRole("button", { name: copy.CLOSE_NOTICE, exact: true })], ["Update all", UPDATE_ALL(page)]] as const) {
			await control.focus();
			await page.keyboard.press("Shift+Tab");
			await page.keyboard.press("Tab");
			const ring = await control.evaluate((one) => {
				const style = getComputedStyle(one);
				const out = parseFloat(style.outlineOffset) + parseFloat(style.outlineWidth);
				const box = one.getBoundingClientRect();
				const cut: string[] = [];
				for (let up = one.parentElement; up; up = up.parentElement) {
					const clip = getComputedStyle(up);
					if (clip.overflowX === "visible" && clip.overflowY === "visible") continue;
					const edge = up.getBoundingClientRect();
					const [left, top] = [edge.left + up.clientLeft, edge.top + up.clientTop];
					if (box.left - out < left - 0.5 || box.top - out < top - 0.5 || box.right + out > left + up.clientWidth + 0.5 || box.bottom + out > top + up.clientHeight + 0.5) cut.push(up.className);
				}
				return { focused: one.matches(":focus-visible"), outline: style.outlineStyle, cut };
			});
			same(ring, { focused: true, outline: "solid", cut: [] }, `${at}: ${what}'s keyboard ring`);
		}
		// The line after Update all: pdf updates, letters stops at its hidden character.
		if (width === "390" || width === "1440") {
			await UPDATE_ALL(page).click();
			await page.locator(`${SKILLS} .skill-updates-line`).filter({ hasText: copy.skillUpdateAllLine(1, [{ name: "letters", why: "waits", hasUpdate: true }]) }).waitFor({ timeout: 30000 });
			same((await fit()).sideways, false, `${at}: after Update all, nothing sideways`);
		}
		await page.context().close();
		// Update all ran: pdf's next version waits again for the next width.
		if (width === "390" || width === "1440") {
			changeUpstream("team", "pdf", `The pdf instructions, waiting again at ${width}.`);
			seeded(await api("POST", "/api/skills/updates/check", { names: ["pdf"] }), "pdf checked again");
		}
	}
	console.log("  ok  switch on: the notice of what Update automatically did, Update all and its line keep their old look and break nothing: nothing sideways at 1440, 1024, 760 or 390, the table's rows at their height and x, Update at one x, Close's and Update all's rings whole");
}

/** Empties the library, then reads both pages with the switch off. */
async function readEmptyOff(browser: Browser): Promise<void> {
	for (const name of fs.readdirSync(store)) fs.rmSync(path.join(store, name), { recursive: true, force: true });
	await readOff(browser, "skills", "Settings, Skills, no skills");
	await readOff(browser, "room", "a room's Skills, an empty library");
}

/** No skills at all: Settings, Skills and a room's Skills show one muted line, no card; with the switch off, as today. */
async function checkEmpty(browser: Browser): Promise<void> {
	await readEmptyOff(browser);
	for (const theme of [LIGHT, DARK] as const) {
		for (const [where, open, root] of [["Settings, Skills", openSkills, SKILLS], ["a room's Skills", openRoomSkills, ROOM_SKILLS]] as const) {
			const page = await open(browser, desktop(1440, 900, theme));
			await installColourTools(page);
			const read = await page.evaluate((root) => {
				const line = document.querySelector(`${root} .settings-empty`)!;
				const style = getComputedStyle(line);
				const lead = document.querySelector(`${root} .pane-lead`)!;
				return { edge: style.borderTopWidth, fill: (window as any).__painted(style.backgroundColor), colour: style.color, afterLead: lead.getBoundingClientRect().bottom <= line.getBoundingClientRect().top, cards: document.querySelectorAll(`${root} :is(.skill-table, .settings-rows)`).length };
			}, root);
			same(read, { edge: "0px", fill: false, colour: await resolved(page, "var(--muted)"), afterLead: true, cards: 0 }, `${theme}, ${where} with no skills`);
			await page.context().close();
		}
	}
	console.log("  ok  no skills: the lead, then one muted line and no card, on Settings, Skills and a room's Skills, both themes");
}

let server: ChildProcessWithoutNullStreams | null = null;
try {
	// Two repositories on this machine: a team's (two skills) and one with a single skill.
	for (const [repo, names] of [["team", ["internal-comms", "pdf"]], ["letters", ["letters"]]] as const) {
		const dir = path.join(repos, repo);
		fs.mkdirSync(path.join(dir, "skills"), { recursive: true });
		git(dir, ["init", "-q", "-b", "main"]);
		for (const name of names) writeSkill(path.join(dir, "skills"), name, DESCRIPTIONS[name]);
		git(dir, ["add", "-A"]);
		git(dir, ["commit", "-q", "-m", "first"]);
	}
	server = spawn("npx", ["tsx", "src/index.ts"], {
		shell: process.platform === "win32",
		...SMOKE_SERVER_SPAWN_TREE_OPTIONS,
		cwd: webServerDir,
		env: smokeHomeEnv(tempHome, { PORT: String(port), ...SMOKE_SERVER_AUTH_ENV, EXXETA_HOME: repoRoot, EXXETA_SKILLS_ALLOW_LOCAL_REPO: "1" }) as NodeJS.ProcessEnv,
		stdio: ["ignore", "pipe", "pipe"],
	}) as unknown as ChildProcessWithoutNullStreams;
	await waitForServer(server, baseUrl, { tries: 100 });
	for (const [repo, names] of [["team", ["internal-comms", "pdf"]], ["letters", ["letters"]]] as const) {
		const scan = await api("POST", "/api/skills/repo/scan", { source: path.join(repos, repo) });
		seeded(scan, `the scan of ${repo}`);
		for (const name of names) seeded(await api("POST", "/api/skills/repo/import", { token: scan.body.token, path: `skills/${name}` }), name);
	}
	seeded(await api("POST", "/api/skills", { id: "meeting-notes", displayName: "meeting-notes", description: "Turn a meeting transcript into notes with decisions and next steps.", instructions: "Notes." }), "meeting-notes");
	// A skill its author marked to start only by hand, and one whose files can't be opened (a SKILL.md that shares its file with another name), straight into the store.
	for (const [name, description, extra] of [["press-release", "Draft a press release from a few key facts.", "disable-model-invocation: true\n"], ["scans", "Sort scanned letters.", ""]] as const) {
		const manifest = writeSkill(store, name, description, `The ${name} instructions.`, extra);
		fs.writeFileSync(path.join(store, name, "provenance.json"), JSON.stringify({ source: "local", importedAt: new Date().toISOString(), license: null, sha256: createHash("sha256").update(manifest).digest("hex") }));
	}
	for (const displayName of [ROOM, QUIET_ROOM]) seeded(await api("POST", "/api/persistent-agents", { displayName, userName: "Synthetic User", preferredUserAddress: "Synthetic User" }), displayName);
	const rooms = (await api("GET", "/api/persistent-agents")).body;
	const roomId = (rooms.agents ?? rooms).find((one: any) => (one.displayName ?? one.name) === ROOM)?.id ?? (rooms.agents ?? rooms).find((one: any) => JSON.stringify(one).includes(ROOM))?.id;
	assert(roomId, "the room's id");
	for (const name of ["internal-comms", "pdf", "press-release", "scans"]) seeded(await api("PUT", `/api/persistent-agents/${encodeURIComponent(roomId)}/skill-settings`, { action: "enable", name }), `${name} on`);
	fs.linkSync(path.join(store, "scans", "SKILL.md"), path.join(store, "scans", "elsewhere.md"));
	seeded(await api("POST", "/api/mcp/servers", { name: "notes-server", url: "http://127.0.0.1:9/mcp" }), "a connector");
	seeded(await api("PUT", `/api/persistent-agents/${encodeURIComponent(roomId)}/mcp-connectors`, { action: "grant", name: "notes-server" }), "the connector in the room");
	// What's new already seen: its note would open on the home page, and closing it sends a request of its own while these pages load.
	seeded(await api("POST", "/api/whats-new/seen"), "what's new seen");
	// An update waiting in the team's repository for the switch-off reader's check.
	changeUpstream("team", "pdf", "The pdf instructions, first change.");

	const browser = await chromium.launch({ ignoreDefaultArgs: ["--hide-scrollbars"] });
	try {
		await checkOff(browser);
		if (process.env.SKILLS_LOOK_OFF_DUMP) {
			// After Update automatically and the empty pages too, then nothing more: the base commit has no look for these pages.
			await updateAutomatically();
			await readAutoNoticeOff(browser);
			await readEmptyOff(browser);
		} else {
			await checkRulesUnderSwitch(browser);
			await checkRoomGroups(browser);
			await checkRoomSkills(browser);
			await checkSkillsHeader(browser);
			await checkSkillsMessage(browser);
			await checkSkillsTable(browser);
			await updateAutomatically();
			await readAutoNoticeOff(browser);
			await checkNewPartsOn(browser);
			await checkEmpty(browser);
		}
	} finally {
		await browser.close();
		if (process.env.SKILLS_LOOK_OFF_DUMP) fs.writeFileSync(process.env.SKILLS_LOOK_OFF_DUMP, `${JSON.stringify(offDump, null, 1)}\n`);
	}
	console.log(process.env.SKILLS_LOOK_OFF_DUMP ? `settings look skills ui smoke: the switch-off reader wrote ${process.env.SKILLS_LOOK_OFF_DUMP}` : "settings look skills ui smoke passed");
} finally {
	await stopSmokeServer(server);
	fs.rmSync(tempRoot, { recursive: true, force: true });
}
