// The settings windows' text widths and the room's name. On every page of both
// windows at 1440 the lead ends on its boxes' right edge, no running text is
// cut at a width of its own, and a form stays narrower than the page (Scheduled
// tasks'); on a skill's own page the description ends on the cards' edge and
// the Instructions on their card's padding. Every switch ends on its box's
// padding, the same on every page, at 1440 and 390, and the chevron at the end
// of a Skills row has the size and the place of a Connectors row's.
// By touch on a wide screen a page inside a page keeps its title line.
// The room's name: no word Rename; a pencil hidden at rest, shown on hover and
// to the keyboard's focus, and always without a pointer, 44 to a finger; a
// click on the name, the pencil and the keyboard start the same editing, whose
// field has a line of its own; a name that is refused says so under Save and
// Cancel, over nothing, and the list moves down.
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, type Browser, type Locator, type Page } from "playwright";
import { authedFetch, SMOKE_SERVER_AUTH_ENV, SMOKE_SERVER_SPAWN_TREE_OPTIONS, smokeHomeEnv, stopSmokeServer, freePort, waitForServer } from "./smoke-server-process.js";
import { waitEvery } from "./smoke-wait.js";
import { answered, assert, closeWindow, DARK, desktop, goToPage, isPhone, LIGHT, lookPages, phone, same } from "./settings-look-smoke-parts.js";

const waitUntil = waitEvery(100);

{
	const p = typeof chromium?.executablePath === "function" ? chromium.executablePath() : "";
	if (!p || !fs.existsSync(p)) {
		console.log("settings look top ui smoke skipped (Chromium not installed)");
		process.exit(0);
	}
}

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const webServerDir = path.resolve(scriptDir, "..");
const repoRoot = path.resolve(webServerDir, "..", "..");
const port = await freePort();
const baseUrl = `http://127.0.0.1:${port}`;

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "exxperts-settings-look-top-"));
const tempHome = path.join(tempRoot, "home");
const agentsRoot = path.join(tempHome, ".exxperts", "app", "personalized-agents");
const agentDir = path.join(tempHome, ".exxperts", "agent");
for (const dir of [agentsRoot, agentDir]) fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
process.env.HOME = tempHome;
process.env.USERPROFILE = tempHome;
process.env.EXXPERTS_CODING_AGENT_DIR = agentDir;
process.env.EXXETA_PERSISTENT_AGENTS_ROOT = agentsRoot;

const ROOM = "Client offers and board papers";
const OTHER_ROOM = "Board papers";
const LONG_HELP = "Every figure in an offer comes with the source it was taken from and the day it was read, so that a reader who opens the paper months later can still tell which report it belonged to and whether a newer one has come out since.";
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

/** How a page's words stand in its width: where its boxes end, where its lead does, what is narrower than they are. */
async function readWidths(page: Page) {
	return page.evaluate(() => {
		const pane = document.querySelector(".settings-look-next .settings-dialog-pane")!;
		const shown = (element: Element) => element.getClientRects().length > 0;
		const own = (element: Element) => [...element.childNodes].some((node) => node.nodeType === Node.TEXT_NODE && node.textContent!.trim() !== "");
		const box = [...pane.querySelectorAll(".settings-rows, .ai-profile-card, .room-skills-rows, .connector-list, .skill-table, .room-schedules-list")].find(shown);
		const lead = [...pane.querySelectorAll(".pane-lead")].find(shown);
		return {
			boxRight: box ? Math.round(box.getBoundingClientRect().right) : null,
			leadRight: lead ? Math.round(lead.getBoundingClientRect().right) : null,
			// Running text with a width of its own in between a form's field and the page: a name cut to one line is none.
			narrow: [...pane.querySelectorAll("*")]
				.filter((element) => shown(element) && own(element) && getComputedStyle(element).display !== "inline" && getComputedStyle(element).whiteSpace !== "nowrap")
				.flatMap((element) => {
					const width = parseFloat(getComputedStyle(element).maxWidth);
					return width >= 480 && width < 718 ? [`${element.tagName.toLowerCase()}.${element.className} ${width}`] : [];
				}),
		};
	});
}

async function checkWidths(browser: Browser): Promise<void> {
	const page = await openPage(browser, desktop(), "on");
	let leads = 0;
	await everyPage(page, async (which, label) => {
		const at = `1440, ${which}, ${label}`;
		await answered(page, at);
		const read = await readWidths(page);
		same(read.narrow, [], `${at}: running text with a width of its own`);
		if (read.leadRight !== null && read.boxRight !== null) {
			leads++;
			same(read.leadRight, read.boxRight, `${at}: the lead's right edge on its boxes'`);
		}
	});
	assert(leads >= 10, `1440: pages with a lead and a box (${leads})`);

	// A skill's own page: its description over the cards, and its Instructions' text inside one.
	await openWindow(page, "settings");
	await goToPage(page, "Skills");
	await answered(page, "Skills");
	await page.locator(".skill-table-row").filter({ hasText: "long-words" }).click();
	await page.locator(".skill-doc p").first().waitFor();
	same((await readWidths(page)).narrow, [], "1440, a skill's page: running text with a width of its own");
	const skill = await page.evaluate(() => {
		const edges = (selector: string) => { const box = document.querySelector(`.skill-detail ${selector}`)!.getBoundingClientRect(); return [Math.round(box.left), Math.round(box.right)]; };
		return { card: edges(".settings-rows"), lead: edges(".pane-lead"), doc: edges(".skill-doc"), words: edges(".skill-doc p") };
	});
	same([skill.lead, skill.doc], [skill.card, skill.card], "1440, a skill's page: its description and its Instructions card on the facts' edges");
	same(skill.words, [skill.doc[0] + 17, skill.doc[1] - 17], "1440, a skill's page: the Instructions' words 16 inside their card, both sides");
	await closeWindow(page);

	// A form takes the page's column: its widest line of controls (a field, or a field with the button beside it) and its notes.
	const addSkill = async (way: string) => { await goToPage(page, "Skills"); await page.getByRole("button", { name: "Add skill" }).click(); await page.getByRole("menuitem", { name: way }).click(); };
	const addConnector = async (way: string) => { await goToPage(page, "Connectors"); await page.getByRole("button", { name: "Add connector", exact: true }).click(); await page.getByText(way, { exact: true }).last().click(); };
	for (const [label, window, open, selector] of [
		["a task's form", "room", async () => { await goToPage(page, "Scheduled tasks"); await page.getByRole("button", { name: "New task", exact: true }).click(); }, ".room-schedules-form"],
		["Write it yourself", "settings", () => addSkill("Write it yourself"), ".skill-write-block .connector-form"],
		["From a repository address", "settings", () => addSkill("From a repository address"), ".skill-import-from-repo"],
		["Add by web address", "settings", () => addConnector("By web address"), ".connector-custom-form .connector-form"],
		["Add a program", "settings", () => addConnector("Program on this computer"), ".connector-custom-form .connector-form"],
	] as const) {
		await openWindow(page, window);
		await open();
		await page.locator(selector).first().waitFor();
		await answered(page, label);
		const read = await page.locator(selector).first().evaluate((form) => {
			const shown = (element: Element) => element.getClientRects().length > 0;
			const controls = [...form.querySelectorAll("input:not([type=checkbox], [type=radio]), textarea, select, button")].filter(shown).map((one) => one.getBoundingClientRect());
			const own = (element: Element) => [...element.childNodes].some((node) => node.nodeType === Node.TEXT_NODE && node.textContent!.trim() !== "");
			// One that fits its line may be as wide as its words.
			const notes = [...form.querySelectorAll("p, .connector-form-hint")].filter((one) => shown(one) && own(one) && one.getBoundingClientRect().height > 1.5 * parseFloat(getComputedStyle(one).lineHeight)).map((one) => one.getBoundingClientRect());
			return { form: [Math.round(Math.max(...controls.map((box) => box.right)) - Math.min(...controls.map((box) => box.left)))], notes: [...new Set(notes.map((box) => Math.round(box.width)))] };
		});
		same(read.form, [718], `1440, ${label}: its widest line of controls`);
		same(read.notes.filter((width) => width !== 718), [], `1440, ${label}: hints and notes not the column's width`);
		same((await readWidths(page)).narrow, [], `1440, ${label}: running text with a width of its own`);
		await closeWindow(page);
	}
	await page.context().close();
	console.log(`  ok  at 1440: the lead on its boxes' right edge (${leads} pages), no running text cut at a width of its own on any of the 17 pages or a skill's own; a skill's description and Instructions card on its facts' edges, the Instructions' words 16 inside; five forms' fields, hints and notes the page's 718`);
}

// --- The switches -----------------------------------------------------------

async function checkSwitches(browser: Browser): Promise<void> {
	const seen: string[] = [];
	for (const [where, options] of [["1440", desktop()], ["390", phone()]] as const) {
		const page = await openPage(browser, options, "on");
		await everyPage(page, async (which, label) => {
			await answered(page, `${where}, ${which}, ${label}`);
			const ends = await page.evaluate(() => [...document.querySelectorAll(".settings-look-next .settings-dialog-pane .workspaces-tool-switch")].filter((one) => one.getClientRects().length > 0).map((one) => {
				const box = one.closest(".settings-rows, .room-skills-rows, .connector-list, .room-schedules-list");
				return box ? Math.round((box.getBoundingClientRect().right - one.getBoundingClientRect().right) * 10) / 10 : "no box";
			}));
			if (ends.length === 0) return;
			seen.push(`${which}, ${label}`);
			same([...new Set(ends)], [17], `${where}, ${which}, ${label}: from each switch's right edge to its box's`);
		});
		await page.context().close();
	}
	assert(seen.includes("room, Folder") && seen.includes("room, Skills") && seen.length >= 12, `pages with a switch, at 1440 and 390 together (${seen.join("; ")})`);
	console.log(`  ok  at 1440 and 390: every switch ends 17 from its box's edge (${seen.length} pages with one)`);
}

// --- The button at the top of a page ---------------------------------------

async function checkHeadButtons(browser: Browser): Promise<void> {
	for (const [where, options] of [["1440 light", desktop()], ["1440 dark", desktop(1440, 900, DARK)], ["390 light", phone()], ["390 dark", phone(DARK)]] as const) {
		const small = where.startsWith("390");
		const page = await openPage(browser, options, "on");
		const read = (button: Locator) => button.evaluate(async (one, small) => {
			await Promise.all(one.getAnimations().map((animation) => animation.finished));
			const style = getComputedStyle(one);
			// Memory's own phone rule sets its buttons' words nearer their edge.
			return [one.getBoundingClientRect().height, style.fontSize, style.lineHeight, style.fontWeight, style.color, style.backgroundColor, style.borderTopColor, style.borderTopLeftRadius, small || style.paddingLeft].join(" ");
		}, small);
		// The measure: Add note, on its section's title line in Memory.
		await openWindow(page, "room");
		await goToPage(page, "Memory");
		await answered(page, `${where}, Memory`);
		const note = page.getByRole("button", { name: "Add note", exact: true });
		await note.waitFor();
		const want = await read(note);
		await closeWindow(page);
		for (const [which, label, name] of [["settings", "AI setup", "Add provider"], ["settings", "Skills", "Add skill"], ["settings", "Connectors", "Add connector"], ["room", "Scheduled tasks", "New task"]] as const) {
			const at = `${where}, ${label}`;
			await openWindow(page, which);
			await goToPage(page, label);
			await answered(page, at);
			const button = page.locator(".settings-dialog-pane .pane-head").getByRole("button", { name }).filter({ visible: true });
			await button.waitFor();
			await page.mouse.move(5, 5);
			same(await read(button), want, `${at}: ${name} as Memory's Add note`);
			const place = await button.evaluate((one) => {
				const middle = (element: Element) => { const box = element.getBoundingClientRect(); return (box.top + box.bottom) / 2; };
				const head = one.closest(".pane-head")!;
				const words = document.createRange();
				words.selectNodeContents(one);
				return { off: Math.abs(middle(one) - middle(head.querySelector("h2")!)), left: one.getBoundingClientRect().left - head.getBoundingClientRect().left, spare: one.getBoundingClientRect().width - words.getBoundingClientRect().width };
			});
			if (small) same([Math.round(place.left), place.spare < 60], [0, true], `${at}: ${name} from the page's left edge at its words' width`);
			else assert(place.off <= 0.5, `${at}: ${name} on its title's middle (${place.off} off)`);
			// Its form or its menu is open: the page's one ink button, if any, is the form's.
			if (name === "New task") {
				await button.click();
				const form = page.locator(".room-schedules-form");
				await form.waitFor();
				same(await page.locator(".settings-dialog-pane .rs-btn-primary").filter({ visible: true }).allInnerTexts(), ["Save task"], `${at}: the one ink button with its form open`);
			}
			await closeWindow(page);
		}
		await page.context().close();
	}
	console.log("  ok  at 1440 and 390, both themes: Add provider, Add skill, Add connector and New task have Add note's look, on their title's middle, on a phone from the left at their words' width; New task's form has the one ink button");
}

// --- The chevrons ----------------------------------------------------------

async function checkChevrons(browser: Browser): Promise<void> {
	for (const [where, options] of [["1440", desktop()], ["390", phone()]] as const) {
		const page = await openPage(browser, options, "on");
		// The connector answers, so its row ends on the chevron and no button.
		await page.route("**/api/mcp/servers/*/test", (route) => route.fulfill({ json: { ok: true, toolCount: 1, toolNames: ["search"] } }));
		await openWindow(page, "settings");
		const read = (row: string, mark: string) => page.evaluate(([row, mark]) => {
			const shown = (selector: string, root: ParentNode = document) => [...root.querySelectorAll(selector)].find((one) => one.getClientRects().length > 0)!;
			const line = shown(row);
			const box = line.closest(".skill-table, .connector-list")!.getBoundingClientRect();
			const [chevron, whole] = [shown(mark, line).getBoundingClientRect(), line.getBoundingClientRect()];
			const style = getComputedStyle(shown(mark, line));
			return { drawn: [shown(mark, line).textContent, style.maskImage.startsWith("url("), style.maskImage, style.maskPosition, style.maskSize], size: [chevron.width, chevron.height], fromBox: Math.round(box.right - chevron.right), offMiddle: Math.round(Math.abs((chevron.top + chevron.bottom) / 2 - (whole.top + whole.bottom) / 2)) };
		}, [row, mark] as const);
		await goToPage(page, "Connectors");
		await answered(page, `${where}, Connectors`);
		await page.locator(".connector-list .disclosure-chevron").first().waitFor();
		const connectors = await read(".connector-list .connector-item-hit", ".disclosure-chevron");
		same([connectors.drawn.slice(0, 2), connectors.size, connectors.fromBox, connectors.offMiddle], [["", true], [16, 16], 17, 0], `${where}, Settings, Connectors: a row's chevron`);
		await goToPage(page, "Skills");
		await answered(page, `${where}, Skills`);
		same(await read(".skill-table .skill-row", ".skill-table-chevron"), connectors, `${where}, Settings, Skills: a row's chevron as a Connectors row's`);
		await page.context().close();
	}
	console.log("  ok  at 1440 and 390: a Skills row's chevron has the size and the place of a Connectors row's");
}

// --- A page inside a page, by touch on a wide screen -------------------------

async function checkTouchHead(browser: Browser): Promise<void> {
	const page = await openPage(browser, { ...phone(), viewport: { width: 1024, height: 768 } }, "on");
	await openWindow(page, "settings");
	const read = () => page.evaluate(() => {
		const shown = (selector: string) => [...document.querySelectorAll(selector)].find((one) => one.getClientRects().length > 0)!;
		const middle = (box: DOMRect) => Math.round(box.top + box.height / 2);
		const arrow = shown(".settings-dialog-pane .pane-head-back");
		const head = arrow.closest(".pane-head")!;
		const name = head.querySelector("h2")!;
		const pane = shown(".settings-dialog-pane");
		const words = document.createRange();
		words.selectNodeContents(name);
		return {
			size: [arrow.getBoundingClientRect().width, arrow.getBoundingClientRect().height],
			markLeft: Math.round(arrow.querySelector("svg")!.getBoundingClientRect().left - pane.getBoundingClientRect().left - parseFloat(getComputedStyle(pane).paddingLeft)),
			nameAfter: Math.round(words.getBoundingClientRect().left - arrow.querySelector("svg")!.getBoundingClientRect().right),
			middles: [arrow.querySelector("svg")!.getBoundingClientRect(), words.getBoundingClientRect(), shown(".settings-dialog-close svg").getBoundingClientRect()].map(middle),
			height: Math.round(head.getBoundingClientRect().height),
		};
	});
	for (const [label, open] of [
		["a skill's page", async () => { await goToPage(page, "Skills"); await page.locator(".skill-table-row").filter({ hasText: "long-words" }).tap(); }],
		["Add by web address", async () => { await goToPage(page, "Connectors"); await page.getByRole("button", { name: "Add connector", exact: true }).tap(); await page.getByText("By web address", { exact: true }).last().tap(); }],
	] as const) {
		await open();
		await page.locator(".settings-dialog-pane .pane-head-back").first().waitFor();
		const at = await read();
		same([at.size, at.markLeft, at.nameAfter], [[44, 44], 0, 18], `1024 by touch, ${label}: the arrow 44 to the finger, its mark on the content's left edge and the name where a pointer has it`);
		assert(Math.max(...at.middles) - Math.min(...at.middles) <= 1, `1024 by touch, ${label}: the arrow, the name and the close on one line (${at.middles.join(", ")})`);
		same(at.height, 56, `1024 by touch, ${label}: its line 56 tall`);
	}
	await page.context().close();
	console.log("  ok  by touch at 1024, on a skill's page and an add page: the arrow 44 to the finger, its mark on the content's left edge, the name and the close on its line");
}

// --- The room's name --------------------------------------------------------

const readPencil = (page: Page) => page.evaluate(() => {
	const row = document.querySelector(".settings-look-next .settings-dialog-title-row")!;
	const button = row.querySelector(".settings-dialog-title-action")!;
	const box = button.getBoundingClientRect();
	let shown = 1;
	for (let at: Element | null = button; at && at !== row; at = at.parentElement) shown *= parseFloat(getComputedStyle(at).opacity);
	return { words: (row as HTMLElement).innerText.trim(), name: button.getAttribute("aria-label"), mark: button.querySelector("svg") !== null, shown: Math.round(shown * 100) / 100, size: [Math.round(box.width), Math.round(box.height)] };
});
const pencilShows = (page: Page, shown: number, what: string) => waitUntil(async () => (await readPencil(page)).shown === shown, what, 3000);

async function checkName(browser: Browser): Promise<void> {
	const page = await openPage(browser, desktop(), "on");
	await openWindow(page, "room");
	const pencil = page.getByRole("button", { name: "Rename room", exact: true });
	const title = page.locator("#room-settings-title");
	const field = page.getByRole("textbox", { name: "Room name", exact: true });
	const editing = async (what: string) => {
		await field.waitFor();
		same(await field.evaluate((input: HTMLInputElement) => [input.value, input === document.activeElement]), [ROOM, true], `${what}: the name in its field, with the focus`);
	};
	await page.mouse.move(900, 600);
	await pencilShows(page, 0, "1440, at rest: no pencil");
	const rest = await readPencil(page);
	same([rest.words, rest.name, rest.mark], [ROOM, "Rename room", true], "1440: the name alone, no word beside it, and a pencil named for a screen reader");
	const nameBox = (await title.boundingBox())!;
	await page.mouse.move(nameBox.x + 10, nameBox.y + 10);
	await pencilShows(page, 1, "1440, the pointer on the name: the pencil");
	same((await title.boundingBox())!, nameBox, "1440: the name doesn't move when the pencil shows");
	await page.mouse.move(900, 600);
	await pencilShows(page, 0, "1440, the pointer gone: no pencil");
	// The keyboard reaches it, sees it, and starts the editing with it.
	await page.locator(".settings-dialog-nav-item").first().focus();
	await page.keyboard.press("Shift+Tab");
	same(await pencil.evaluate((button) => button === document.activeElement), true, "1440: the pencil before the list, by keyboard");
	await pencilShows(page, 1, "1440, the keyboard's focus: the pencil");
	await page.keyboard.press("Enter");
	await editing("1440, Enter on the pencil");
	await page.getByRole("button", { name: "Cancel", exact: true }).click();
	// A click on the name, and one on the pencil.
	await title.click();
	await editing("1440, a click on the name");
	const edit = await page.evaluate(() => {
		const side = document.querySelector(".settings-dialog-head")!;
		const style = getComputedStyle(side);
		const input = document.querySelector<HTMLInputElement>(".room-settings-rename-input")!;
		const row = input.getBoundingClientRect();
		return { column: Math.round(side.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight)), field: Math.round(row.width), under: [...document.querySelectorAll(".room-settings-rename-form button")].every((button) => button.getBoundingClientRect().top >= row.bottom) };
	});
	same([edit.field, edit.under], [edit.column, true], "1440, editing: the field as wide as the column, Save and Cancel under it");
	assert(edit.field >= 190, `1440, editing: the field wide enough for a usual name (${edit.field})`);
	await page.getByRole("button", { name: "Cancel", exact: true }).click();
	await title.hover();
	await pencil.click();
	await editing("1440, a click on the pencil");
	// The same saving as before, through the question about the mentions in the room's memory.
	for (const name of ["Client offers", ROOM]) {
		if (name === ROOM) await title.click();
		await field.fill(name);
		await page.getByRole("button", { name: "Save", exact: true }).click();
		await page.getByRole("button", { name: "Apply", exact: true }).click();
		await waitUntil(async () => await title.isVisible() && await title.innerText() === name, `1440: ${name}, saved, in the window's title`);
	}
	await page.context().close();

	// Without a pointer to hover with it always shows, 44 to the finger: on a phone, and on a tablet as wide as a desktop.
	for (const [where, options] of [["390", phone()], ["1024 by touch", { ...phone(), viewport: { width: 1024, height: 768 } }]] as const) {
		const touch = await openPage(browser, options, "on");
		await openWindow(touch, "room");
		if (isPhone(touch)) await touch.locator(".settings-dialog-nav-item").first().waitFor();
		const read = await readPencil(touch);
		same([read.words, read.shown, read.size], [ROOM, 1, [44, 44]], `${where}: the name and its pencil, always shown, 44 to the finger`);
		const covered = await touch.evaluate(() => {
			const button = document.querySelector(".settings-dialog-title-action")!;
			const box = button.getBoundingClientRect();
			return [[box.width / 2, 1], [1, box.height / 2], [box.width - 1, box.height / 2], [box.width / 2, box.height - 1]].filter(([x, y]) => !button.contains(document.elementFromPoint(box.left + x, box.top + y)));
		});
		same(covered, [], `${where}: edges of the pencil's target that something else covers, beside a long name`);
		await touch.getByRole("button", { name: "Rename room", exact: true }).tap();
		await touch.getByRole("textbox", { name: "Room name", exact: true }).waitFor();
		await touch.context().close();
	}
	console.log("  ok  the room's name: no word Rename; the pencil hidden at rest, shown under the pointer and to the keyboard's focus, the name not moving; the name, the pencil and Enter on it start the editing, its field the column's width with Save and Cancel under it, and saving works; without a pointer the pencil always shows, 44 to the finger");
}

async function checkRefusedName(browser: Browser): Promise<void> {
	for (const [where, options] of [["1440", desktop()], ["390", phone()]] as const) {
		for (const theme of [LIGHT, DARK] as const) {
			const at = `${where} ${theme}`;
			const page = await openPage(browser, { ...options, colorScheme: theme }, "on");
			await openWindow(page, "room");
			const field = page.getByRole("textbox", { name: "Room name", exact: true });
			const read = () => page.evaluate(() => {
				const box = (selector: string) => { const r = document.querySelector(`.settings-look-next ${selector}`)!.getBoundingClientRect(); return { top: r.top, bottom: r.bottom, left: r.left, right: r.right, width: Math.round(r.width) }; };
				const note = document.querySelector(".settings-look-next .settings-dialog-head-note");
				const words = note?.querySelector(".workspaces-error");
				const painted = words && getComputedStyle(words);
				// What a person sees at the first row's middle, and whether anything of the note lies over a row.
				const rows = [...document.querySelectorAll(".settings-look-next .settings-dialog-nav-item")].filter((one) => one.getClientRects().length > 0).map((one) => one.getBoundingClientRect());
				const noteBox = note?.getBoundingClientRect();
				return {
					rowTop: rows[0].top, field: box(".room-settings-rename-input"), buttons: Math.max(...[...document.querySelectorAll(".room-settings-rename-form button")].map((one) => one.getBoundingClientRect().bottom)),
					note: note && words && noteBox ? {
						words: (words as HTMLElement).innerText, role: note.getAttribute("role"), top: noteBox.top, bottom: noteBox.bottom, left: noteBox.left, width: Math.round(noteBox.width), over: rows.filter((row) => noteBox.bottom > row.top && noteBox.top < row.bottom).length,
						fill: getComputedStyle(note).backgroundColor, edge: getComputedStyle(note).borderTopWidth, shadow: getComputedStyle(note).boxShadow, colour: painted!.color, size: `${painted!.fontSize}/${painted!.lineHeight}`,
					} : null,
				};
			});
			if (!isPhone(page)) await page.getByRole("button", { name: "Rename room", exact: true }).focus();
			await page.getByRole("button", { name: "Rename room", exact: true }).click();
			await field.waitFor();
			const before = await read();
			await field.fill(OTHER_ROOM);
			await page.getByRole("button", { name: "Save", exact: true }).click();
			await page.locator(".settings-dialog-head-note .workspaces-error").waitFor();
			const after = await read();
			const note = after.note!;
			same([note.words.includes(OTHER_ROOM) && note.words.startsWith("A room named"), note.role], [true, "status"], `${at}: the refusal's words and its announcement, as before`);
			same([note.fill, note.edge, note.shadow], ["rgba(0, 0, 0, 0)", "0px", "none"], `${at}: no card`);
			same([note.width, Math.round(note.left), note.size], [after.field.width, Math.round(after.field.left), "13px/18px"], `${at}: a line as wide as the field`);
			assert(note.top >= after.buttons, `${at}: under Save and Cancel (${note.top} and ${after.buttons})`);
			same(note.over, 0, `${at}: menu rows the refusal lies over`);
			assert(after.rowTop >= note.bottom && after.rowTop > before.rowTop, `${at}: the menu moved down, clear of it (${before.rowTop} to ${after.rowTop}, the line ends ${note.bottom})`);
			const red = await page.evaluate(() => { const probe = document.createElement("span"); probe.style.color = "var(--error)"; document.querySelector(".settings-look-next")!.append(probe); const colour = getComputedStyle(probe).color; probe.remove(); return colour; });
			same(note.colour, red, `${at}: quiet red`);
			// It goes with Cancel, and the rows are back.
			await page.getByRole("button", { name: "Cancel", exact: true }).click();
			await page.locator(".settings-dialog-title-row").waitFor();
			same((await page.locator(".settings-dialog-head-note").count()), 0, `${at}: gone with Cancel`);
			await page.context().close();
		}
	}
	console.log("  ok  a refused name at 1440 and 390, both themes: a red line the field's width under Save and Cancel, no card, over no menu row, the menu moved down; gone with Cancel");
}

try {
	const agents = await import("../src/persistent-agents.js");
	agents.createPersistentAgentFromScaffoldInput({ displayName: OTHER_ROOM, userName: "Synthetic User", preferredUserAddress: "Synthetic User" });
	const lookRoom = agents.createPersistentAgentFromScaffoldInput({ displayName: ROOM, userName: "Synthetic User", preferredUserAddress: "Synthetic User" }).agent.agentId;
	await startServer();
	const seed = async (method: "POST" | "PUT", route: string, body: unknown): Promise<void> => {
		const answer = await authedFetch(`${baseUrl}${route}`, { method, headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
		assert(answer.ok, `seeding ${route}: ${answer.status} ${await answer.text()}`);
	};
	const room = `/api/persistent-agents/${encodeURIComponent(lookRoom)}`;
	await seed("POST", `${room}/memory/entries`, { topic: "General", kind: "fact", text: "Reports go out on Fridays.", newTopic: true });
	await seed("POST", `${room}/schedules`, { name: "Weekly summary", type: "once", schedule: "+30m", prompt: "Write the weekly summary.", enabled: true });
	await seed("POST", "/api/skills", { id: "long-words", displayName: "long-words", description: LONG_HELP, instructions: LONG_HELP });
	await seed("PUT", `${room}/skill-settings`, { action: "enable", name: "long-words" });
	await seed("POST", "/api/mcp/servers", { name: "notes-server", url: "http://127.0.0.1:9/mcp" });
	await seed("PUT", `${room}/mcp-connectors`, { action: "grant", name: "notes-server" });
	const folder = path.join(tempHome, "Documents", "Offers 2026");
	fs.mkdirSync(folder, { recursive: true });
	await seed("PUT", `${room}/workspace-default`, { root: folder, workspaceAccessMode: "localFiles", bashEnabled: true });

	const browser = await chromium.launch({ ignoreDefaultArgs: ["--hide-scrollbars"] });
	try {
		const failed: string[] = [];
		for (const row of [checkWidths, checkSwitches, checkHeadButtons, checkChevrons, checkTouchHead, checkName, checkRefusedName]) {
			try {
				await row(browser);
			} catch (error) {
				// The first line, and for a wait the locator it waited for.
				failed.push(`${row.name}: ${(error as Error).message.split("\n").filter((line, i) => i === 0 || /waiting for/.test(line)).slice(0, 2).join(" ").replace(/\u001b\[\d+m/g, "")}`);
				console.log(`  FAIL ${failed.at(-1)}`);
				for (const context of browser.contexts()) await context.close();
			}
		}
		assert(failed.length === 0, `${failed.length} rows failed:\n${failed.join("\n")}`);
	} finally {
		await browser.close();
	}
	console.log("settings look top ui smoke passed");
} finally {
	await stopSmokeServer(server);
	fs.rmSync(tempRoot, { recursive: true, force: true });
}
