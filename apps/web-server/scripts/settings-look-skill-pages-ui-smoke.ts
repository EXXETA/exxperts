// The settings look on a skill's page, the review before adding, Write it
// yourself, the upload dialog, From a repository address and Browse featured,
// built behind the look's switch. With the switch off every one of them keeps
// today's markup and styles (a reader writes both to a file, to compare a page
// built from before this change with this one). With it on, both themes: the
// sub-page header with its back link, a skill's page, the review with its foot,
// the write form, the upload dialog, the repository's rows and Browse
// featured's rows; at 390 px too; and every screen at each width from 1440
// to 390 px with nothing sideways. The repositories are folders on this
// machine; throwaway HOME.
//
// Run: node scripts/run-smokes.mjs settings-look-skill-pages-ui
// SKILL_PAGES_LOOK_OFF_DUMP=<file> runs only the switch-off reader and writes
// what it read, to compare a run on the base commit with one on this branch.
import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import JSZip from "jszip";
import { chromium, type Browser, type BrowserContextOptions, type Locator, type Page } from "playwright";
import { authedFetch, freePort, SMOKE_SERVER_AUTH_ENV, SMOKE_SERVER_SPAWN_TREE_OPTIONS, smokeHomeEnv, stopSmokeServer, waitForServer } from "./smoke-server-process.js";
import { waitEvery } from "./smoke-wait.js";
import { answered, assert, DARK, desktop, goToPage, installColourTools, LIGHT, lookPages, notLookPageFilesAfterLook, phone, redEdges, rulesOutsideRoots, same, SWITCH_CLASS, type Theme } from "./settings-look-smoke-parts.js";
// A namespace import, so the switch-off reader also runs against the page's code from before this look's words existed.
import * as copy from "../../web-ui/src/skill-source-copy.js";

const waitUntil = waitEvery(100);

{
	const executable = typeof chromium?.executablePath === "function" ? chromium.executablePath() : "";
	if (!executable || !fs.existsSync(executable)) {
		console.log("settings look skill pages ui smoke skipped (Chromium not installed)");
		process.exit(0);
	}
}

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const webServerDir = path.resolve(scriptDir, "..");
const repoRoot = path.resolve(webServerDir, "..", "..");
const LOOK_FILE = "49-settings-look-skill-pages.css";
/**
 * Where the outside-folder line's dot sits: whether the line's words wrap, and
 * whether the dot's middle is inside their first line. A pseudo-element has no
 * box to measure, so its middle follows from the line's alignment.
 */
function outsideLineDot(one: Element): { wraps: boolean; onFirstLine: boolean } {
	const dot = getComputedStyle(one, "::before");
	const box = one.getBoundingClientRect();
	const style = getComputedStyle(one);
	const middle = style.alignItems === "center" ? box.top + box.height / 2 : box.top + parseFloat(style.paddingTop) + parseFloat(dot.marginTop) + parseFloat(dot.height) / 2;
	const words = document.createRange();
	words.selectNodeContents(one.querySelector("span")!);
	const lines = [...words.getClientRects()];
	return { wraps: new Set(lines.map((line) => Math.round(line.top))).size > 1, onFirstLine: middle > lines[0].top && middle < lines[0].bottom };
}

/** The upload dialog is drawn outside the window, so its rules start with its own overlay and the switch's class. */
const UPLOAD_ROOT = ".skill-upload-overlay.settings-look-next";
const tempRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "exxperts-settings-look-skill-pages-")));
const tempHome = path.join(tempRoot, "home");
const store = path.join(tempHome, ".exxperts", "agent", "skills");
const repos = path.join(tempRoot, "repos");
const team = path.join(repos, "team");
fs.mkdirSync(store, { recursive: true });
const port = await freePort();
const baseUrl = `http://127.0.0.1:${port}`;
const ROOMS = ["Board papers", "Monthly reporting"];
const { openPage, openWindow } = lookPages({ baseUrl, room: ROOMS[1] });
/** The look's ink per theme. */
const INK = { [LIGHT]: "#111111", [DARK]: "#f4f1ec" };

// --- The library ---------------------------------------------------------------

function git(repo: string, args: string[]): void {
	const run = spawnSync("git", ["-c", "user.email=smoke@test", "-c", "user.name=Smoke", ...args], { cwd: repo, encoding: "utf-8" });
	if (run.status !== 0) throw new Error(`git ${args.join(" ")}: ${run.stderr || run.stdout}`);
}
function writeSkill(root: string, name: string, description: string, body = `The ${name} instructions.`, extra = "", files: Record<string, string> = {}): string {
	fs.mkdirSync(path.join(root, name), { recursive: true });
	const manifest = `---\nname: ${name}\ndescription: ${description}\n${extra}---\n\n${body}\n`;
	fs.writeFileSync(path.join(root, name, "SKILL.md"), manifest);
	for (const [file, text] of Object.entries(files)) {
		fs.mkdirSync(path.dirname(path.join(root, name, file)), { recursive: true });
		fs.writeFileSync(path.join(root, name, file), text);
	}
	return manifest;
}
async function api(method: string, route: string, body?: unknown): Promise<{ status: number; body: any }> {
	const answer = await authedFetch(`${baseUrl}${route}`, { method, ...(body === undefined ? {} : { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }) });
	const text = await answer.text();
	return { status: answer.status, body: text ? JSON.parse(text) : null };
}
const seeded = (answer: { status: number; body: any }, what: string) => assert(answer.status >= 200 && answer.status < 300, `seeding ${what}: ${answer.status} ${JSON.stringify(answer.body)}`);

/** pdf's instructions: long enough that the page shows the start and "Show all instructions". */
const PDF_BODY = ["# PDF", "", "To fill in a form, read forms.md first.", "", ...Array.from({ length: 30 }, (_, i) => `Step ${i + 1}: do the next thing with the file, and say what you did.`)].join("\n");
const PDF_SCRIPTS = Object.fromEntries(["fill_form.py", "merge.py", "split.py", "extract_text.py", "extract_tables.py", "rotate.py", "check_fields.py", "watermark.py"].map((name) => [`scripts/${name}`, "print('ok')\n"]));
const DESCRIPTIONS = {
	pdf: "Read, fill in and combine PDF files.",
	"board-pack": "Put the board papers together from this month's reports, in the order the board reads them, with a cover note and a list of what is missing.",
	"internal-comms": "Write internal announcements in the house style.",
	"too-many": "A skill with too many files.",
};

const LONG_NAME = "w".repeat(48);

/** An upload: a zip with SKILL.md, a template, a document and `scripts` scripts. */
async function zipOf(name: string, scripts: number, body = "Use this skill when the person asks for the quarterly report.\n\nRead the figures they give you."): Promise<Buffer> {
	const zip = new JSZip();
	zip.file(`${name}/SKILL.md`, `---\nname: ${name}\ndescription: Build the quarterly report from the figures you give it: the summary, the tables, the charts and the slide.\nlicense: MIT\nversion: "2.1.0"\n---\n\n${body}\n`);
	zip.file(`${name}/templates/tables.xlsx`, "x");
	zip.file(`${name}/forms.md`, "x");
	for (let i = 0; i < scripts; i++) zip.file(`${name}/scripts/s${i}.py`, "print(1)\n");
	return zip.generateAsync({ type: "nodebuffer" });
}

// --- Opening the pages -------------------------------------------------------------

const SKILLS = ".settings-dialog-pane .skills-page";
const button = (page: Page, name: string | RegExp) => page.locator(".settings-dialog").getByRole("button", { name, exact: typeof name === "string" });

/** Settings, Skills, open and filled in. */
async function openSkills(browser: Browser, options: BrowserContextOptions, look: "on" | "off" = "on"): Promise<Page> {
	const page = await openPage(browser, options, look);
	await openWindow(page, "settings");
	await goToPage(page, "Skills");
	await page.locator(`${SKILLS} .skill-table`).waitFor({ timeout: 10000 });
	await answered(page, "Settings, Skills");
	return page;
}
async function openSkill(page: Page, name: string): Promise<void> {
	await page.locator(`${SKILLS} .skill-table-row`).filter({ has: page.locator(".skill-table-name-text", { hasText: new RegExp(`^${name}$`) }) }).click();
	await page.locator(`${SKILLS} .skill-detail`).waitFor({ timeout: 10000 });
	await answered(page, `${name}'s page`);
}
async function addWay(page: Page, way: keyof typeof copy.ADD_SKILL_WAYS): Promise<void> {
	await button(page, "Add skill").click();
	await page.getByRole("menuitem", { name: copy.ADD_SKILL_WAYS[way] }).click();
}
async function upload(page: Page, name: string, content: Buffer): Promise<void> {
	await addWay(page, "upload");
	await page.locator(".skill-upload-input").setInputFiles({ name: `${name}.zip`, mimeType: "application/octet-stream", buffer: content });
	await page.locator(`${SKILLS} .skill-review`).waitFor({ timeout: 15000 });
	await answered(page, `${name}'s review`);
}
async function scan(page: Page): Promise<void> {
	await addWay(page, "repository");
	await page.locator(`${SKILLS} .skill-import-url`).fill(team);
	await button(page, "Scan").click();
	await page.locator(`${SKILLS} .skill-import-found`).waitFor({ timeout: 30000 });
	await answered(page, "the scan");
}
/** A repository's skill opened for review: with the look on its row opens it; with it off it is ticked and reviewed. */
async function reviewFromRepository(page: Page, name: string, look: "on" | "off"): Promise<void> {
	const option = page.locator(`${SKILLS} .skill-import-option`).filter({ has: page.locator(".skill-import-option-name", { hasText: new RegExp(`^${name}`) }) });
	if (look === "on") await option.click();
	else {
		await option.locator("input[type=checkbox]").check();
		await button(page, /^Review 1 selected$/).click();
	}
	await page.locator(`${SKILLS} .skill-review`).waitFor({ timeout: 15000 });
	await answered(page, `${name}'s review`);
}
async function browse(page: Page): Promise<void> {
	await addWay(page, "featured");
	await page.locator(`${SKILLS} .skill-browse-directory`).waitFor({ timeout: 30000 });
	await answered(page, "Browse featured");
}

/** Waits until every transition has ended: a press, a hover that just left or a scroll's hairline still fades. */
async function settled(page: Page, what: string): Promise<void> {
	await waitUntil(() => page.evaluate(() => document.getAnimations().every((one) => one.playState !== "running" || one.effect?.getComputedTiming().endTime === Infinity)), `${what}: transitions end`, 5000);
}

/** The screens this task lays out, each opened from Settings, Skills; `roots` are what the switch-off reader reads. */
type Scene = { label: string; roots: string[]; open: (page: Page, look: "on" | "off") => Promise<void> };
const PANE = [SKILLS];
const SCENES: Scene[] = [
	{ label: "a skill's page from a repository, in two rooms, with its Delete question", roots: [SKILLS, ".confirm-dialog-backdrop"], open: async (page) => {
		await openSkill(page, "pdf");
		await page.locator(`${SKILLS} .skill-detail`).getByRole("button", { name: "Delete", exact: true }).click();
		await page.locator(".confirm-dialog-backdrop").waitFor();
	} },
	{ label: "a skill's page, by hand", roots: PANE, open: (page) => openSkill(page, "press-release") },
	{ label: "a skill's page, files that can't be opened", roots: PANE, open: (page) => openSkill(page, "scans") },
	{ label: "a skill's page, one exxperts doesn't own", roots: PANE, open: (page) => openSkill(page, "brand-voice") },
	{ label: "the review of an upload", roots: PANE, open: async (page) => upload(page, "quarterly-report", await zipOf("quarterly-report", 8)) },
	{ label: "the review of a name in the library", roots: PANE, open: async (page) => upload(page, "pdf", await zipOf("pdf", 1)) },
	{ label: "the review of a repository's skill", roots: PANE, open: async (page, look) => { await scan(page); await reviewFromRepository(page, "board-pack", look); } },
	{ label: "Write it yourself", roots: PANE, open: async (page) => { await addWay(page, "write"); await page.locator(`${SKILLS} .skill-write-block`).waitFor(); } },
	{ label: "Write it yourself, a name refused", roots: PANE, open: async (page) => { await addWay(page, "write"); await page.locator(`${SKILLS} .skill-write-block input`).first().fill("!!!"); } },
	{ label: "the upload dialog", roots: [SKILLS, ".skill-upload-overlay"], open: async (page) => { await addWay(page, "upload"); await page.locator(".skill-upload-modal").waitFor(); } },
	{ label: "From a repository address, before a scan", roots: PANE, open: async (page) => { await addWay(page, "repository"); await page.locator(`${SKILLS} .skill-import-url`).fill(team); } },
	{ label: "From a repository address, after a scan", roots: PANE, open: scan },
	{ label: "Browse featured, a source failed", roots: PANE, open: browse },
];

// --- With the switch off ------------------------------------------------------------

/** What renders under each root: its markup, with React's generated ids and this run's folders blanked, and every element's computed style (with its ::before and ::after) as a hash. */
async function readRoots(page: Page, roots: string[]): Promise<Record<string, { markup: string; styles: string[]; rootStyle: string[] }>> {
	await page.mouse.move(2, 2);
	// This run's folder in the words on screen, as one placeholder: its random name wraps a long line differently each run.
	await page.evaluate((folder) => {
		const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
		for (let node = walker.nextNode(); node; node = walker.nextNode()) if (node.nodeValue!.includes(folder)) node.nodeValue = node.nodeValue!.split(folder).join("/tmp/exxperts-smoke");
		for (const element of document.querySelectorAll("[title]")) if (element.getAttribute("title")!.includes(folder)) element.setAttribute("title", element.getAttribute("title")!.split(folder).join("/tmp/exxperts-smoke"));
	}, tempRoot);
	await settled(page, "the switch-off reader");
	const read = await page.evaluate((roots) => {
		const hash = (text: string) => { let h = 0x811c9dc5; for (let i = 0; i < text.length; i++) { h ^= text.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; } return h.toString(16).padStart(8, "0"); };
		// Sorted: the browser lists custom properties in an order that changes between runs.
		const styleOf = (target: Element, pseudo?: string) => { const style = getComputedStyle(target, pseudo); const out: string[] = []; for (let i = 0; i < style.length; i++) out.push(`${style[i]}:${style.getPropertyValue(style[i])}`); return out.sort().join(";"); };
		return Object.fromEntries(roots.map((root) => {
			const element = [...document.querySelectorAll(root)].find((one) => one.getClientRects().length > 0);
			if (!element) return [root, null];
			const styles = [element, ...element.querySelectorAll("*")].map((one) => `${one.tagName.toLowerCase()}.${(one.getAttribute("class") ?? "").trim().split(/\s+/).join(".")} ${hash(styleOf(one))} ${hash(styleOf(one, "::before"))} ${hash(styleOf(one, "::after"))}`);
			// The root's whole style as well, so a difference the hashes find can be named.
			return [root, { markup: element.outerHTML, styles, rootStyle: styleOf(element).split(";") }];
		}));
	}, roots);
	const out: Record<string, { markup: string; styles: string[]; rootStyle: string[] }> = {};
	for (const root of roots) {
		const one = read[root];
		assert(one, `${root} is on screen`);
		out[root] = { ...one, markup: one.markup.split(tempRoot).join("/tmp/exxperts-smoke").replace(/:r[0-9a-z]+:|«r[0-9a-z]+»/g, "<id>") };
	}
	return out;
}

const offDump: Record<string, Awaited<ReturnType<typeof readRoots>>> = {};
async function checkOff(browser: Browser): Promise<void> {
	// The comparison with the base reads both widths; a run on its own, only the desktop's, to stay quick.
	const widths = process.env.SKILL_PAGES_LOOK_OFF_DUMP ? [["1440", desktop(1440, 900, LIGHT)], ["390", phone(LIGHT)]] as const : [["1440", desktop(1440, 900, LIGHT)]] as const;
	for (const scene of SCENES) {
		for (const [width, options] of widths) {
			const page = await openSkills(browser, options, "off");
			await scene.open(page, "off");
			const at = `switch off, ${scene.label}, ${width}`;
			same(await page.locator(".settings-look-next, .skill-message, .skill-field-help, .skill-field-error, .skill-file-kind-count, .rs-btn-danger-soft").count(), 0, `${at}: the new look's classes`);
			offDump[at] = await readRoots(page, scene.roots);
			await page.context().close();
		}
	}
	console.log(`  ok  switch off: ${SCENES.length} screens at ${widths.map(([width]) => width).join(" and ")}, none with the new look's classes`);
}

/** With the switch off, a skill's page as skill updates leave it, read at both widths: a check that found nothing new, Update automatically on, and an update waiting. The comparison run alone: it changes the library. */
async function readOffUpdates(browser: Browser): Promise<void> {
	const read = async (label: string, name: string) => {
		for (const [width, options] of [["1440", desktop(1440, 900, LIGHT)], ["390", phone(LIGHT)]] as const) {
			const page = await openSkills(browser, options, "off");
			await openSkill(page, name);
			const at = `switch off, ${label}, ${width}`;
			same(await page.locator(".settings-look-next, .skill-message, .skill-file-kind-count, .rs-btn-danger-soft").count(), 0, `${at}: the new look's classes`);
			offDump[at] = await readRoots(page, PANE);
			await page.context().close();
		}
	};
	seeded(await api("POST", "/api/skills/updates/check", { names: ["pdf", "internal-comms"] }), "a check that finds nothing new");
	await read("a skill's page, no update", "pdf");
	seeded(await api("PUT", "/api/skills/internal-comms/auto-update", { on: true }), "internal-comms updates automatically");
	await read("a skill's page, Update automatically on", "internal-comms");
	// pdf's next version: its new description holds a hidden character, so its group shows the warning, the new description and the instructions too.
	writeSkill(path.join(team, "skills"), "pdf", "Read, fill in, combine and split​ PDF files.", `${PDF_BODY}\n\nOne more step.`, 'license: Apache-2.0\nversion: "1.3.0"\n');
	git(team, ["add", "-A"]);
	git(team, ["commit", "-q", "-m", "second"]);
	seeded(await api("POST", "/api/skills/updates/check", { names: ["pdf"] }), "a check that finds pdf's next version");
	await read("a skill's page, an update waiting", "pdf");
	console.log("  ok  switch off: a skill's page with no update, with Update automatically on and with an update waiting, at 1440 and 390");
}

/** With the switch on, the pages that share these screens' classes and components, read to compare with the base. */
async function readOnNeighbours(browser: Browser): Promise<void> {
	const page = await openSkills(browser, desktop(1440, 900, LIGHT), "on");
	await button(page, copy.CHECK_NOW).click();
	await waitUntil(async () => (await page.locator(`${SKILLS} .skill-check-now[aria-busy="true"]`).count()) === 0, "the check is answered", 30000);
	await answered(page, "after the check");
	offDump["switch on, Settings, Skills after a check, 1440"] = await readRoots(page, [SKILLS]);
	await openSkill(page, "pdf");
	await page.locator(`${SKILLS} .skill-update-group`).waitFor({ timeout: 10000 });
	offDump["switch on, a skill's update group with an update found, 1440"] = await readRoots(page, [`${SKILLS} .skill-update-group`]);
	await page.context().close();
	for (const [label, which, root] of [
		["switch on, a room's Skills, 1440", "room", ".room-settings-section:not([hidden]) .room-skills-section:not(.room-connectors-section)"],
		["switch on, Settings, Connectors, 1440", "settings", ".settings-dialog-pane .connectors-page, .settings-dialog-pane > *"],
	] as const) {
		const one = await openPage(browser, desktop(1440, 900, LIGHT), "on");
		await openWindow(one, which);
		await goToPage(one, which === "room" ? "Skills" : "Connectors");
		await answered(one, label);
		offDump[label] = await readRoots(one, [root]);
		await one.context().close();
	}
	console.log("  ok  switch on: Settings, Skills after a check, a skill's update group, a room's Skills and Settings, Connectors read");
}

/** The rules of the look's skill pages file that would reach an element on the page now, under the pointer, pressed or focused too (their pseudo-elements read as their element). */
function rulesReaching(page: Page): Promise<string[]> {
	const css = fs.readFileSync(path.join(repoRoot, "apps", "web-ui", "src", "styles", LOOK_FILE), "utf8");
	return page.evaluate((text) => {
		const sheet = new CSSStyleSheet();
		sheet.replaceSync(text);
		const selectors: string[] = [];
		const walk = (rules: CSSRuleList) => {
			for (const rule of rules) {
				if (rule instanceof CSSStyleRule) selectors.push(rule.selectorText);
				if ("cssRules" in rule && (rule as CSSGroupingRule).cssRules.length) walk((rule as CSSGroupingRule).cssRules);
			}
		};
		walk(sheet.cssRules);
		const elements = [...document.querySelectorAll("*")];
		return selectors.filter((selector) => {
			const anyState = selector.replace(/::[\w-]+|:(?:hover|active|focus-visible|focus)(?![\w-])/g, "");
			return elements.some((element) => element.matches(anyState));
		});
	}, css);
}

/** With the switch on, the pages that share these screens' classes and components take none of their rules: a connector's page (its way back is a skill page's), Settings, Connectors and a room's Skills. */
async function checkNeighbours(browser: Browser): Promise<void> {
	const page = await openPage(browser, desktop(1440, 900, LIGHT), "on");
	await openWindow(page, "settings");
	await goToPage(page, "Connectors");
	await answered(page, "Settings, Connectors");
	same(await rulesReaching(page), [], "Settings, Connectors: rules of the skill pages' file");
	await page.locator(".connector-item", { hasText: "notes-server" }).locator(".connector-item-hit").click();
	await page.locator(".connector-page").waitFor({ timeout: 5000 });
	await answered(page, "a connector's page");
	same(await rulesReaching(page), [], "a connector's page: rules of the skill pages' file");
	await page.context().close();
	const room = await openPage(browser, desktop(1440, 900, LIGHT), "on");
	await openWindow(room, "room");
	await goToPage(room, "Skills");
	await answered(room, "a room's Skills");
	same(await rulesReaching(room), [], "a room's Skills: rules of the skill pages' file");
	await room.context().close();
	// The row's own reader: on a skill's page the back link's rules are found.
	const skills = await openSkills(browser, desktop(1440, 900, LIGHT));
	await openSkill(skills, "pdf");
	assert((await rulesReaching(skills)).some((selector) => selector.includes(".pane-head-back")), "the row's own reader: a skill's page takes the back link's rules");
	await skills.context().close();
	console.log("  ok  with the switch on, a connector's page, Settings, Connectors and a room's Skills take no rule of the skill pages' file");
}

/** Every rule of the look's skill pages file starts with the switch's class, or the upload dialog's overlay with it. */
async function checkRulesUnderSwitch(browser: Browser): Promise<void> {
	const page = await openPage(browser, desktop(1280), "off");
	const css = fs.readFileSync(path.join(repoRoot, "apps", "web-ui", "src", "styles", LOOK_FILE), "utf8");
	same(await rulesOutsideRoots(page, css, [SWITCH_CLASS, UPLOAD_ROOT]), [], `rules in ${LOOK_FILE} outside ${SWITCH_CLASS} and ${UPLOAD_ROOT}`);
	// The check's own probe: a rule outside both roots is found, in a media query too, and the overlay without the switch is not a root.
	same(await rulesOutsideRoots(page, `.skill-detail { color: red; } @media (max-width: 760px) { ${SWITCH_CLASS} .skill-review, .skill-review-actions { top: 0; } } .skill-upload-overlay .skill-upload-modal { color: red; } ${UPLOAD_ROOT} .skill-upload-drop { color: red; }`, [SWITCH_CLASS, UPLOAD_ROOT]), [".skill-detail", ".skill-review-actions", ".skill-upload-overlay .skill-upload-modal"], "the check's own probe");
	const imports = [...fs.readFileSync(path.join(repoRoot, "apps", "web-ui", "src", "styles.css"), "utf8").matchAll(/@import "\.\/styles\/([^"]+)";/g)].map((match) => match[1]);
	same(notLookPageFilesAfterLook(imports), [], "style files after the look's first that are not its page files");
	assert(imports.includes(LOOK_FILE), `the page loads ${LOOK_FILE}`);
	await page.context().close();
	console.log(`  ok  every rule of ${LOOK_FILE} sits under ${SWITCH_CLASS} or ${UPLOAD_ROOT}, and the page loads it with the look's page files`);
}

// --- With the switch on: tools ------------------------------------------------------

/** The colour tools, and boxes read in the page: the first element on screen for a selector, the content's edges, sideways scrolling. */
async function installTools(page: Page): Promise<void> {
	await installColourTools(page);
	await page.evaluate((skills) => {
		const w = window as any;
		const shown = (element: Element) => element.getClientRects().length > 0 && getComputedStyle(element).visibility !== "hidden";
		w.__el = (selector: string) => [...document.querySelectorAll(selector)].find(shown) ?? null;
		w.__box = (selector: string) => { const element = w.__el(selector); return element ? element.getBoundingClientRect().toJSON() : null; };
		/** The content's edges: the page's box inside its padding. */
		w.__content = () => { const page = document.querySelector(skills)!; const box = page.getBoundingClientRect(); const style = getComputedStyle(page); return { left: box.left + parseFloat(style.paddingLeft), right: box.right - parseFloat(style.paddingRight) }; };
		/** Where an element's own words start and end. */
		w.__words = (element: Element) => { const range = document.createRange(); range.selectNodeContents(element); return range.getBoundingClientRect().toJSON(); };
		w.__sideways = () => { const pane = document.querySelector(".settings-dialog-pane")!; return pane.scrollWidth > pane.clientWidth || document.documentElement.scrollWidth > window.innerWidth; };
	}, SKILLS);
}
const pane = (page: Page, y: number) => page.evaluate((y) => { document.querySelector(".settings-dialog-pane")!.scrollTop = y; }, y);

/** A colour as the page resolves it, from a probe inside the window (a token's value in this theme). */
const resolved = (page: Page, value: string, property = "color") => page.evaluate(({ value, property }) => {
	const probe = document.createElement("i");
	probe.style.setProperty(property, value);
	document.querySelector(".settings-dialog")!.append(probe);
	const read = getComputedStyle(probe).getPropertyValue(property);
	probe.remove();
	return read;
}, { value, property });

/** At most one ink button, and nothing coloured but a dot (drawn as ::before) or a red button, under `root`; each word at 4.5:1 or more. Needs installTools. */
async function checkShared(page: Page, root: string, theme: Theme, at: string): Promise<void> {
	await page.mouse.move(2, 2);
	await settled(page, at);
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
		// Words on screen (a disabled control's at 45 % aside): each at 4.5:1 against what is behind it.
		const faint = all.filter((element) => [...element.childNodes].some((node) => node.nodeType === Node.TEXT_NODE && node.textContent!.trim()) && !element.closest(":disabled, [aria-disabled=true], input, textarea"))
			.map((element) => [`${element.tagName.toLowerCase()}.${element.className}`, Math.round(w.__contrast(element) * 10) / 10] as const)
			.filter(([, ratio]) => ratio < 4.5);
		return { inked, coloured, faint };
	}, { root, ink: INK[theme] });
	assert(read.inked.length <= 1, `${at}: ${read.inked.length} ink buttons: ${read.inked.join(", ")}`);
	same(read.coloured, [], `${at}: colour on anything but a dot or a red button`);
	same(read.faint, [], `${at}: words under 4.5:1`);
}

/** Under the pointer and pressed, each part of `target` (a selector inside it, and its floor: 4.5 for words, 3 for a mark) stays readable over the state's fill. Leaves the pointer up over it. */
async function checkOverFills(page: Page, target: Locator, parts: [string, number][], at: string): Promise<void> {
	const read = () => target.evaluate((one, parts) => parts.map(([selector, floor]) => Math.round((window as any).__contrast(one.querySelector(selector)) * 100) / 100 >= floor), parts);
	await target.hover();
	await settled(page, `${at} under the pointer`);
	same(await read(), parts.map(() => true), `${at} under the pointer: ${parts.map(([selector, floor]) => `${selector} at ${floor}:1`).join(", ")}`);
	await page.mouse.down();
	await settled(page, `${at} pressed`);
	same(await read(), parts.map(() => true), `${at} pressed: ${parts.map(([selector, floor]) => `${selector} at ${floor}:1`).join(", ")}`);
	await page.mouse.up();
}

/** A red dot drawn as ::before: 8 px, round, in the red the look gives errors; and the words beside it in `words`. */
async function checkDot(page: Page, selector: string, words: string, at: string): Promise<void> {
	const read = await page.evaluate((selector) => {
		const element = (window as any).__el(selector);
		if (!element) return null;
		const dot = getComputedStyle(element, "::before");
		return { dot: [dot.width, dot.height, dot.borderRadius, dot.backgroundColor], colour: getComputedStyle(element).color };
	}, selector);
	assert(read, `${at}: ${selector} on screen`);
	same(read, { dot: ["8px", "8px", "50%", await resolved(page, "var(--error-text)", "background-color")], colour: await resolved(page, words) }, `${at}: the red dot`);
}

/** An element's fill and edge as the person sees them, waiting for a hover or press to settle. */
async function settledFill(page: Page, selector: string, want: string, at: string): Promise<void> {
	const read = () => page.evaluate((selector) => getComputedStyle((window as any).__el(selector)).backgroundColor, selector);
	await waitUntil(async () => (await read()) === want, `${at}: ${want}`, 3000).catch(async () => { throw new Error(`${at}: got ${await read()}, expected ${want}`); });
}

/** A control's hover, press and keyboard ring: the row fills under the pointer and pressed, and its ring is whole (nothing between it and the pane cuts it). */
async function checkStates(page: Page, selector: string, at: string, letGo = ".settings-dialog-head"): Promise<void> {
	const target = page.locator(selector).first();
	await target.scrollIntoViewIfNeeded();
	await target.hover();
	await settledFill(page, selector, await resolved(page, "var(--exx-row-hover)", "background-color"), `${at}: under the pointer`);
	await page.mouse.down();
	await settledFill(page, selector, await resolved(page, "var(--exx-row-press)", "background-color"), `${at}: pressed`);
	// Let go away from it but inside its window (the veil would close it), so the press opens nothing.
	const away = (await page.locator(letGo).first().boundingBox())!;
	await page.mouse.move(away.x + 4, away.y + away.height / 2);
	await page.mouse.up();
	await target.focus();
	await page.keyboard.press("Shift+Tab");
	await page.keyboard.press("Tab");
	const ring = await target.evaluate((element) => {
		const style = getComputedStyle(element);
		const clips: string[] = [];
		for (let at = element.parentElement; at && !at.matches(".settings-dialog-pane, .skill-upload-overlay"); at = at.parentElement) if (getComputedStyle(at).overflow !== "visible") clips.push(at.className);
		return { focus: element.matches(":focus-visible"), outline: `${style.outlineStyle} ${style.outlineWidth}`, clips };
	});
	same(ring, { focus: true, outline: "solid 2px", clips: [] }, `${at}: the keyboard's ring`);
	await page.keyboard.press("Shift+Tab");
}

// --- With the switch on: the sub-page header ---------------------------------------------

/** The sub-pages, each opened from Settings, Skills with the switch on; `ready` is on screen once it has filled in. */
const SUB_PAGES: Array<{ label: string; open: (page: Page) => Promise<void>; ready: string }> = [
	{ label: "a skill's page", open: (page) => openSkill(page, "pdf"), ready: ".skill-detail" },
	{ label: "Write it yourself", open: (page) => addWay(page, "write"), ready: ".skill-write-block" },
	{ label: "From a repository address", open: (page) => addWay(page, "repository"), ready: ".skill-import-url" },
	{ label: "Browse featured", open: browse, ready: ".skill-browse-directory" },
	{ label: "a review", open: async (page) => upload(page, "quarterly-report", await zipOf("quarterly-report", 8)), ready: ".skill-review" },
];

async function checkSubPageHeader(browser: Browser): Promise<void> {
	for (const theme of [LIGHT, DARK] as const) {
		const page = await openSkills(browser, desktop(1440, 900, theme));
		await installTools(page);
		for (const sub of SUB_PAGES) {
			const at = `${theme}, ${sub.label}`;
			await sub.open(page);
			await page.locator(`${SKILLS} ${sub.ready}`).first().waitFor({ timeout: 15000 });
			// A long page, whatever the screen holds, so it scrolls 400: the box the line sticks in, made longer.
			await page.evaluate(() => { const spacer = document.createElement("div"); spacer.className = "smoke-spacer"; spacer.style.cssText = "height: 1600px; flex: none"; (window as any).__el(".pane-head-back").closest(".pane-top").parentElement.append(spacer); });
			const read = () => page.evaluate((skills) => {
				const w = window as any;
				const back = w.__el(".pane-head-back");
				const head = back.closest(".pane-head");
				const title = head.querySelector("h2");
				const windowName = w.__el(".settings-dialog-title");
				const type = (one: Element) => { const style = getComputedStyle(one); return `${style.fontSize}/${style.lineHeight}`; };
				const middle = (one: Element) => { const box = one.getBoundingClientRect(); return Math.round(box.top + box.height / 2); };
				const mark = back.querySelector("svg").getBoundingClientRect();
				const close = w.__el(".settings-dialog-close svg").getBoundingClientRect();
				return {
					named: [back.getAttribute("aria-label"), back.textContent],
					mark: mark.left - w.__content().left,
					top: back.getBoundingClientRect().top,
					band: Math.round(head.getBoundingClientRect().height),
					shadow: getComputedStyle(head).boxShadow,
					close: close.right - w.__content().right,
					title: title.getBoundingClientRect().top,
					types: [type(title), type(windowName)],
					middles: [back, title, w.__el(".settings-dialog-close svg"), windowName].map(middle),
					nameAfter: Math.round(title.getBoundingClientRect().left - back.getBoundingClientRect().right),
				};
			}, SKILLS);
			const rest = await read();
			same(rest.named, [copy.SKILL_PAGE_BACK_NAME, ""], `${at}: the arrow alone, named for a screen reader`);
			same([Math.abs(rest.mark) <= 1, rest.band, Math.abs(rest.close) <= 1], [true, 56, true], `${at}: the arrow's mark on the content's left edge (${rest.mark}), its line 56 tall, the close's mark on the right edge (${rest.close})`);
			same(rest.types, ["18px/24px", "18px/24px"], `${at}: the name at the window name's size and line`);
			same(Math.max(...rest.middles) - Math.min(...rest.middles) <= 1, true, `${at}: the arrow, the name, the close and the window's name on one line (${rest.middles.join(", ")})`);
			same(rest.nameAfter, 12, `${at}: the name 12 after the arrow`);
			assert(!await page.evaluate((shadow) => (window as any).__painted(shadow.replace(/ 0px.*$/, "")), rest.shadow), `${at}: a hairline before a scroll: ${rest.shadow}`);
			await pane(page, 400);
			await waitUntil(async () => (await read()).shadow !== rest.shadow, `${at}: the hairline after a scroll`, 3000);
			await settled(page, at);
			const scrolled = await read();
			same([Math.round(scrolled.top - rest.top), Math.round(scrolled.title - rest.title)], [0, 0], `${at}: the arrow and the name after a 400 px scroll`);
			assert(await page.evaluate((shadow) => (window as any).__painted(shadow.replace(/ 0px.*$/, "")), scrolled.shadow), `${at}: the hairline after a scroll: ${scrolled.shadow}`);
			// A press on the line's middle reaches nothing scrolled under it: a probe button the page's width, under the line.
			const pressed = await page.evaluate(() => {
				const probe = document.createElement("button");
				probe.className = "smoke-under";
				probe.style.cssText = "display: block; width: 100%; height: 40px; flex: none";
				probe.onclick = () => { probe.dataset.pressed = "yes"; };
				document.querySelector(".smoke-spacer")!.before(probe);
				const scroller = document.querySelector(".settings-dialog-pane")!;
				const top = scroller.getBoundingClientRect().top;
				scroller.scrollTop += probe.getBoundingClientRect().top - top + 20 - 28;
				const box = probe.getBoundingClientRect();
				return { x: box.left + box.width / 2, y: top + 28, under: box.top < top + 28 && box.bottom > top + 28 };
			});
			assert(pressed.under, `${at}: the probe under the line`);
			await page.mouse.click(pressed.x, pressed.y);
			same(await page.evaluate(() => (document.querySelector(".smoke-under") as HTMLElement).dataset.pressed ?? "no"), "no", `${at}: a press on the line's middle reaches what is under it`);
			// Back returns to the list. The page's element stays from one screen to the next, so the probe and spacer go first.
			await page.evaluate(() => { document.querySelector(".smoke-under")!.remove(); document.querySelector(".smoke-spacer")!.remove(); document.querySelector(".settings-dialog-pane")!.scrollTop = 0; });
			await page.locator(".pane-head-back").click();
			await page.locator(`${SKILLS} .skill-table`).waitFor({ timeout: 10000 });
			await answered(page, `${at}: back on the list`);
		}
		await page.context().close();

		const small = await openSkills(browser, phone(theme));
		await installTools(small);
		for (const sub of SUB_PAGES) {
			await sub.open(small);
			await small.locator(`${SKILLS} ${sub.ready}`).first().waitFor({ timeout: 15000 });
			const read = await small.evaluate((skills) => {
				const w = window as any;
				const back = w.__el(".pane-head-back").getBoundingClientRect();
				const head = w.__el(".pane-head-back").closest(".pane-head");
				const title = head.querySelector("h2");
				const line = parseFloat(getComputedStyle(title).lineHeight);
				const first = [...document.querySelector(skills)!.querySelectorAll("*")].filter((one) => one.getClientRects().length > 0 && !one.closest(".pane-head") && !one.contains(head)).map((one) => one.getBoundingClientRect().top);
				return {
					ways: [".settings-dialog-back", ".pane-head-back"].filter((selector) => w.__el(selector)).length,
					box: [back.width, back.height],
					nameOnLine: Math.abs(title.getBoundingClientRect().top + line / 2 - (back.top + back.height / 2)) <= 1,
					first: first.every((top) => top >= head.getBoundingClientRect().bottom - 1),
					sideways: w.__sideways(),
				};
			}, SKILLS);
			same(read, { ways: 1, box: [44, 44], nameOnLine: true, first: true, sideways: false }, `${theme}, 390, ${sub.label}: one way back, 44 to the finger, the name on its line, and both first in the body`);
			await small.locator(".pane-head-back").click();
			await small.locator(`${SKILLS} .skill-table`).waitFor({ timeout: 10000 });
		}
		await small.context().close();
	}
	console.log("  ok  the sub-page header on a skill's page, Write it yourself, From a repository address, Browse featured and a review: the arrow alone, named for a screen reader, its mark on the content's left edge; the name 18/24 as the window's, 12 after it, on one line with it, the close and the window's name; the line 56 tall and still after a 400 px scroll, the close's mark on the right edge, the hairline only after a scroll, a press on the line's middle opening nothing, back to the list; at 390 one way back, 44 to the finger with the name on its line, first in the body; both themes");
}

// --- With the switch on: a skill's page ----------------------------------------------------

/** A list scrolled down opens a skill's page at its top, and going back finds the list at the place it was left. */
async function checkPlaces(browser: Browser): Promise<void> {
	for (const [at, options] of [["1440", desktop(1440, 420)], ["390", { ...phone(), viewport: { width: 390, height: 420 } }]] as const) {
		const page = await openSkills(browser, options);
		const place = () => page.locator(".settings-dialog-pane").evaluate((scroller) => Math.round(scroller.scrollTop));
		const row = page.locator(`${SKILLS} .skill-table-row`).last();
		await row.scrollIntoViewIfNeeded();
		const left = await place();
		assert(left > 100, `${at}: the list scrolled down to its last row (${left})`);
		await row.click();
		await page.locator(`${SKILLS} .skill-detail`).waitFor({ timeout: 10000 });
		same(await place(), 0, `${at}: where a skill's page opens, the list at ${left}`);
		await page.locator(".settings-dialog-pane").evaluate((scroller) => { scroller.scrollTop = scroller.scrollHeight; });
		assert(await place() > 100, `${at}: the skill's page is longer than its window (${await place()})`);
		await page.locator(".pane-head-back").click();
		await page.locator(`${SKILLS} .skill-table`).waitFor({ timeout: 10000 });
		same(await place(), left, `${at}: the list's place on going back`);
		await page.context().close();
	}
	console.log("  ok  at 1440 and 390: a skill's page opens at its top from a list scrolled down, and going back finds the list where it was left");
}

async function checkSkillPage(browser: Browser): Promise<void> {
	for (const theme of [LIGHT, DARK] as const) {
		const page = await openSkills(browser, desktop(1440, 900, theme));
		await installTools(page);
		const at = `${theme}, a skill's page`;
		// The identity: a skill marked to start by hand, with its tag.
		await openSkill(page, "press-release");
		const identity = await page.evaluate((skills) => {
			const w = window as any;
			const name = w.__el(`${skills} .skill-detail .pane-head h2`);
			const tag = name.querySelector(".skill-tag").getBoundingClientRect();
			const text = document.createRange();
			text.selectNodeContents(name.firstChild);
			const style = getComputedStyle(name);
			const card = w.__el(`${skills} .skill-detail > .settings-group:not(.skill-update-group) > .settings-rows`).getBoundingClientRect();
			return { type: `${style.fontSize}/${style.lineHeight}`, tag: [Math.round(tag.height), Math.round(tag.left - text.getBoundingClientRect().right)], toCard: Math.round(card.top - w.__el(`${skills} .skill-detail .pane-lead`).getBoundingClientRect().bottom) };
		}, SKILLS);
		same(identity, { type: "18px/24px", tag: [20, 8], toCard: 24 }, `${at}: the name 18/24, its tag 20 tall and 8 after, 24 to the facts`);
		await page.locator(".pane-head-back").click();

		// A line from skill updates under the description (the group itself is theirs): 12 below it.
		await openSkill(page, "weekly-notes");
		const toUpdateLine = await page.evaluate((skills) => {
			const w = window as any;
			return Math.round(w.__el(`${skills} .skill-update-state`).getBoundingClientRect().top - w.__el(`${skills} .skill-detail .pane-lead`).getBoundingClientRect().bottom);
		}, SKILLS);
		same(toUpdateLine, 12, `${at}: skill updates' line 12 under the description`);
		await page.locator(".pane-head-back").click();

		// pdf: facts, the files by kind, the instructions and Delete.
		await openSkill(page, "pdf");
		const facts = await page.evaluate((skills) => [...document.querySelectorAll(`${skills} .settings-row:has(> .skill-fact-value)`)].map((row) => {
			const label = row.querySelector(".settings-row-label")!.getBoundingClientRect();
			const value = row.querySelector(".skill-fact-value")!;
			const box = value.getBoundingClientRect();
			return { name: row.querySelector(".settings-row-label")!.textContent, height: Math.round(row.getBoundingClientRect().height - parseFloat(getComputedStyle(row).borderTopWidth)), lines: Math.round(box.height / 18), x: Math.round(box.left), after: Math.round(box.left - label.left) };
		}), SKILLS);
		same(facts.map((one) => one.name), ["From", "License", "Version", "Added", "Used in", "Files"], `${at}: the facts`);
		same(facts.filter((one) => one.lines === 1 && one.height !== 44).map((one) => `${one.name} ${one.height}`), [], `${at}: one-line facts not 44 tall between their lines`);
		same([...new Set(facts.map((one) => one.x))].length, 1, `${at}: the values' x`);
		same([...new Set(facts.map((one) => one.after))], [172], `${at}: the values after their labels`);
		const kinds = await page.evaluate((skills) => {
			// Inside the card's edge.
			const kindsCard = document.querySelector(`${skills} .skill-file-kinds`)!;
			const inside = kindsCard.getBoundingClientRect().right - parseFloat(getComputedStyle(kindsCard).borderRightWidth);
			return [...document.querySelectorAll(`${skills} .skill-file-kind-head`)].map((head) => ({ name: head.querySelector(".skill-file-kind-name")!.textContent, height: Math.round(head.getBoundingClientRect().height), countEnd: Math.round(inside - head.querySelector(".skill-file-kind-count")!.getBoundingClientRect().right) }));
		}, SKILLS);
		same(kinds, [["Instructions", 1], ["Documents", 3], ["Templates and pictures", 1], ["Scripts", 8]].map(([name]) => ({ name, height: 48, countEnd: 16 })), `${at}: kind rows 48, the count 16 in`);
		const documents = page.locator(`${SKILLS} .skill-file-kind-head`).filter({ hasText: "Documents" });
		const expanded = () => documents.getAttribute("aria-expanded");
		await documents.click();
		same(await expanded(), "true", `${at}: a kind opened by pointer`);
		const names = await page.evaluate((skills) => { const files = [...document.querySelectorAll(`${skills} .skill-file-kind-files`)].find((one) => one.getClientRects().length)!; const style = getComputedStyle(files); return `${style.fontSize}/${style.lineHeight} ${style.fontFamily}`; }, SKILLS);
		same(names, `12px/18px ${await resolved(page, "var(--exx-font-mono)", "font-family")}`, `${at}: file names`);
		await documents.click();
		same(await expanded(), "false", `${at}: a kind closed by pointer`);
		await documents.focus();
		await page.keyboard.press("Enter");
		same(await expanded(), "true", `${at}: a kind opened by keyboard`);
		await page.keyboard.press("Space");
		same(await expanded(), "false", `${at}: a kind closed by keyboard`);
		await page.mouse.move(2, 2);
		await checkStates(page, `${SKILLS} .skill-file-kind-head`, `${at}, a kind row`);
		const row = page.locator(`${SKILLS} .skill-file-kind-head`).nth(1);
		await checkOverFills(page, row, [[".skill-file-kind-count", 4.5], [".skill-file-kind-mark", 3]], `${at}, a kind row`);
		await row.click();
		await page.mouse.move(2, 2);
		same(await page.evaluate((skills) => getComputedStyle(document.querySelector(`${skills} .skill-doc`)!).padding, SKILLS), "16px", `${at}: the Instructions card 16 inside, as every card`);
		// Folded, the words fade and the card keeps its edge: no mask on the card itself.
		const fold = await page.evaluate((skills) => {
			const doc = document.querySelector(`${skills} .skill-doc.folded`);
			if (!doc) return null;
			const style = getComputedStyle(doc);
			return { mask: style.maskImage || style.webkitMaskImage, bottom: style.borderBottomWidth, fade: getComputedStyle(doc, "::after").backgroundImage.startsWith("linear-gradient") };
		}, SKILLS);
		same(fold, { mask: "none", bottom: "1px", fade: true }, `${at}: the folded Instructions card keeps its edge, the words fade`);
		await checkShared(page, SKILLS, theme, at);

		// Delete: 32 tall, soft red, in the last card; its question with Cancel focused and a red-filled Delete.
		const remove = page.locator(`${SKILLS} .skill-detail`).getByRole("button", { name: "Delete", exact: true });
		const soft = await remove.evaluate((one) => {
			const style = getComputedStyle(one);
			const cards = [...document.querySelectorAll(".settings-dialog-pane .settings-rows")];
			return { height: Math.round(one.getBoundingClientRect().height), soft: one.matches(".rs-btn-danger-soft"), words: style.color, fill: (window as any).__painted(style.backgroundColor), last: one.closest(".settings-rows") === cards.at(-1) };
		});
		same(soft, { height: 32, soft: true, words: await resolved(page, "var(--error-text)"), fill: true, last: true }, `${at}: Delete`);
		await remove.click();
		const question = page.locator(".confirm-dialog-backdrop");
		await question.waitFor();
		const asked = await question.evaluate((dialog) => {
			const w = window as any;
			const red = dialog.querySelector(".rs-btn-danger")!;
			const chroma = (hex: string) => { const rgb = [1, 3, 5].map((at) => parseInt(hex.slice(at, at + 2), 16)); return Math.max(...rgb) - Math.min(...rgb); };
			return { focused: document.activeElement?.textContent, red: [red.textContent, chroma(w.__seen(red, getComputedStyle(red).backgroundColor)) > 60] };
		});
		same(asked, { focused: "Cancel", red: ["Delete", true] }, `${at}: Delete's question`);
		await page.keyboard.press("Escape");
		await question.waitFor({ state: "detached" });
		await page.locator(".pane-head-back").click();

		// A skill exxperts doesn't own: Delete at 45 %.
		await openSkill(page, "brand-voice");
		same(await page.locator(`${SKILLS} .skill-detail`).getByRole("button", { name: "Delete", exact: true }).evaluate((one) => [(one as HTMLButtonElement).disabled, getComputedStyle(one).opacity]), [true, "0.45"], `${at}: Delete for a skill exxperts doesn't own`);
		await page.locator(".pane-head-back").click();

		// Files that can't be opened: the red dot, soft words, no Instructions.
		await openSkill(page, "scans");
		await checkDot(page, `${SKILLS} .skill-detail-problem`, "var(--fg-soft)", `${at}, files that can't be opened`);
		same(await page.locator(`${SKILLS} .skill-doc`).count(), 0, `${at}, files that can't be opened: no Instructions`);
		await page.context().close();

		const small = await openSkills(browser, phone(theme));
		await installTools(small);
		await openSkill(small, "pdf");
		// The phone's lead rule lifts a page's lead above its head; a skill's name stays first.
		const nameFirst = await small.evaluate((skills) => {
			const w = window as any;
			return w.__el(`${skills} .skill-detail .pane-lead`).getBoundingClientRect().top >= w.__el(`${skills} .skill-detail .pane-head h2`).getBoundingClientRect().bottom;
		}, SKILLS);
		same(nameFirst, true, `${theme}, 390, a skill's page: the name above its description`);
		// A value that wraps keeps its label on its first line.
		const labels = await small.evaluate((skills) => [...document.querySelectorAll(`${skills} .settings-row:has(> .skill-fact-value)`)].map((row) => {
			const value = row.querySelector(".skill-fact-value")!.getBoundingClientRect();
			return { wraps: value.height > 30, offset: Math.round(row.querySelector(".settings-row-label")!.getBoundingClientRect().top - value.top) };
		}), SKILLS);
		same(labels.some((one) => one.wraps), true, `${theme}, 390, a skill's page: a fact that wraps`);
		same(labels.map((one) => one.offset), labels.map(() => 0), `${theme}, 390, a skill's page: each fact's label on its value's first line`);
		same(await small.evaluate(() => (window as any).__sideways()), false, `${theme}, 390, a skill's page: sideways`);
		await small.context().close();
	}
	console.log("  ok  a skill's page: the name 18/24 with its tag 20 tall and 8 after, 24 to the facts; facts 44 with every value at one x, 172 after its label; kind rows 48 with the count 16 in, opened and closed by pointer and keyboard, names mono 12/18, their hover, press and ring, the count and chevron readable over both fills; skill updates' line 12 under the description; the Instructions card 16 inside, folded with its edge whole and its words faded; Delete 32 tall and soft red in the last card, its question with Cancel focused and a red Delete; 45 % for a skill exxperts doesn't own; files that can't be opened with a red dot and no Instructions; at 390 the name above its description, a wrapped fact's label on its first line, and nothing sideways; both themes");
}

// --- With the switch on: the review ---------------------------------------------------------

/** The review's foot against the pane: its height, its bottom against the pane's, its hairline, its buttons' end against the content's right edge, its buttons' height, and the body's last part against its top. */
const readFoot = (page: Page) => page.evaluate((skills) => {
	const w = window as any;
	const foot = w.__el(".skill-review-actions");
	const box = foot.getBoundingClientRect();
	const buttons = [...foot.querySelectorAll("button")].map((one: Element) => one.getBoundingClientRect());
	const body = [...document.querySelector(`${skills} .skill-review`)!.children].filter((one) => !one.matches(".skill-review-actions") && one.getClientRects().length > 0).at(-1)!;
	return {
		height: Math.round(box.height),
		bottom: Math.round(document.querySelector(".settings-dialog-pane")!.getBoundingClientRect().bottom - box.bottom),
		screen: Math.round(window.innerHeight - box.bottom),
		hairline: w.__painted(getComputedStyle(foot).boxShadow.replace(/ 0px.*$/, "")),
		end: Math.round(buttons.at(-1)!.right - w.__content().right),
		buttons: buttons.map((one: DOMRect) => Math.round(one.height)),
		lastAbove: body.getBoundingClientRect().bottom <= box.top + 0.5,
		top: box.top,
	};
}, SKILLS);

async function checkReview(browser: Browser): Promise<void> {
	for (const theme of [LIGHT, DARK] as const) {
		const page = await openSkills(browser, desktop(1440, 900, theme));
		await installTools(page);
		const at = `${theme}, the review`;
		await upload(page, "quarterly-report", await zipOf("quarterly-report", 8));
		// The order, under the identity: question, scripts message, description, facts, Instructions, Files; the foot last.
		const order = await page.evaluate((skills) => {
			const parts = [...document.querySelector(`${skills} .skill-review`)!.children].filter((one) => one.getClientRects().length > 0);
			const tops = parts.filter((one) => !one.matches(".skill-review-actions")).map((one) => one.getBoundingClientRect().top);
			return { parts: parts.map((one) => one.matches(".skill-review-section") ? one.querySelector(".settings-group-kicker")!.textContent : [...one.classList].find((name) => name.startsWith("skill-review-"))), down: tops.every((top, i) => i === 0 || top > tops[i - 1]) };
		}, SKILLS);
		same(order, { parts: ["skill-review-lead", "skill-review-scripts", "skill-review-field", "skill-review-facts", "Instructions", "Files", "skill-review-actions"], down: true }, `${at}: its parts in order`);
		const message = await page.locator(`${SKILLS} .skill-review-scripts`).evaluate((one) => [one.querySelector(".skill-review-scripts-text")!.textContent, one.querySelector("button")!.textContent]);
		same(message, [`${copy.skillScriptsCount(8)} ${copy.skillFilesLine("run", 8)}`, copy.SHOW_SCRIPTS], `${at}: the scripts message`);
		// Show scripts' words end the strip's 8 and the small button's inset from its right.
		const showInset = await page.locator(`${SKILLS} .skill-review-scripts`).evaluate((strip) => {
			const words = document.createRange();
			words.selectNodeContents(strip.querySelector("button")!);
			return [Math.round(strip.getBoundingClientRect().right - words.getBoundingClientRect().right), 8 + parseFloat(getComputedStyle(strip).getPropertyValue("--exx-btn-inset-sm"))];
		});
		same(showInset[0], showInset[1], `${at}: Show scripts' words the strip's 8 and the small button's inset from its right`);
		// The description: label, field and help 6 apart, the field across the column.
		same(await page.evaluate((skills) => {
			const box = (selector: string) => document.querySelector(`${skills} ${selector}`)!.getBoundingClientRect();
			return [Math.round(box(".skill-review-desc-input").top - box(".skill-review-field-label").bottom), Math.round(box(".skill-field-help").top - box(".skill-review-desc-input").bottom), Math.round(box(".skill-review-desc-input").width)];
		}, SKILLS), [6, 6, 718], `${at}: the description's label, field and help`);
		// The foot, at the top and at the end of the scroll; one ink button on screen, in the foot.
		const top = await readFoot(page);
		same({ ...top, top: 0, lastAbove: true }, { height: 64, bottom: 0, screen: top.screen, hairline: true, end: 0, buttons: [32, 32], lastAbove: true, top: 0 }, `${at}: the foot at the top`);
		same(await page.locator(".skill-review-actions .rs-btn-primary").count(), 1, `${at}: the main button in the foot`);
		await checkShared(page, ".settings-dialog-pane", theme, at);
		await pane(page, 99999);
		const end = await readFoot(page);
		same([end.bottom, end.lastAbove, end.top], [0, true, top.top], `${at}: the foot at the end, the body's last part above it`);
		// Show scripts: Scripts, closed first (it opens on its own), opens, its row under the header and focused.
		const scriptsRow = page.locator(`${SKILLS} .skill-file-kind-head`).filter({ hasText: "Scripts" });
		await scriptsRow.click();
		same(await scriptsRow.getAttribute("aria-expanded"), "false", `${at}: Scripts closed`);
		await pane(page, 0);
		await page.getByRole("button", { name: copy.SHOW_SCRIPTS }).click();
		await settled(page, at);
		const shown = await page.evaluate((skills) => {
			const head = [...document.querySelectorAll(`${skills} .skill-file-kind-head`)].find((one) => one.textContent!.includes("Scripts"))!;
			const box = head.getBoundingClientRect();
			const band = document.querySelector(".settings-dialog-pane")!.getBoundingClientRect().top + 56;
			return { open: head.getAttribute("aria-expanded"), focused: document.activeElement === head, under: box.top >= band - 1, above: box.bottom <= document.querySelector(".skill-review-actions")!.getBoundingClientRect().top };
		}, SKILLS);
		same(shown, { open: "true", focused: true, under: true, above: true }, `${at}: Show scripts`);
		await page.getByRole("button", { name: "Cancel", exact: true }).click();
		await page.locator(`${SKILLS} .skill-table`).waitFor();

		// One script, and none: the message for one, none without.
		await upload(page, "one-script", await zipOf("one-script", 1));
		same(await page.locator(`${SKILLS} .skill-review-scripts-text`).textContent(), `${copy.skillScriptsCount(1)} ${copy.skillFilesLine("run", 1)}`, `${at}: the scripts message for one`);
		await page.getByRole("button", { name: "Cancel", exact: true }).click();
		await upload(page, "no-scripts", await zipOf("no-scripts", 0));
		same(await page.locator(`${SKILLS} .skill-review-scripts`).count(), 0, `${at}: no scripts message without scripts`);
		same(await page.locator(`${SKILLS} .skill-review-outside`).count(), 0, `${at}: no line on files outside its folder when none are named`);
		await page.getByRole("button", { name: "Cancel", exact: true }).click();

		// Instructions that reach above the skill's folder: one line after the scripts message, 12 under it, the path as written set as code.
		const outsidePath = "../../_source-material/brand-guidelines/brand.pdf";
		await upload(page, "reaching", await zipOf("reaching", 2, `Read the brand book in ${outsidePath} first.`));
		const reaching = await page.evaluate((skills) => {
			const parts = [...document.querySelector(`${skills} .skill-review`)!.children].filter((one) => one.getClientRects().length > 0);
			const line = document.querySelector(`${skills} .skill-review-outside`)!;
			return {
				parts: parts.map((one) => one.matches(".skill-review-section") ? one.querySelector(".settings-group-kicker")!.textContent : [...one.classList].find((name) => name.startsWith("skill-review-"))),
				text: line.textContent,
				code: line.querySelector("code")?.textContent,
				gap: Math.round(line.getBoundingClientRect().top - document.querySelector(`${skills} .skill-review-scripts`)!.getBoundingClientRect().bottom),
			};
		}, SKILLS);
		same(reaching, { parts: ["skill-review-lead", "skill-review-scripts", "skill-review-outside", "skill-review-field", "skill-review-facts", "Instructions", "Files", "skill-review-actions"], text: copy.skillOutsideFolderLine(outsidePath), code: outsidePath, gap: 12 }, `${at}: a skill that reaches above its folder`);
		await page.getByRole("button", { name: "Cancel", exact: true }).click();
		// A short path keeps the line to one line: the strip 40 tall, as the scripts message's, with the words in its middle.
		await upload(page, "reaching", await zipOf("reaching", 0, "Read ../a.md first."));
		const short = await page.locator(`${SKILLS} .skill-review-outside`).evaluate((line) => {
			const box = line.getBoundingClientRect();
			const words = line.querySelector("span")!.getBoundingClientRect();
			return { height: Math.round(box.height), even: Math.round(words.top - box.top) === Math.round(box.bottom - words.bottom) };
		});
		same(short, { height: 40, even: true }, `${at}: a short path outside the folder: one line in the middle of the strip's 40`);
		await page.getByRole("button", { name: "Cancel", exact: true }).click();
		// A path long enough to wrap the line: the dot on its first line, the path in the file names' mono a size under the sentence.
		await upload(page, "reaching", await zipOf("reaching", 0, `Read ../../_source-material/${"brand-guidelines-for-every-team/".repeat(6)}brand.pdf first.`));
		const wrappedLine = page.locator(`${SKILLS} .skill-review-outside`);
		const wrapped = {
			...(await wrappedLine.evaluate(outsideLineDot)),
			...(await wrappedLine.evaluate((one) => {
				const code = getComputedStyle(one.querySelector("code")!);
				const mono = getComputedStyle(document.documentElement).getPropertyValue("--exx-font-mono").split(",")[0].trim();
				return { mono: code.fontFamily.split(",")[0].trim() === mono, size: parseFloat(code.fontSize) };
			})),
		};
		same(wrapped, { wraps: true, onFirstLine: true, mono: true, size: 12 }, `${at}: a long path outside the folder: the dot on the line's first line, the path mono 12`);
		await page.getByRole("button", { name: "Cancel", exact: true }).click();

		// A name in the library: its question and Replace.
		await upload(page, "pdf", await zipOf("pdf", 1));
		same([await page.locator(`${SKILLS} .skill-review-lead`).textContent(), await page.locator(".skill-review-actions .rs-btn-primary").textContent()], [copy.replaceSkillQuestion("pdf"), copy.REPLACE_SKILL], `${at}: a name in the library`);
		await page.getByRole("button", { name: "Cancel", exact: true }).click();

		// Hidden characters: the warning is a red-dot message.
		await upload(page, "hidden", await zipOf("hidden", 0, "Read\u200b the\u202e figures."));
		await checkDot(page, `${SKILLS} .skill-review > .skill-review-banner`, "var(--fg)", `${at}, hidden characters`);
		same(await page.locator(`${SKILLS} .skill-review > .skill-review-banner`).evaluate((banner) => Math.round(banner.nextElementSibling!.getBoundingClientRect().top - banner.getBoundingClientRect().bottom)), 12, `${at}, hidden characters: the warning 12 above what follows`);
		await page.getByRole("button", { name: "Cancel", exact: true }).click();

		// From a repository and from Browse featured: the same foot, and Cancel back to their lists.
		await scan(page);
		await reviewFromRepository(page, "board-pack", "on");
		same((await readFoot(page)).bottom, 0, `${at}, from a repository: the foot`);
		same(await page.locator(".settings-dialog .rs-btn-primary").count(), 1, `${at}, from a repository: one ink button`);
		await page.getByRole("button", { name: "Cancel", exact: true }).click();
		await page.locator(`${SKILLS} .skill-import-rows`).waitFor();
		await page.locator(".pane-head-back").click();
		await browse(page);
		await page.getByRole("button", { name: "Review and add board-pack" }).click();
		await page.locator(`${SKILLS} .skill-review`).waitFor({ timeout: 15000 });
		same((await readFoot(page)).bottom, 0, `${at}, from Browse featured: the foot`);
		same(await page.locator(".settings-dialog .rs-btn-primary").count(), 1, `${at}, from Browse featured: one ink button`);
		await page.getByRole("button", { name: "Cancel", exact: true }).click();
		await page.locator(`${SKILLS} .skill-browse-directory`).waitFor();
		await page.context().close();

		// At 390: the foot's buttons 44, and the foot riding up with the keyboard.
		const small = await openSkills(browser, phone(theme));
		await installTools(small);
		await upload(small, "quarterly-report", await zipOf("quarterly-report", 8));
		const resting = await readFoot(small);
		same([resting.buttons, resting.screen], [[44, 44], 0], `${theme}, 390, the review: the foot's buttons and its place`);
		// The scripts message: the sentence takes the strip's width, Show scripts under it with its words on the sentence's edge, the dot on the first line.
		const strip = await small.locator(`${SKILLS} .skill-review-scripts`).evaluate((one) => {
			const box = one.getBoundingClientRect();
			const text = one.querySelector(".skill-review-scripts-text")!.getBoundingClientRect();
			const words = document.createRange();
			words.selectNodeContents(one.querySelector("button")!);
			const show = words.getBoundingClientRect();
			const dot = getComputedStyle(one, "::before");
			const dotTop = parseFloat(dot.marginTop) + parseFloat(getComputedStyle(one).paddingTop);
			const lines = document.createRange();
			lines.selectNodeContents(one.querySelector(".skill-review-scripts-text")!);
			const glyphs = lines.getClientRects();
			const top = Math.round(glyphs[0].top - box.top);
			const near = (gap: number) => Math.abs(gap - top) <= 2;
			return { textToRight: Math.round(box.right - text.right) <= 8, under: show.top >= text.bottom, edge: Math.round(show.left - text.left), dotOnFirstLine: Math.round(dotTop + parseFloat(dot.height) / 2 - (text.top - box.top) - 9), even: [near(show.top - glyphs[glyphs.length - 1].bottom), near(box.bottom - show.bottom)], button: Math.round(one.querySelector("button")!.getBoundingClientRect().height) };
		});
		same(strip, { textToRight: true, under: true, edge: 0, dotOnFirstLine: 0, even: [true, true], button: 44 }, `${theme}, 390, the review: the scripts message's sentence on the strip's width, Show scripts under it as near the sentence and the strip's bottom as the sentence is to its top, 44 tall, the dot on its first line`);
		await small.locator(`${SKILLS} .skill-review-desc-input`).focus();
		await small.evaluate(() => document.documentElement.style.setProperty("--phone-keyboard-lift", "300px"));
		await settled(small, `${theme}, 390, the lift`);
		await small.locator(`${SKILLS} .skill-review-desc-input`).scrollIntoViewIfNeeded();
		const lifted = await readFoot(small);
		const field = (await small.locator(`${SKILLS} .skill-review-desc-input`).boundingBox())!;
		same([Math.abs(lifted.screen - 300) <= 1, field.y + field.height <= lifted.top], [true, true], `${theme}, 390, the review with the keyboard: the foot 300 up (${lifted.screen}), the field above it`);
		await small.evaluate(() => document.documentElement.style.removeProperty("--phone-keyboard-lift"));
		await settled(small, `${theme}, 390, no lift`);
		same((await readFoot(small)).screen, 0, `${theme}, 390, the review without the keyboard: the foot back on the bottom`);
		// A long path outside the folder wraps inside the line, never sideways.
		await small.getByRole("button", { name: "Cancel", exact: true }).click();
		await upload(small, "reaching", await zipOf("reaching", 0, `Read ../../_source-material/${"brand-guidelines-for-every-team/".repeat(4)}brand.pdf first.`));
		same(await small.evaluate(() => (window as any).__sideways()), false, `${theme}, 390, the review of a skill that reaches above its folder: sideways`);
		const outsideDot = await small.locator(`${SKILLS} .skill-review-outside`).evaluate(outsideLineDot);
		same(outsideDot, { wraps: true, onFirstLine: true }, `${theme}, 390, the review of a skill that reaches above its folder: the dot on the line's first line`);
		await small.context().close();
	}
	console.log("  ok  the review: its parts in order; the scripts message for 8 and for 1, none without, Show scripts opening Scripts under the header with the focus; the description's label, field and help 6 apart; the foot 64 tall on the pane's bottom at the top and the end, its hairline, its buttons ending on the content's edge, the body above it, the one ink button in it; a name in the library with its question and Replace; hidden characters a red-dot message; a skill that reaches above its folder with its line after the scripts message, 12 under it, its path as code, and at 390 a long path never sideways with the dot on its first line; from a repository and Browse featured the same foot, Cancel back to their lists; Show scripts' words the strip's 8 and the small button's inset from its right, and at 390 under the sentence, which takes the strip's width with the dot on its first line, its words as near the sentence and the strip's bottom as the sentence is to the top, still 44 tall; at 390 the foot's buttons 44, riding up 300 with the keyboard above the field and back down; both themes");
}

// --- With the switch on: Write it yourself ----------------------------------------------------

async function checkWrite(browser: Browser): Promise<void> {
	for (const theme of [LIGHT, DARK] as const) {
		const page = await openSkills(browser, desktop(1440, 900, theme));
		await installTools(page);
		const at = `${theme}, Write it yourself`;
		await addWay(page, "write");
		const form = `${SKILLS} .skill-write-block`;
		await page.locator(form).waitFor();
		const save = page.getByRole("button", { name: "Save skill" });
		// Save is never greyed for an empty field (one form rule, 44): a press marks the empty ones and puts the caret in the
		// first; with two filled, only the third stays marked; filled, the marks go.
		same(await save.evaluate((one) => [(one as HTMLButtonElement).disabled, getComputedStyle(one).opacity]), [false, "1"], `${at}: Save not greyed before the three are filled`);
		const fields = page.locator(`${form} :is(input, textarea)`);
		const marks = () => fields.evaluateAll((all) => all.map((one) => [one.getAttribute("aria-invalid"), one === document.activeElement]));
		await save.click();
		same(await marks(), [["true", true], ["true", false], ["true", false]], `${at}: Save pressed empty: the three marked, the caret in the first`);
		// The focused one too: the focus alone says nothing of what is wrong.
		same(await redEdges(fields), [true, true, true], `${at}: Save pressed empty: every empty field red, the focused one too`);
		await fields.nth(0).fill("Cite Sources");
		await fields.nth(1).fill("Use when an answer states facts.");
		await save.click();
		same(await marks(), [[null, false], [null, false], ["true", true]], `${at}: Save pressed with two filled: the third marked, the caret in it`);
		same(await redEdges(fields), [false, false, true], `${at}: Save pressed with two filled: the third red though it has the focus`);
		same(await page.locator(`${SKILLS} .skill-detail`).count(), 0, `${at}: Save pressed with two filled saves nothing`);
		await fields.nth(2).fill("Cite the source of every fact.");
		await settled(page, at);
		same(await save.evaluate((one) => [(one as HTMLButtonElement).disabled, getComputedStyle(one).opacity]), [false, "1"], `${at}: Save on with the three filled`);
		const shape = await page.evaluate((form) => {
			const w = window as any;
			const box = (one: Element) => one.getBoundingClientRect();
			const rows = [...document.querySelectorAll(`${form} .connector-form-field`)];
			const gaps = rows.map((row) => { const parts = [...row.children].map(box); return parts.slice(1).map((part, i) => Math.round(part.top - parts[i].bottom)); });
			const content = w.__content();
			const [save, cancel] = [...document.querySelectorAll(`${form} .settings-form-foot button`)];
			const textarea = document.querySelector(`${form} textarea`)!;
			return {
				gaps,
				between: rows.slice(1).map((row, i) => Math.round(box(row).top - box(rows[i]).bottom)),
				widths: [...document.querySelectorAll(`${form} input`)].map((one) => Math.round(box(one).width)),
				instructions: [Math.round(box(textarea).width), Math.round(box(textarea).height)],
				buttons: [save.textContent, cancel.textContent, Math.round(box(save).left - content.left), Math.round(box(cancel).left - box(save).right), cancel.matches(".rs-btn-quiet")],
			};
		}, form);
		// Every field fills the page's column (one form rule, 44).
		same(shape, { gaps: [[6, 6], [6, 6], [6]], between: [20, 20], widths: [718, 718], instructions: [718, 240], buttons: ["Save skill", "Cancel", 0, 8, true] }, `${at}: the form's shape`);
		await save.focus();
		await page.keyboard.press("Tab");
		same(await page.evaluate(() => document.activeElement?.textContent), "Cancel", `${at}: Tab from Save to Cancel`);
		await checkShared(page, ".settings-dialog-pane", theme, at);
		same(await page.locator(`${form} .skill-write-id-hint`).textContent(), "saved as cite-sources", `${at}: the name's saved form`);

		// "!!!" refused: a red edge (the look's rule for a field holding something wrong) and a red-dot line, Save off.
		await fields.nth(0).fill("!!!");
		await fields.nth(0).blur();
		await settled(page, at);
		same(await fields.nth(0).evaluate((one) => [one.getAttribute("aria-invalid"), getComputedStyle(one).borderTopColor]), ["true", await resolved(page, "var(--error)", "border-top-color")], `${at}: a refused name's edge`);
		await fields.nth(0).hover();
		same(await redEdges(fields.nth(0)), [true], `${at}: a refused name's edge under the pointer`);
		await page.mouse.move(5, 5);
		same(await page.locator(`${form} .skill-field-error`).textContent(), copy.SKILL_NAME_REFUSED_LINE, `${at}: a refused name's line`);
		// A field's error reads one way on every form, as Profiles' reason does: a red dot and the text colour (44).
		await checkDot(page, `${form} .skill-field-error`, "var(--fg)", `${at}: a refused name`);
		// Save stays pressable (44's form rule): pressed, it saves nothing and puts the caret back in the refused name.
		same(await save.isDisabled(), false, `${at}: Save not greyed for a refused name`);
		await save.click();
		same([await fields.nth(0).evaluate((one) => one === document.activeElement), await page.locator(`${SKILLS} .skill-detail`).count()], [true, 0], `${at}: Save pressed for a refused name: the caret in it, nothing saved`);
		same(await redEdges(fields.nth(0)), [true], `${at}: Save pressed for a refused name: its edge red with the caret in it`);

		// A refusal from the server: a red-dot message.
		await fields.nth(0).fill("Cite Sources");
		await page.route("**/api/skills", (route) => route.request().method() === "POST" ? route.fulfill({ status: 400, contentType: "application/json", body: JSON.stringify({ error: "That name is taken." }) }) : route.fallback());
		await save.click();
		await page.locator(`${form} .skill-message-failed`).waitFor();
		await checkDot(page, `${form} .skill-message-failed`, "var(--fg)", `${at}: a refusal`);
		await page.unroute("**/api/skills");
		// Saved as today, once.
		if (theme === LIGHT) {
			await save.click();
			await page.locator(`${SKILLS} .skill-table`).waitFor({ timeout: 10000 });
			same((await api("GET", "/api/skills/cite-sources")).status, 200, `${at}: Cite Sources saved as cite-sources`);
			seeded(await api("DELETE", "/api/skills/cite-sources"), "cite-sources removed");
		}
		await page.context().close();

		const small = await openSkills(browser, phone(theme));
		await installTools(small);
		await addWay(small, "write");
		const narrow = await small.evaluate((form) => {
			const w = window as any;
			const content = w.__content();
			return { inputs: [...document.querySelectorAll(`${form} input`)].map((one) => { const box = one.getBoundingClientRect(); return [Math.round(box.width - (content.right - content.left)), Math.round(box.height), getComputedStyle(one).fontSize]; }), textarea: [getComputedStyle(document.querySelector(`${form} textarea`)!).fontSize, getComputedStyle(document.querySelector(`${form} textarea`)!).resize], sideways: w.__sideways() };
		}, form);
		same(narrow, { inputs: [[0, 44, "16px"], [0, 44, "16px"]], textarea: ["16px", "none"], sideways: false }, `${theme}, 390, Write it yourself`);
		await small.context().close();
	}
	console.log("  ok  Write it yourself: label, field and help 6 apart, fields 20 apart; every field the page's column of 718, Instructions 240 tall; Save skill ink on the content's left edge then Cancel quiet 8 after, in that Tab order; Save never greyed, a press marking the empty fields with the caret in the first; Cite Sources saved as cite-sources; \"!!!\" refused with a red edge and a red-dot line, Save then putting the caret back in it; a refusal a red-dot message; at 390 every field the full width, 44 tall, 16 px text, Instructions with no resize grip, nothing sideways; both themes");
}

// --- With the switch on: the upload dialog ---------------------------------------------------

async function checkUpload(browser: Browser): Promise<void> {
	for (const theme of [LIGHT, DARK] as const) {
		const page = await openSkills(browser, desktop(1440, 900, theme));
		await installTools(page);
		const at = `${theme}, the upload dialog`;
		await addWay(page, "upload");
		const dialog = page.locator(".skill-upload-modal");
		await dialog.waitFor();
		const shape = await dialog.evaluate((modal) => {
			const style = getComputedStyle(modal);
			const title = getComputedStyle(modal.querySelector("h3")!);
			const drop = modal.querySelector(".skill-upload-drop")!;
			const lines = [...modal.querySelectorAll(".skill-upload-reqs li")];
			return {
				box: [Math.round(modal.getBoundingClientRect().width), style.borderTopLeftRadius, style.padding],
				title: `${title.fontSize}/${title.lineHeight}/${title.fontWeight}`,
				drop: [Math.round(drop.getBoundingClientRect().height), getComputedStyle(drop).borderTopStyle],
				lines: [lines.length, lines.every((line) => getComputedStyle(line).display !== "list-item" || getComputedStyle(line).listStyleType === "none")],
				apart: Math.round(lines[1].getBoundingClientRect().top - lines[0].getBoundingClientRect().bottom),
				close: Math.round(modal.querySelector(".skill-upload-modal-head svg")!.getBoundingClientRect().right - drop.getBoundingClientRect().right),
			};
		});
		same(shape, { box: [400, "16px", "24px"], title: "18px/24px/700", drop: [120, "dashed"], lines: [2, true], apart: 4, close: 0 }, `${at}: its shape, the requirements 4 apart, the close's mark on the drop area's right edge`);
		const drop = ".skill-upload-overlay .skill-upload-drop";
		const ink = await resolved(page, "var(--exx-action-primary-bg)", "border-top-color");
		const edge = () => page.locator(drop).evaluate((one) => getComputedStyle(one).borderTopColor);
		const hover = await resolved(page, "var(--exx-row-hover)", "background-color");
		await page.locator(drop).hover();
		await settledFill(page, drop, hover, `${at}: the drop area under the pointer`);
		same(await edge(), ink, `${at}: the drop area's ink line under the pointer`);
		await checkOverFills(page, page.locator(drop), [[".skill-upload-drop-label", 4.5], [".skill-upload-drop-glyph", 3]], `${at}: the drop area`);
		await page.mouse.move(2, 2);
		await settled(page, at);
		await settled(page, at);
		// A file dragged over it.
		await page.locator(drop).dispatchEvent("dragover", { dataTransfer: await page.evaluateHandle(() => new DataTransfer()) });
		await settledFill(page, drop, hover, `${at}: the drop area with a file over it`);
		same(await edge(), ink, `${at}: the drop area's ink line with a file over it`);
		await page.locator(drop).dispatchEvent("dragleave");
		await checkShared(page, ".skill-upload-modal", theme, at);
		// The keyboard's ring, whole.
		await page.locator(".skill-upload-modal-head button").focus();
		await page.keyboard.press("Tab");
		const ring = await page.locator(drop).evaluate((one) => {
			const style = getComputedStyle(one);
			const box = one.getBoundingClientRect();
			const modal = one.closest(".skill-upload-modal")!.getBoundingClientRect();
			const out = parseFloat(style.outlineWidth) + parseFloat(style.outlineOffset);
			return { focus: one.matches(":focus-visible"), outline: `${style.outlineStyle} ${style.outlineWidth}`, inside: box.left - out >= modal.left && box.right + out <= modal.right };
		});
		same(ring, { focus: true, outline: "solid 2px", inside: true }, `${at}: the drop area's ring`);
		// Escape closes it, and so does the veil.
		await page.keyboard.press("Escape");
		await dialog.waitFor({ state: "detached" });
		same(await page.locator(".settings-overlay").count(), 1, `${at}: Escape leaves the window open`);
		await addWay(page, "upload");
		await page.mouse.click(4, 4);
		await dialog.waitFor({ state: "detached" });
		same(await page.locator(".settings-overlay").count(), 1, `${at}: the veil leaves the window open`);
		// A file goes to its review.
		await upload(page, "quarterly-report", await zipOf("quarterly-report", 0));
		await page.context().close();

		const small = await openSkills(browser, phone(theme));
		await addWay(small, "upload");
		const sides = await small.locator(".skill-upload-modal").evaluate((modal) => {
			const box = modal.getBoundingClientRect();
			const close = modal.querySelector(".skill-upload-modal-head .rs-btn")!.getBoundingClientRect();
			const mark = modal.querySelector(".skill-upload-modal-head svg")!.getBoundingClientRect();
			return [Math.round(box.left), Math.round(window.innerWidth - box.right), Math.round(close.height), Math.round(mark.right - modal.querySelector(".skill-upload-drop")!.getBoundingClientRect().right), Math.round(modal.querySelector(".skill-upload-modal-head")!.getBoundingClientRect().height)];
		});
		same(sides, [16, 16, 44, 0, 24], `${theme}, 390, the upload dialog 16 from each side, its close 44 tall with its mark on the drop area's right edge, the title's line still 24`);
		await small.context().close();
	}
	console.log("  ok  the upload dialog: 400 wide, radius 16, 24 inside, its title 18/24 at 700; the drop area 120 tall and dashed, its fill and ink line under the pointer and with a file over it, its words and arrow readable over the hover and pressed fills, a whole ring; the close's mark on the drop area's right edge; two requirement lines with no bullet, 4 apart; Escape and the veil close it, the window stays; a file goes to its review; at 390 16 from each side, the close 44 tall with its mark on the same edge and the title's line still 24; both themes");
}

// --- With the switch on: From a repository address -------------------------------------------

async function checkRepository(browser: Browser): Promise<void> {
	for (const theme of [LIGHT, DARK] as const) {
		const page = await openSkills(browser, desktop(1440, 900, theme));
		await installTools(page);
		const at = `${theme}, From a repository address`;
		await addWay(page, "repository");
		const scanButton = () => page.locator(`${SKILLS} .skill-import-row button`);
		// Scan is never greyed for an empty field (one form rule, 44): a press marks it and puts the caret in it.
		const address = page.locator(`${SKILLS} .skill-import-url`);
		same(await scanButton().evaluate((one) => [(one as HTMLButtonElement).disabled, getComputedStyle(one).opacity]), [false, "1"], `${at}: Scan not greyed while the field is empty`);
		await scanButton().click();
		same(await address.evaluate((one) => [one.getAttribute("aria-invalid"), one === document.activeElement]), ["true", true], `${at}: Scan pressed empty: the field marked, the caret in it`);
		same(await redEdges(address), [true], `${at}: Scan pressed empty: the field's edge red`);
		await address.fill("  ");
		same(await redEdges(address), [true], `${at}: only spaces typed: the edge still red`);
		await address.fill(team);
		same(await address.getAttribute("aria-invalid"), null, `${at}: an address typed: the mark gone`);
		const before = await page.evaluate((skills) => {
			const field = document.querySelector(`${skills} .skill-import-url`)!.getBoundingClientRect();
			const scan = document.querySelector(`${skills} .skill-import-row button`)!.getBoundingClientRect();
			return [Math.round(scan.right - field.left), Math.round(field.height), Math.round(scan.left - field.right)];
		}, SKILLS);
		// The field and Scan share the page's column (one form rule, 44).
		same(before, [718, 32, 8], `${at}: the field and Scan the column's 718, the field 32 tall, Scan 8 after`);
		same(await scanButton().evaluate((one) => one.matches(".rs-btn-primary")), true, `${at}: Scan ink before a scan`);
		await checkShared(page, ".settings-dialog-pane", theme, `${at}, before a scan`);
		await button(page, "Scan").click();
		await page.locator(`${SKILLS} .skill-import-rows`).waitFor({ timeout: 30000 });
		await answered(page, `${at}: the scan`);
		same(await scanButton().evaluate((one) => one.matches(".rs-btn-primary")), false, `${at}: Scan secondary after a scan`);
		const found = await page.evaluate((skills) => {
			const rows = [...document.querySelectorAll(`${skills} .skill-import-rows > .skill-import-option`)];
			const card = document.querySelector(`${skills} .skill-import-rows`)!.getBoundingClientRect();
			return {
				title: Math.round(card.top - document.querySelector(`${skills} .skill-import-found-count`)!.getBoundingClientRect().bottom),
				heights: [...new Set(rows.filter((row) => !row.querySelector(".skill-import-too-big")).map((row) => Math.round(row.getBoundingClientRect().height)))],
				chevrons: [...new Set([...document.querySelectorAll(`${skills} .skill-import-chevron`)].map((one) => Math.round(one.getBoundingClientRect().left)))].length,
			};
		}, SKILLS);
		same(found, { title: 8, heights: [64], chevrons: 1 }, `${at}: the found title 8 above its card, rows 64, chevrons at one x`);
		// The skill too big: its red dot and whole reason, no chevron, opening nothing.
		const tooBig = page.locator(`${SKILLS} .skill-import-option`).filter({ hasText: "too-many" });
		same(await tooBig.evaluate((row) => { const reason = row.querySelector(".skill-import-too-big")!; return [row.tagName, Boolean(row.querySelector(".skill-import-chevron")), reason.scrollWidth <= reason.clientWidth, reason.textContent]; }), ["DIV", false, true, copy.skillTooBigLine({ files: 2002 })], `${at}: the skill too big`);
		await checkDot(page, `${SKILLS} .skill-import-too-big`, "var(--fg-soft)", `${at}: the skill too big`);
		await tooBig.click();
		same(await page.locator(`${SKILLS} .skill-review`).count(), 0, `${at}: the skill too big opens nothing`);
		await checkStates(page, `${SKILLS} button.skill-import-option`, `${at}, a found row`);
		await checkOverFills(page, page.locator(`${SKILLS} button.skill-import-option`).first(), [[".skill-import-option-desc", 4.5], [".skill-import-chevron", 3]], `${at}, a found row`);
		await page.mouse.move(2, 2);
		await page.locator(`${SKILLS} .skill-review`).waitFor({ timeout: 15000 });
		// A review that shows the skill's description: the question under it, at a phone's width too.
		for (const width of [390, 1440]) {
			await page.setViewportSize({ width, height: 900 });
			same(await page.evaluate(() => { const w = window as any; return Math.round(w.__el(".skill-review-lead").getBoundingClientRect().top - w.__el(".skill-review .pane-lead").getBoundingClientRect().bottom); }), 16, `${at}, a review at ${width}: the question 16 under the description`);
		}
		await page.getByRole("button", { name: "Cancel", exact: true }).click();
		await page.locator(`${SKILLS} .skill-import-found`).waitFor();
		await checkShared(page, ".settings-dialog-pane", theme, `${at}, after a scan`);
		// A row opens its review; Cancel comes back; Add to library adds it and the row says Added, opening nothing.
		if (theme === LIGHT) {
			await reviewFromRepository(page, "board-pack", "on");
			await page.getByRole("button", { name: "Cancel", exact: true }).click();
			await page.locator(`${SKILLS} .skill-import-rows`).waitFor();
			await reviewFromRepository(page, "board-pack", "on");
			await page.locator(".skill-review-actions").getByRole("button", { name: copy.ADD_TO_LIBRARY }).click();
			const added = page.locator(`${SKILLS} .skill-import-option`).filter({ hasText: "board-pack" });
			await waitUntil(async () => (await added.count()) === 1 && (await added.textContent())!.includes("Added"), `${at}: board-pack added`, 15000);
			same(await added.evaluate((row) => [row.tagName, Boolean(row.querySelector(".skill-import-chevron"))]), ["DIV", false], `${at}: an added row opens nothing`);
			same((await api("GET", "/api/skills/board-pack")).status, 200, `${at}: board-pack in the library`);
			seeded(await api("DELETE", "/api/skills/board-pack"), "board-pack removed");
		}
		// A failed scan: a red-dot message.
		await page.locator(`${SKILLS} .skill-import-url`).fill(path.join(repos, "missing"));
		await button(page, "Scan").click();
		await page.locator(`${SKILLS} .skill-import-from-repo > .skill-message-failed`).waitFor({ timeout: 30000 });
		await checkDot(page, `${SKILLS} .skill-import-from-repo > .skill-message-failed`, "var(--fg)", `${at}: a failed scan`);
		// A repository that needs a sign-in: its way on, and the way without git on a line of its own.
		const signIn = "This computer has no sign-in for gitlab.example.com, or the address is wrong. Sign in there with git in a terminal, then try again.";
		await page.route("**/api/skills/repo/scan", (route) => route.fulfill({ status: 502, json: { error: copy.repositoryFailedLine({ reason: "sign-in", message: signIn, host: "gitlab.example.com" }, undefined, "pasted") } }));
		await page.locator(`${SKILLS} .skill-import-url`).fill("https://gitlab.example.com/team/skills");
		await button(page, "Scan").click();
		const needsSignIn = page.locator(`${SKILLS} .skill-import-from-repo > .skill-message-failed`).filter({ hasText: "no sign-in" });
		await needsSignIn.waitFor({ timeout: 15000 });
		same((await needsSignIn.innerText()).split("\n"), [signIn, "Or download the skill's folder as a zip and use Upload a file."], `${at}: a repository that needs a sign-in, its two lines`);
		await page.context().close();

		const small = await openSkills(browser, phone(theme));
		await installTools(small);
		await scan(small);
		same(await small.evaluate(() => (window as any).__sideways()), false, `${theme}, 390, From a repository address: sideways`);
		// A phone has no tip: each description shows whole; the too-big reason's lines start at one x and take the row's width.
		const phoneRows = await small.evaluate(() => {
			const cut = [...document.querySelectorAll(".skill-import-option-desc:not(.skill-import-too-big)")].filter((one) => one.scrollWidth > one.clientWidth || one.scrollHeight > one.clientHeight).map((one) => one.textContent);
			const reason = document.querySelector(".skill-import-too-big")!;
			const range = document.createRange();
			range.selectNodeContents([...reason.childNodes].find((node) => node.nodeType === Node.TEXT_NODE)!);
			const lines = [...range.getClientRects()];
			const row = reason.closest(".skill-import-option")!.getBoundingClientRect();
			return { cut, lines: new Set(lines.map((one) => Math.round(one.top))).size > 1, lefts: new Set(lines.map((one) => Math.round(one.left))).size, right: Math.round(row.right - 8 - reason.getBoundingClientRect().right) };
		});
		same(phoneRows, { cut: [], lines: true, lefts: 1, right: 0 }, `${theme}, 390, From a repository address: descriptions whole, the too-big reason's lines at one x and to the row's edge`);
		await small.context().close();
	}
	console.log("  ok  From a repository address: the field and Scan the column's 718, Scan 8 after, ink before a scan and secondary after; the found title 8 above its card, rows 64 with chevrons at one x, their hover, press and ring, the description and chevron readable over both fills; a row opens its review, Cancel comes back, Add to library adds it and the row says Added and opens nothing; the skill too big with its red dot and whole reason, no chevron, opening nothing; a failed scan a red-dot message; at 390 nothing sideways, every description whole, the too-big reason's lines at one x and to the row's edge; both themes");
}

// --- With the switch on: Browse featured ------------------------------------------------------

async function checkBrowse(browser: Browser): Promise<void> {
	for (const theme of [LIGHT, DARK] as const) {
		const page = await openSkills(browser, desktop(1440, 900, theme));
		await installTools(page);
		const at = `${theme}, Browse featured`;
		await browse(page);
		const read = await page.evaluate(({ skills, tooBigLine }) => {
			const groups = [...document.querySelectorAll(`${skills} .skill-browse-directory > .settings-group`)];
			const rows = [...document.querySelectorAll(`${skills} .skill-browse-row`)];
			return {
				titles: groups.map((group) => { const card = group.querySelector(".settings-rows"); return card && card.getClientRects().length ? Math.round(card.getBoundingClientRect().top - group.querySelector(".group-head")!.getBoundingClientRect().bottom) : "no card"; }),
				// The too-big reason shows whole, as in the scan's list, so its row may take a second line.
				heights: [...new Set(rows.filter((row) => !row.textContent!.includes(tooBigLine)).map((row) => Math.round(row.getBoundingClientRect().height - parseFloat(getComputedStyle(row).borderTopWidth))))],
				add: [...new Set([...document.querySelectorAll(`${skills} .skill-browse-add button`)].map((one) => Math.round(one.getBoundingClientRect().height)))],
				// The licence beside the name, 8 after it on its line, or after the cut of one too long: no words between the description and Add.
				licence: [...new Set(rows.map((row) => {
					const label = row.querySelector(".settings-row-label")!;
					const words = document.createRange();
					words.selectNodeContents(label);
					const [name, licence] = [words.getBoundingClientRect(), row.querySelector(".skill-browse-license")!.getBoundingClientRect()];
					return `${Math.round(licence.left - Math.min(name.right, label.getBoundingClientRect().right))} after, ${licence.top >= name.top - 4 && licence.bottom <= name.bottom + 4 ? "on its line" : "off its line"}`;
				}))],
				adds: [...new Set(rows.map((row) => Math.round(row.querySelector(".skill-browse-add")!.getBoundingClientRect().right)))].length,
			};
		}, { skills: SKILLS, tooBigLine: copy.skillTooBigLine({ files: 2002 }) });
		same(read, { titles: [8, "no card"], heights: [64], add: [28], licence: ["8 after, on its line"], adds: 1 }, `${at}: each source's title 8 above its card, rows 64, Add 28 tall at one x, the licence beside the name`);
		// The skill too big says why, whole, and offers no Add.
		const browseTooBig = page.locator(`${SKILLS} .skill-browse-row`).filter({ hasText: "too-many" });
		same([await browseTooBig.locator(".settings-row-sub").first().textContent(), await browseTooBig.getByRole("button").count()], [copy.skillTooBigLine({ files: 2002 }), 0], `${at}: the skill too big`);
		// The column cuts a long licence with "…": its whole line is the tip.
		same(await page.locator(`${SKILLS} .skill-browse-license`).evaluateAll((cells) => cells.filter((cell) => cell.getAttribute("title") !== cell.textContent).map((cell) => cell.textContent)), [], `${at}: each licence's whole line in its tip`);
		await checkDot(page, `${SKILLS} .skill-browse-source-warn`, "var(--fg)", `${at}: a failed source`);
		await checkShared(page, ".settings-dialog-pane", theme, at);
		// Add opens the review; Added follows.
		if (theme === LIGHT) {
			await page.getByRole("button", { name: "Review and add minutes" }).click();
			await page.locator(`${SKILLS} .skill-review`).waitFor({ timeout: 15000 });
			await page.locator(".skill-review-actions").getByRole("button", { name: copy.ADD_TO_LIBRARY }).click();
			await page.locator(`${SKILLS} .skill-browse-add .settings-row-value[aria-label="minutes imported"]`).waitFor({ timeout: 15000 });
			seeded(await api("DELETE", "/api/skills/minutes"), "minutes removed");
		}
		await page.locator(".pane-head-back").click();
		// Two skills of one name: each row has its folder's line too, and its Add stays in the row's middle.
		await page.route("**/api/skills/featured", async (route) => {
			const answer = await route.fetch();
			const body = await answer.json();
			for (const source of body.sources) {
				const minutes = source.skills.find((skill: { name: string }) => skill.name === "minutes");
				if (minutes) source.skills.push({ ...minutes, path: "other/minutes" });
			}
			await route.fulfill({ response: answer, json: body });
		});
		await browse(page);
		const twins = await page.locator(`${SKILLS} .skill-browse-row`).filter({ hasText: "other/minutes" }).evaluateAll((rows) => rows.map((row) => {
			const middle = (box: DOMRect) => (box.top + box.bottom) / 2;
			return { lines: row.querySelectorAll(".settings-row-sub").length, middle: Math.abs(Math.round(middle(row.querySelector("button")!.getBoundingClientRect()) - middle(row.getBoundingClientRect()))) <= 1 };
		}));
		same(twins, [{ lines: 2, middle: true }], `${at}: two skills of one name: the folder's line and Add in the row's middle`);
		await page.unroute("**/api/skills/featured");
		await page.locator(".pane-head-back").click();
		// A failed load: a red-dot message with Retry.
		await page.route("**/api/skills/featured", (route) => route.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ error: "Couldn't load the featured sources." }) }));
		await addWay(page, "featured");
		await page.locator(`${SKILLS} .skill-browse-retry .skill-message-failed`).waitFor({ timeout: 15000 });
		await checkDot(page, `${SKILLS} .skill-browse-retry .skill-message-failed`, "var(--fg)", `${at}: a failed load`);
		same(await page.locator(`${SKILLS} .skill-browse-retry button`).textContent(), "Retry", `${at}: a failed load's Retry`);
		same(await page.locator(`${SKILLS} .skill-browse-retry button`).evaluate((one) => { const range = document.createRange(); range.selectNodeContents(one); return Math.round(one.getBoundingClientRect().width - range.getBoundingClientRect().width) <= 22; }), true, `${at}: Retry as wide as its word and the small button's 10 each side`);
		await page.unroute("**/api/skills/featured");
		await page.context().close();

		const small = await openSkills(browser, phone(theme));
		await installTools(small);
		await browse(small);
		same(await small.evaluate(() => (window as any).__sideways()), false, `${theme}, 390, Browse featured: sideways`);
		// A phone has no tip: each description shows whole, the licence 2 under it.
		const rows = await small.evaluate(() => {
			const descriptions = [...document.querySelectorAll(".skill-browse-row .settings-row-clamp")];
			return {
				cut: descriptions.filter((one) => one.scrollWidth > one.clientWidth || one.scrollHeight > one.clientHeight).map((one) => one.textContent),
				gaps: [...new Set(descriptions.map((one) => Math.round(one.closest(".skill-browse-row")!.querySelector(".skill-browse-license")!.getBoundingClientRect().top - one.getBoundingClientRect().bottom)))],
			};
		});
		same(rows, { cut: [], gaps: [2] }, `${theme}, 390, Browse featured: descriptions whole, the licence 2 under each`);
		await small.context().close();
	}
	console.log("  ok  Browse featured: each source's title and help 8 above its card; rows 64, Add 28 tall at one x, the licence 8 after the name with its whole line in its tip; Add opens the review, Added follows; a failed source a red-dot message with no card; a failed load a red-dot message with Retry as wide as its word; at 390 nothing sideways, every description whole with its licence 2 under it; both themes");
}

// --- With the switch on: every width -------------------------------------------------

/** 760 is the phone's last width and 761 the desktop's first. */
const WIDTHS = [1440, 1024, 761, 760, 390];

/** Every screen this task lays out, its window and any dialog over it, at each width from 1440 to 390: nothing scrolls sideways and nothing reaches past the screen's sides. */
async function checkWidths(browser: Browser): Promise<void> {
	const overflow = (page: Page) => page.evaluate(() => {
		const pane = document.querySelector(".settings-dialog-pane")!;
		const boxes = [".settings-dialog", ".skill-upload-modal", ".confirm-dialog-backdrop .maintain-confirm-card"]
			.flatMap((selector) => [...document.querySelectorAll(selector)].filter((one) => one.getClientRects().length).map((one) => [selector, one.getBoundingClientRect()] as const))
			.filter(([, box]) => box.left < 0 || box.right > window.innerWidth).map(([selector]) => selector);
		return [...(pane.scrollWidth > pane.clientWidth ? [`the pane ${pane.scrollWidth} in ${pane.clientWidth}`] : []), ...(document.documentElement.scrollWidth > window.innerWidth ? [`the page ${document.documentElement.scrollWidth} in ${window.innerWidth}`] : []), ...boxes];
	});
	const read: Record<string, string[]> = {};
	for (const scene of SCENES) {
		const page = await openSkills(browser, desktop(1440, 900, LIGHT));
		await scene.open(page, "on");
		for (const width of WIDTHS) {
			await page.setViewportSize({ width, height: 844 });
			await settled(page, `${scene.label}, ${width}`);
			const found = await overflow(page);
			if (found.length) read[`${scene.label}, ${width}`] = found;
		}
		if (scene === SCENES[0]) {
			// The row's own probe: a line wider than the pane is found.
			await page.evaluate(() => { const wide = document.createElement("div"); wide.id = "probe-wide"; wide.style.width = "2000px"; wide.style.height = "1px"; document.querySelector(".settings-dialog-pane .skills-page")!.append(wide); });
			same((await overflow(page)).length > 0, true, "the widths row's own probe: a line 2000 wide is found");
		}
		await page.context().close();
	}
	same(read, {}, "the task's screens that scroll sideways or reach past the screen");
	console.log(`  ok  every width: ${SCENES.length} screens at ${WIDTHS.join(", ")} px, their pane and the page as wide as the screen, the window and any dialog inside it; light`);
}

// --- With the switch on: skill updates' parts on a skill's page ----------------------

/** A keyboard ring is whole when no box that clips it cuts it. */
async function ringCut(control: Locator): Promise<{ focused: boolean; outline: string; cut: string[] }> {
	return control.evaluate((one) => {
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
}

/** With the switch on, the parts skill updates add to a skill's page (its group with an update waiting, Update automatically and its line) keep their own look and move none of this page's: nothing sideways at 1440, 1024, 760 or 390, the facts, files, Instructions and Delete at the size and x they have without them, the switch's and Update's keyboard rings whole. It changes the library, so it runs last. */
async function checkUpdatePartsOn(browser: Browser): Promise<void> {
	const widths = [["1440", desktop(1440, 900, LIGHT)], ["1024", desktop(1024, 800, LIGHT)], ["760", desktop(760, 900, LIGHT)], ["390", phone(LIGHT)]] as const;
	const shape = (page: Page) => page.evaluate(() => {
		const pane = document.querySelector(".settings-dialog-pane")!;
		const detail = pane.querySelector(".skill-detail")!;
		const ours = (one: Element) => !one.closest(".skill-update-group, .skill-auto-update");
		const sections = [...detail.querySelectorAll(":scope > .settings-group")].filter(ours).map((one) => { const box = one.getBoundingClientRect(); return [Math.round(box.left), Math.round(box.width), Math.round(box.height)]; });
		const facts = [...detail.querySelectorAll(".settings-row:has(> .skill-fact-value)")].filter(ours).map((row) => [Math.round(row.getBoundingClientRect().height), Math.round(row.querySelector(".skill-fact-value")!.getBoundingClientRect().left)]);
		return { sideways: pane.scrollWidth > pane.clientWidth || document.documentElement.scrollWidth > window.innerWidth, sections, facts };
	});
	const open = async (options: BrowserContextOptions, name: string) => { const page = await openSkills(browser, options); await openSkill(page, name); return page; };
	const without: Record<string, Awaited<ReturnType<typeof shape>>> = {};
	for (const [width, options] of widths) for (const name of ["pdf", "internal-comms"]) {
		const page = await open(options, name);
		without[`${name}, ${width}`] = await shape(page);
		await page.context().close();
	}
	// pdf's next version waits, with a hidden character in its description; internal-comms updates automatically.
	writeSkill(path.join(team, "skills"), "pdf", "Read, fill in, combine and split​ PDF files.", `${PDF_BODY}\n\nOne more step.`, 'license: Apache-2.0\nversion: "1.3.0"\n');
	git(team, ["add", "-A"]);
	git(team, ["commit", "-q", "-m", "second"]);
	seeded(await api("POST", "/api/skills/updates/check", { names: ["pdf"] }), "a check that finds pdf's next version");
	seeded(await api("PUT", "/api/skills/internal-comms/auto-update", { on: true }), "internal-comms updates automatically");
	for (const [width, options] of widths) {
		for (const [name, what, control] of [
			["pdf", "Update anyway", (page: Page) => page.locator(`${SKILLS} .skill-update-group`).getByRole("button", { name: copy.UPDATE_SKILL_ANYWAY, exact: true })],
			["internal-comms", "Update automatically", (page: Page) => page.locator(`${SKILLS} .skill-auto-update`).getByRole("switch", { name: copy.AUTO_UPDATE_LABEL })],
		] as const) {
			const at = `switch on, ${name}'s page with ${what}, ${width}`;
			const page = await open(options, name);
			await control(page).waitFor({ timeout: 10000 });
			if (name === "internal-comms") same(await control(page).isChecked(), true, `${at}: the switch is on`);
			same(await shape(page), { ...without[`${name}, ${width}`], sideways: false }, `${at}: the page's own sections, facts and width`);
			await control(page).focus();
			await page.keyboard.press("Shift+Tab");
			await page.keyboard.press("Tab");
			same(await ringCut(control(page)), { focused: true, outline: "solid", cut: [] }, `${at}: its keyboard ring`);
			await page.context().close();
		}
	}
	console.log("  ok  switch on: skill updates' group with an update waiting and Update automatically, on, keep their own look and move nothing: at 1440, 1024, 760 and 390 nothing sideways, the page's sections and facts at the size and x they have without them, Update anyway's and the switch's rings whole");
}

let server: ChildProcessWithoutNullStreams | null = null;
try {
	// A team's repository: pdf with a licence, a version, documents, a template and eight scripts; board-pack with one script; a skill too big.
	fs.mkdirSync(path.join(team, "skills"), { recursive: true });
	git(team, ["init", "-q", "-b", "main"]);
	writeSkill(path.join(team, "skills"), "pdf", DESCRIPTIONS.pdf, PDF_BODY, 'license: Apache-2.0\nversion: "1.2.0"\n', { "forms.md": "f", "reference.md": "r", "guide.md": "g", "templates/cover.docx": "c", ...PDF_SCRIPTS });
	writeSkill(path.join(team, "skills"), "board-pack", DESCRIPTIONS["board-pack"], "Board pack instructions.", "license: MIT\n", { "scripts/collect.py": "print(1)\n" });
	writeSkill(path.join(team, "skills"), "internal-comms", DESCRIPTIONS["internal-comms"]);
	writeSkill(path.join(team, "skills"), "minutes", "Write the minutes of a meeting from its notes.", "Minutes.", "license: MIT\n");
	// A name as long as a name may be, with no space to wrap at.
	writeSkill(path.join(team, "skills"), LONG_NAME, "A skill with the longest name.", "Long.");
	writeSkill(path.join(team, "skills"), "too-many", DESCRIPTIONS["too-many"], "Too many.", "", Object.fromEntries(Array.from({ length: 2001 }, (_, i) => [`docs/n${i}.md`, "x"])));
	git(team, ["add", "-A"]);
	git(team, ["commit", "-q", "-m", "first"]);
	server = spawn("npx", ["tsx", "src/index.ts"], {
		shell: process.platform === "win32",
		...SMOKE_SERVER_SPAWN_TREE_OPTIONS,
		cwd: webServerDir,
		env: smokeHomeEnv(tempHome, {
			PORT: String(port), ...SMOKE_SERVER_AUTH_ENV, EXXETA_HOME: repoRoot, EXXETA_SKILLS_ALLOW_LOCAL_REPO: "1",
			// Browse featured's sources: the team's repository and one that is not there.
			EXXPERTS_SKILLS_FEATURED_SOURCES: JSON.stringify([{ source: team, author: "team" }, { source: path.join(repos, "missing"), author: "nobody" }]),
		}) as NodeJS.ProcessEnv,
		stdio: ["ignore", "pipe", "pipe"],
	}) as unknown as ChildProcessWithoutNullStreams;
	await waitForServer(server, baseUrl, { tries: 100 });
	const found = await api("POST", "/api/skills/repo/scan", { source: team });
	seeded(found, "the team's scan");
	for (const name of ["pdf", "internal-comms"]) seeded(await api("POST", "/api/skills/repo/import", { token: found.body.token, path: `skills/${name}` }), name);
	seeded(await api("POST", "/api/skills", { id: "meeting-notes", displayName: "meeting-notes", description: "Turn a meeting transcript into notes.", instructions: "Notes." }), "meeting-notes");
	// A skill its author marked to start only by hand, and one whose files can't be opened (a SKILL.md that shares its file with another name), straight into the store.
	for (const [name, description, extra] of [["press-release", "Draft a press release from a few key facts.", "disable-model-invocation: true\n"], ["scans", "Sort scanned letters.", ""]] as const) {
		const manifest = writeSkill(store, name, description, `The ${name} instructions.`, extra);
		fs.writeFileSync(path.join(store, name, "provenance.json"), JSON.stringify({ source: "local", importedAt: new Date().toISOString(), license: null, sha256: createHash("sha256").update(manifest).digest("hex") }));
	}
	fs.linkSync(path.join(store, "scans", "SKILL.md"), path.join(store, "scans", "elsewhere.md"));
	// A skill from a web address with no recorded commit, so its page shows skill updates' "isn't known" line.
	const weekly = writeSkill(store, "weekly-notes", "Write the week's notes from the team's updates.");
	fs.writeFileSync(path.join(store, "weekly-notes", "provenance.json"), JSON.stringify({ source: "https://github.com/acme/team-skills", importedAt: new Date().toISOString(), license: null, sha256: createHash("sha256").update(weekly).digest("hex") }));
	// A skill another tool manages, which exxperts can't delete.
	writeSkill(path.join(tempHome, ".agents", "skills"), "brand-voice", "Writes in the company's voice.");
	for (const displayName of ROOMS) seeded(await api("POST", "/api/persistent-agents", { displayName, userName: "Synthetic User", preferredUserAddress: "Synthetic User" }), displayName);
	const rooms = (await api("GET", "/api/persistent-agents")).body;
	for (const one of rooms.agents ?? rooms) seeded(await api("PUT", `/api/persistent-agents/${encodeURIComponent(one.id)}/skill-settings`, { action: "enable", name: "pdf" }), "pdf on");
	seeded(await api("POST", "/api/mcp/servers", { name: "notes-server", url: "http://127.0.0.1:9/mcp" }), "a connector");
	// What's new already seen: its note would open on the home page, and closing it sends a request of its own while these pages load.
	seeded(await api("POST", "/api/whats-new/seen"), "what's new seen");

	const browser = await chromium.launch({ ignoreDefaultArgs: ["--hide-scrollbars"] });
	try {
		await checkOff(browser);
		if (process.env.SKILL_PAGES_LOOK_OFF_DUMP) {
			// It leaves pdf's next version waiting in the team's repository, for the update group read with the switch on.
			await readOffUpdates(browser);
			await readOnNeighbours(browser);
		} else {
			await checkRulesUnderSwitch(browser);
			await checkNeighbours(browser);
			// Before the rows that add skills, so every screen opens as the switch-off reader's did.
			await checkWidths(browser);
			await checkSubPageHeader(browser);
			await checkPlaces(browser);
			await checkSkillPage(browser);
			await checkReview(browser);
			await checkWrite(browser);
			await checkUpload(browser);
			await checkRepository(browser);
			await checkBrowse(browser);
			await checkUpdatePartsOn(browser);
		}
	} finally {
		await browser.close();
		if (process.env.SKILL_PAGES_LOOK_OFF_DUMP) fs.writeFileSync(process.env.SKILL_PAGES_LOOK_OFF_DUMP, `${JSON.stringify(offDump, null, 1)}\n`);
	}
	console.log(process.env.SKILL_PAGES_LOOK_OFF_DUMP ? `settings look skill pages ui smoke: the switch-off reader wrote ${process.env.SKILL_PAGES_LOOK_OFF_DUMP}` : "settings look skill pages ui smoke passed");
} finally {
	await stopSmokeServer(server);
	fs.rmSync(tempRoot, { recursive: true, force: true });
}
