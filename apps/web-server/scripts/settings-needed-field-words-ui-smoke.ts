// A form in the settings windows saved with a needed field empty says so in
// words, not by the red edge alone, in all four forms: a connector by web
// address or as a program, a skill written by hand, a skill's repository, and
// a scheduled task, new and edited. Pressed with every needed field empty and
// with one, at desktop and phone width: "Fill this in." 6 under each marked
// field in the look's style for why a form can't be saved, and nowhere before
// the press; gone as its field is filled; only the rows below it move. A
// screen reader gets it as the field's description, beside any other the
// field has and never in its name, and it is there when the focus arrives. A
// skill's refused name keeps its own words. Throwaway HOME, no model.
//
// Run: node scripts/run-smokes.mjs settings-needed-field-words-ui
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, type Browser, type BrowserContextOptions, type Locator, type Page } from "playwright";
import { authedFetch, freePort, SMOKE_SERVER_AUTH_ENV, SMOKE_SERVER_SPAWN_TREE_OPTIONS, smokeHomeEnv, stopSmokeServer, waitForServer } from "./smoke-server-process.js";
import { answered, assert, DARK, desktop, goToPage, LIGHT, lookPages, phone, redEdges, same } from "./settings-look-smoke-parts.js";
import { CONNECTOR_WORDS as WORDS } from "../../web-ui/src/connector-rows.js";
import { ADD_SKILL_WAYS, SKILL_NAME_REFUSED_LINE } from "../../web-ui/src/skill-source-copy.js";

{
	const executable = typeof chromium?.executablePath === "function" ? chromium.executablePath() : "";
	if (!executable || !fs.existsSync(executable)) {
		console.log("settings needed field words ui smoke skipped (Chromium not installed)");
		process.exit(0);
	}
}

/** The words under an empty needed field, as a person reads them. */
const LINE = "Fill this in.";
const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const webServerDir = path.resolve(scriptDir, "..");
const repoRoot = path.resolve(webServerDir, "..", "..");
const tempRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "exxperts-settings-needed-field-words-")));
const tempHome = path.join(tempRoot, "home");
fs.mkdirSync(tempHome, { recursive: true });
const port = await freePort();
const baseUrl = `http://127.0.0.1:${port}`;
const ROOM = "Monthly reporting";
const { openPage, openWindow } = lookPages({ baseUrl, room: ROOM });

// --- The forms ------------------------------------------------------------------

const PANE = ".settings-dialog-pane";
type Form = {
	label: string;
	which: "settings" | "room";
	page: string;
	root: string;
	/** Opens the form on its page. */
	open: (page: Page) => Promise<void>;
	save: string;
	/** Each needed field, in order: where it is, what fills it, any other words that describe it, and `hinted` for one
	 * whose filled value has a hint of its own drawn where the line stood (and, like every hint in a label, in its name). */
	fields: Array<{ at: string; fill: string; described?: string; hinted?: boolean }>;
};

const addConnector = (way: string) => async (page: Page) => {
	await page.locator(`${PANE} .connector-add-btn`).click();
	await page.getByRole("menuitem", { name: way }).click();
};
const addSkill = (way: string) => async (page: Page) => {
	await page.locator(".settings-dialog").getByRole("button", { name: "Add skill", exact: true }).click();
	await page.getByRole("menuitem", { name: way }).click();
};
const task = ["input.launcher-path-input", "textarea.launcher-path-input"];
const FORMS: Form[] = [
	{ label: "a connector by web address", which: "settings", page: "Connectors", root: ".connector-custom-form", open: addConnector(WORDS.addWays.web), save: WORDS.form.add, fields: [{ at: ".connector-form-field:nth-child(1) > input", fill: "Project tracker" }, { at: ".connector-form-field:nth-child(2) > input", fill: "https://projects.example.com/mcp" }] },
	{ label: "a connector as a program", which: "settings", page: "Connectors", root: ".connector-custom-form", open: addConnector(WORDS.addWays.program), save: WORDS.form.add, fields: [{ at: ".connector-form-field:nth-child(1) > input", fill: "Files" }, { at: ".connector-command-input", fill: "npx -y files", described: WORDS.form.commandHint }] },
	{ label: "a skill written by hand", which: "settings", page: "Skills", root: ".skill-write-block", open: addSkill(ADD_SKILL_WAYS.write), save: "Save skill", fields: [{ at: ".connector-form-field:nth-child(1) > input", fill: "Cite Sources", hinted: true }, { at: ".connector-form-field:nth-child(2) > input", fill: "Use when an answer states facts." }, { at: "textarea", fill: "Cite the source of every fact." }] },
	{ label: "a skill's repository", which: "settings", page: "Skills", root: ".skill-import-from-repo", open: addSkill(ADD_SKILL_WAYS.repository), save: "Scan", fields: [{ at: ".skill-import-url", fill: "https://example.com/team/skills" }] },
	{ label: "a new task", which: "room", page: "Scheduled tasks", root: "form.room-schedules-form", open: (page) => page.locator(".settings-dialog").getByRole("button", { name: "New task", exact: true }).click(), save: "Save task", fields: [{ at: task[0], fill: "Weekly letter" }, { at: task[1], fill: "Draft the weekly letter." }] },
	{ label: "a task's edit", which: "room", page: "Scheduled tasks", root: "form.room-schedules-form", open: async (page) => {
		const form = page.locator("form.room-schedules-form");
		await page.locator(`${PANE} .room-schedules-job`).first().getByRole("button", { name: "Edit" }).click();
		for (const field of task) await form.locator(field).first().fill("");
	}, save: "Save", fields: [{ at: task[0], fill: "Weekly summary" }, { at: task[1], fill: "Write the weekly summary." }] },
];

/** Opens a form, its page filled in, and answers its fields. */
async function openForm(page: Page, form: Form): Promise<{ fields: Locator[]; save: Locator }> {
	await openWindow(page, form.which);
	await goToPage(page, form.page);
	await answered(page, form.label);
	await form.open(page);
	const root = page.locator(`${PANE} ${form.root}`).filter({ visible: true }).first();
	await root.waitFor();
	return { fields: form.fields.map((field) => root.locator(field.at).first()), save: root.getByRole("button", { name: form.save, exact: true }) };
}

/** What a person sees of each field, and what a screen reader gets of it: its name and description from the browser's own accessibility tree. */
async function readFields(page: Page, fields: Locator[]) {
	const seen = [];
	const session = await page.context().newCDPSession(page);
	for (const [index, field] of fields.entries()) {
		const shown = await field.evaluate((element, index) => {
			element.setAttribute("data-smoke-field", String(index));
			// What stands right under the field: the next thing drawn in its column.
			const box = element.getBoundingClientRect();
			const lines = [...element.closest(".settings-dialog-pane")!.querySelectorAll("*")]
				.filter((one) => one.childElementCount === 0 && one.textContent!.trim() && getComputedStyle(one).visibility !== "hidden" && one.getClientRects().length > 0)
				.filter((one) => { const at = one.getBoundingClientRect(); return at.left >= box.left - 1 && at.left < box.right && at.top >= box.bottom - 1 && at.top < box.bottom + 14; });
			const first = lines[0];
			const style = first && getComputedStyle(first);
			const probe = document.createElement("i");
			probe.style.cssText = "color: var(--fg); border-color: var(--error)";
			element.parentElement!.append(probe);
			const colours = getComputedStyle(probe);
			const wanted = { text: colours.color, dot: colours.borderTopColor };
			probe.remove();
			const dot = first ? getComputedStyle(first, "::before") : null;
			return {
				invalid: element.getAttribute("aria-invalid"),
				focused: element === document.activeElement,
				under: lines.map((one) => one.textContent!.trim()),
				look: first && first.textContent === "Fill this in." ? {
					gap: Math.round(first.getBoundingClientRect().top - box.bottom),
					left: Math.round(first.getBoundingClientRect().left - box.left),
					text: [style!.color === wanted.text, style!.fontSize, style!.lineHeight, style!.paddingLeft],
					dot: [dot!.backgroundColor === wanted.dot, dot!.width, dot!.height, dot!.top],
				} : null,
			};
		}, index);
		const { result } = await session.send("Runtime.evaluate", { expression: `document.querySelector('[data-smoke-field="${index}"]')` }) as { result: { objectId: string } };
		const { nodes } = await session.send("Accessibility.getPartialAXTree", { objectId: result.objectId, fetchRelatives: false }) as { nodes: Array<{ name?: { value?: string }; description?: { value?: string } }> };
		seen.push({ ...shown, name: nodes[0]?.name?.value ?? "", description: nodes[0]?.description?.value ?? "" });
	}
	await session.detach();
	return seen;
}

/** Whether a field shows the line, in the look's style: 6 under its field from its left edge, the text colour after a red dot. */
const marked = (one: Awaited<ReturnType<typeof readFields>>[number]): boolean => one.invalid === "true" && one.under.includes(LINE);
const LINE_LOOK = { gap: 6, left: 0, text: [true, "13px", "18px", "18px"], dot: [true, "8px", "8px", "5px"] };

async function checkForm(browser: Browser, form: Form, where: string, options: BrowserContextOptions): Promise<void> {
	const page = await openPage(browser, options, "on");
	// Where the focus goes, and whether the field already says why at that moment.
	await page.evaluate(() => {
		(window as any).__focused = [];
		document.addEventListener("focusin", (event) => {
			const described = ((event.target as Element).getAttribute("aria-describedby") ?? "").split(" ").filter(Boolean).map((id) => document.getElementById(id)?.textContent ?? "");
			(window as any).__focused.push(described.join(" "));
		});
	});
	const { fields, save } = await openForm(page, form);
	const at = `${where}, ${form.label}`;
	const of = () => readFields(page, fields);
	const before = await of();
	same(before.map((one) => [one.invalid, one.under.includes(LINE)]), fields.map(() => [null, false]), `${at}, before ${form.save}: no field marked`);
	const names = before.map((one) => one.name);
	const othersOf = form.fields.map((field) => field.described ?? "");
	/** Each field's mark, its line's look, and what a screen reader gets. */
	const expectMarks = async (empty: boolean[], what: string) => {
		const seen = await of();
		same(seen.map(marked), empty, `${at}, ${what}: "${LINE}" under each empty field and no other`);
		same(seen.map((one) => one.invalid), empty.map((is) => (is ? "true" : null)), `${at}, ${what}: the marks`);
		for (const [index, one] of seen.entries()) {
			if (empty[index]) same(one.look, LINE_LOOK, `${at}, ${what}: the line under field ${index + 1}`);
			if (!form.fields[index]!.hinted || empty[index]) same(one.name, names[index], `${at}, ${what}: field ${index + 1}'s name`);
			same(one.description, [empty[index] ? LINE : "", othersOf[index]].filter(Boolean).join(" "), `${at}, ${what}: field ${index + 1}'s description`);
		}
		same(await redEdges(page.locator(`${PANE} [data-smoke-field]`)), empty, `${at}, ${what}: the red edges`);
		same(await page.getByText(LINE, { exact: true }).filter({ visible: true }).count(), empty.filter(Boolean).length, `${at}, ${what}: lines in all`);
	};
	await page.evaluate(() => { (window as any).__focused.length = 0; });
	await save.click();
	await expectMarks(fields.map(() => true), `${form.save} pressed with every field empty`);
	same((await of()).map((one) => one.focused), fields.map((_, index) => index === 0), `${at}: the focus in the first`);
	const firstSaid = await page.evaluate(() => (window as any).__focused.at(-1));
	same(firstSaid.startsWith(LINE), true, `${at}: the first field says why as the focus arrives, got ${JSON.stringify(firstSaid)}`);
	// One field after another filled: its line goes, the others stay, and what is above it doesn't move.
	for (const [index, field] of form.fields.entries()) {
		const tops = () => Promise.all(fields.map((one) => one.evaluate((element) => element.getBoundingClientRect().top)));
		const topsBefore = await tops();
		await fields[index]!.fill(field.fill);
		await expectMarks(fields.map((_, other) => other > index), `field ${index + 1} filled`);
		const topsAfter = await tops();
		same(topsAfter.map((top, other) => Math.round(topsBefore[other]! - top)), topsBefore.map((_, other) => (other > index && !field.hinted ? 24 : 0)), `${at}, field ${index + 1} filled: only the rows below move, by the line and its gap`);
		// Pressed with exactly that one field empty again: the mark comes back with its words.
		const wasFilled = field.fill;
		await fields[index]!.fill("");
		await expectMarks(fields.map((_, other) => other >= index), `field ${index + 1} emptied again`);
		await fields[index]!.fill(wasFilled);
	}
	if (fields.length > 1) {
		await fields.at(-1)!.fill("");
		await save.click();
		await expectMarks(fields.map((_, index) => index === fields.length - 1), `${form.save} pressed with one field empty`);
		same((await of()).map((one) => one.focused), fields.map((_, index) => index === fields.length - 1), `${at}: the focus in the one that is empty`);
		await fields.at(-1)!.fill(form.fields.at(-1)!.fill);
	}
	await expectMarks(fields.map(() => false), "every field filled");
	await page.context().close();
}

// --- The rows --------------------------------------------------------------------

async function checkEachForm(browser: Browser, form: Form): Promise<void> {
	for (const [where, options] of [["desktop", desktop(1440, 900, LIGHT)], ["desktop dark", desktop(1440, 900, DARK)], ["phone", phone()]] as const) await checkForm(browser, form, where, options);
	console.log(`  ok  ${form.label}: "${LINE}" 6 under each field left empty, in the look's style, read as the field's description beside its own words and not in its name, the first field saying it as the focus arrives; gone as it is filled; only the rows below move; none before the press; desktop light and dark, and phone`);
}

/** With a press that finds one field empty, the first in the order; the needed fields that hold words are not marked. */
async function checkOneEmpty(browser: Browser): Promise<void> {
	for (const form of FORMS.filter((one) => one.fields.length > 1)) {
		const page = await openPage(browser, desktop(1440, 900, LIGHT), "on");
		const { fields, save } = await openForm(page, form);
		for (const [index, field] of form.fields.entries()) if (index > 0) await fields[index]!.fill(field.fill);
		await save.click();
		const seen = await readFields(page, fields);
		same(seen.map(marked), seen.map((_, index) => index === 0), `${form.label}: the first alone empty: the line under it alone`);
		same(seen.map((one) => one.focused), seen.map((_, index) => index === 0), `${form.label}: the first alone empty: the focus`);
		await page.context().close();
	}
	console.log("  ok  the first field alone left empty: marked with the line, and the filled ones are not");
}

/** A skill's refused name: its own words, never two reasons under one field. */
async function checkRefusedName(browser: Browser): Promise<void> {
	const form = FORMS.find((one) => one.root === ".skill-write-block")!;
	const page = await openPage(browser, desktop(1440, 900, LIGHT), "on");
	const { fields, save } = await openForm(page, form);
	await fields[0]!.fill("!!!");
	await save.click();
	const refused = await readFields(page, fields);
	same(refused[0]!.invalid, "true", "a refused name: marked");
	same(await page.locator(`${PANE} .skill-field-error`).allTextContents(), [SKILL_NAME_REFUSED_LINE], "a refused name: its own words");
	same(refused[0]!.under.filter((line) => line === LINE || line === SKILL_NAME_REFUSED_LINE), [SKILL_NAME_REFUSED_LINE], "a refused name: one reason under the field, never two");
	same([refused[0]!.description.includes(LINE), refused[1]!.under.includes(LINE), refused[2]!.under.includes(LINE)], [false, true, true], "a refused name: the line only under the fields that are empty");
	// Emptied, it is a needed field like the others, with the one reason.
	await fields[0]!.fill("");
	const emptied = await readFields(page, fields);
	same([emptied[0]!.under.filter((line) => line === LINE || line === SKILL_NAME_REFUSED_LINE), await page.locator(`${PANE} .skill-field-error`).count()], [[LINE], 0], "a refused name emptied: the line alone");
	await page.context().close();
	console.log(`  ok  a skill's refused name keeps its own words ("${SKILL_NAME_REFUSED_LINE}") and no second reason under the field; emptied it says "${LINE}" alone`);
}

/** The old look marks nothing and says nothing: its main button is greyed until the form is filled. */
async function checkOldLook(browser: Browser): Promise<void> {
	for (const form of FORMS.slice(0, 4)) {
		const page = await openPage(browser, desktop(1440, 900, LIGHT), "off");
		const { fields, save } = await openForm(page, form);
		assert(await save.isDisabled(), `the old look, ${form.label}: ${form.save} greyed`);
		const seen = await readFields(page, fields);
		same([seen.map((one) => one.invalid), await page.locator(".settings-needed-line").count()], [seen.map(() => null), 0], `the old look, ${form.label}: no marks, no lines`);
		await page.context().close();
	}
	console.log("  ok  with the switch off, the forms are as they were: greyed until filled, no mark and no line");
}

// --- The run ---------------------------------------------------------------------

let server: ChildProcessWithoutNullStreams | undefined;
try {
	server = spawn("npx", ["tsx", "src/index.ts"], {
		shell: process.platform === "win32",
		...SMOKE_SERVER_SPAWN_TREE_OPTIONS,
		cwd: webServerDir,
		env: smokeHomeEnv(tempHome, { PORT: String(port), ...SMOKE_SERVER_AUTH_ENV, EXXETA_HOME: repoRoot }) as NodeJS.ProcessEnv,
		stdio: ["ignore", "pipe", "pipe"],
	}) as unknown as ChildProcessWithoutNullStreams;
	await waitForServer(server, baseUrl, { tries: 100 });
	const seed = async (method: "POST" | "PUT", route: string, body: unknown) => {
		const answer = await authedFetch(`${baseUrl}${route}`, { method, headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
		const text = await answer.text();
		assert(answer.ok, `seeding ${route}: ${answer.status} ${text}`);
		return JSON.parse(text);
	};
	const room = await seed("POST", "/api/persistent-agents", { displayName: ROOM, userName: "Synthetic User", preferredUserAddress: "Synthetic User" });
	await seed("POST", `/api/persistent-agents/${encodeURIComponent(room.agent.id)}/schedules`, { name: "Weekly summary", type: "cron", schedule: "0 0 9 * * 1", prompt: "Write the weekly summary of the reports.", enabled: true });
	await seed("POST", "/api/whats-new/seen", {});
	const browser = await chromium.launch({ ignoreDefaultArgs: ["--hide-scrollbars"] });
	try {
		const failed: string[] = [];
		const only = process.env.LOOK_ROWS?.split(",");
		const rows: Array<[string, (browser: Browser) => Promise<void>]> = [...FORMS.map((form): [string, (browser: Browser) => Promise<void>] => [form.label, (open) => checkEachForm(open, form)]), ["one empty", checkOneEmpty], ["refused name", checkRefusedName], ["old look", checkOldLook]];
		for (const [name, check] of rows) {
			if (only && !only.includes(name)) continue;
			try {
				await check(browser);
			} catch (error) {
				failed.push(`${name}: ${(error as Error).message.split("\n").slice(0, 2).join(" ")}`);
				console.log(`  FAIL ${failed.at(-1)}`);
				for (const context of browser.contexts()) await context.close();
			}
		}
		assert(failed.length === 0, `${failed.length} rows failed:\n${failed.join("\n")}`);
	} finally {
		await browser.close();
	}
	console.log("settings needed field words ui smoke passed");
} finally {
	await stopSmokeServer(server);
	fs.rmSync(tempRoot, { recursive: true, force: true });
}
