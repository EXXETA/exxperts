// Buttons, one family (01-base.css): Sen Medium ships with its licence text
// and loads in the page; no rule outside 01-base.css sets how a family button
// looks, only where it sits; and on first-run Home, Home with Sort and
// Create room, What's new, Help, Settings and Room settings with every pane
// and a confirm, Memory, a room's top bar, a work card's ask, its files and
// viewer, a toast and a notice, in light and dark, at 1280 px with a mouse and
// at 390 px with touch, every visible button is a family button, kept out
// on purpose (a switch, a tab, a row, a link in a sentence, the message box),
// or drawn to the quiet look outside the family (QUIET_LOOK: the model picker);
// NOT_YET is empty. Not swept, so proved by their own smokes: consult
// (consult-mention), the run view, the Mermaid viewer (mermaid-diagrams-ui)
// and Usage's CSV link. A family button is Sen 500 (the quiet look 400) at 13 px
// with 8 px corners and no visible edge, 32 or 28 px tall with a mouse and
// 44 px with touch, its words fit and read at 4.5:1 (a mark alone 3:1), and the main action
// fills ink, the final danger red. A label too long for a phone ends in "…"
// and the page never scrolls sideways. A quiet or red-words button that
// starts a line under text, or ends a row, keeps its words on the text edge.
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import { fileURLToPath } from "node:url";
import { chromium, type Browser, type Locator, type Page } from "playwright";
import { HISTORY_UNDO_LABEL, WHAT_CHANGED_LABEL } from "../../web-ui/src/memory-surface-copy.js";
import { routePageSocket, type PageSocket } from "./page-socket.js";
import { readPageStyles } from "./page-styles.js";
import { authedFetch, SMOKE_AUTH_TOKEN, SMOKE_SERVER_AUTH_ENV, SMOKE_SERVER_SPAWN_TREE_OPTIONS, smokeHomeEnv, stopSmokeServer, freePort, waitForServer } from "./smoke-server-process.js";
import { sendFromBox, waitEvery } from "./smoke-wait.js";

const waitUntil = waitEvery(100);

function assert(condition: unknown, message: string): asserts condition {
	if (!condition) throw new Error(message);
}
function same(actual: unknown, expected: unknown, what: string): void {
	assert(JSON.stringify(actual) === JSON.stringify(expected), `${what}: got ${JSON.stringify(actual)}, expected ${JSON.stringify(expected)}`);
}

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const webServerDir = path.resolve(scriptDir, "..");
const repoRoot = path.resolve(webServerDir, "..", "..");
const pageSrc = path.join(repoRoot, "apps", "web-ui", "src");
const stylesDir = path.join(pageSrc, "styles");
const fontsDir = path.join(repoRoot, "apps", "web-ui", "public", "fonts");
const FAMILY_FILE = "01-base.css";

// Kept out of the family on purpose: switches, tabs and choices, rows that
// are the whole line, menus' rows, words in a sentence, disclosure toggles,
// window and page chrome, the message box and the row under it, marks on a
// message, and a file's card (its preview is the button). The update's
// Not now sits in the gear's menu but is a button beside its row, not a row.
// The New room tile has a look of its own, a card-sized wash (design 1.1).
const EXCLUDED = [
	".add-room-card",
	"[role=switch]", "[role=tab]", "[role=radio]", "[role=menuitem]:not(.menu-update-later)", "[role=option]", "[aria-pressed]", "[aria-selected]",
	".settings-segment", ".room-schedules-day-chip", ".remote-capability-seg button",
	".settings-dialog-nav-item", ".product-nav-item", ".list-btn", ".skill-row", ".connector-item-hit", ".maintain-action", ".bar-row", ".mem-hit", ".mem-card",
	".ai-profile-menu-item", ".menu-item",
	".connector-text-btn", ".rs-text-btn", ".ai-profile-foot-link", ".signed-in-as-out", ".mem-prov-link",
	".consult-item-toggle", ".ai-profile-models-toggle", ".memory-topic-head", ".whats-new-row-toggle", ".wk-head", "summary",
	".sidebar-toggle", ".history-arrow", ".topbar-home-btn", ".jump-to-latest", ".skill-detail-back", ".settings-dialog-back", ".rs-info", ".card-model-label",
	".send-btn", ".stop-btn", ".absorb-discussion-send", ".model-pick-trigger", ".checkpoint-split-main", ".checkpoint-split-toggle", ".composer-context-pill", ".composer-attach-btn",
	".message-copy", ".message-edit-user", ".att-open",
];

// Drawn by their own style file to the quiet button's look, so swept with the
// family's rows but one: their words are a value in a row's weight, not an
// action's 500. The model picker names the room's model with its provider
// and opens a list (checkModelPick holds the rest of its look).
const QUIET_LOOK = [".room-model-pick"];

// Buttons whose words are the person's own, such as a room's name: a long one
// ends in "…" (checkMemory proves it), so their words may be wider than the
// button.
const OWN_WORDS = [".mem-absorb-rooms .mem-review-btn"];

// Buttons a later step converts, by the class that draws them today. Each
// must still be in the page's code: a step that converts one takes it off.
const NOT_YET: string[] = [];

// Rules outside 01-base.css that may still set a look property on a family
// button, or under one, each with why.
const STYLE_EXCEPTIONS: { file: string; selector: string; why: string }[] = [
	{ file: "40-room-arrange.css", selector: ".persistent-agent-card.arranging .card-gear-btn", why: "while rooms are arranged the gear dims with the card's other controls; it is inert there, not disabled" },
	{ file: "33-assets.css", selector: ".att-more-holder", why: "a surface under a button that sits over a picture: a file card's ⋯ over its preview, shown with it" },
];

// Where a family button sits is an area file's business; how it looks is not.
const PLACE_PROPERTY = /^(margin(-[a-z-]+)?|flex(-[a-z]+)?|grid(-[a-z-]+)?|align-self|justify-self|order|position|top|right|bottom|left|inset(-[a-z-]+)?|width|min-width|max-width|visibility|z-index|-webkit-app-region)$/;

type StyleRule = { selector: string; body: string };

function cssRules(css: string): StyleRule[] {
	const out: StyleRule[] = [];
	let at = 0;
	while (at < css.length) {
		let end = at;
		let depth = 0;
		while (end < css.length && !(depth === 0 && (css[end] === "{" || css[end] === ";"))) {
			if (css[end] === "(") depth++;
			else if (css[end] === ")") depth--;
			end++;
		}
		if (end >= css.length) break;
		const head = css.slice(at, end).trim();
		if (css[end] === ";") { at = end + 1; continue; }
		let close = end + 1;
		for (let open = 1; close < css.length && open > 0; close++) {
			if (css[close] === "{") open++;
			else if (css[close] === "}") open--;
		}
		const body = css.slice(end + 1, close - 1);
		if (!head.startsWith("@")) out.push({ selector: head, body });
		else if (/^@(media|supports|container|layer)\b/.test(head)) out.push(...cssRules(body));
		at = close;
	}
	return out;
}

/** Splits at the top level only, so a comma inside :is() stays. */
function splitTop(text: string, at: RegExp): string[] {
	const parts = [""];
	let depth = 0;
	for (const c of text) {
		if (c === "(") depth++;
		else if (c === ")") depth--;
		if (depth === 0 && at.test(c)) parts.push("");
		else parts[parts.length - 1] += c;
	}
	return parts;
}

/** The classes on the element a selector styles: its last compound, without what :has() and :not() name. */
function subjectClasses(selector: string): string[] {
	const compound = splitTop(selector.trim(), /[\s>+~]/).filter(Boolean).at(-1) ?? "";
	let kept = "";
	for (let i = 0; i < compound.length;) {
		const negated = /^:(has|not)\(/.exec(compound.slice(i));
		if (!negated) { kept += compound[i++]; continue; }
		let j = i + negated[0].length;
		for (let open = 1; j < compound.length && open > 0; j++) {
			if (compound[j] === "(") open++;
			else if (compound[j] === ")") open--;
		}
		i = j;
	}
	return [...kept.matchAll(/\.([\w-]+)/g)].map((m) => m[1]);
}

/** Every class that sits on a family button in the page's code, so a rule reaching one through its handle is found too. */
function familyClasses(): Set<string> {
	const classes = new Set(["rs-btn", "rs-quiet"]);
	const files = (dir: string): string[] => fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => entry.isDirectory() ? files(path.join(dir, entry.name)) : [path.join(dir, entry.name)]);
	const literals = (code: string) => [...code.matchAll(/"([^"\n]*)"|`([^`]*)`/g)].map((m) => (m[1] ?? m[2]).replace(/\$\{[^}]*\}/g, " "));
	for (const file of files(pageSrc).filter((name) => /\.tsx?$/.test(name))) {
		const source = fs.readFileSync(file, "utf8");
		for (const attribute of source.matchAll(/\b(?:className|quiet)=/g)) {
			const start = attribute.index! + attribute[0].length;
			let texts: string[] = [];
			if (source[start] === '"') texts = [source.slice(start + 1, source.indexOf('"', start + 1))];
			else if (source[start] === "{") {
				let end = start + 1;
				for (let open = 1; end < source.length && open > 0; end++) {
					if (source[end] === "{") open++;
					else if (source[end] === "}") open--;
				}
				texts = literals(source.slice(start + 1, end - 1));
			}
			for (const text of texts) {
				const tokens = text.split(/\s+/).filter((token) => /^[a-z][a-z0-9-]*$/.test(token));
				if (tokens.includes("rs-btn")) for (const token of tokens) classes.add(token);
			}
		}
	}
	return classes;
}

/** Each rule outside the family file that names a family button and sets more than its place. */
function lookRulesOutsideFamily(files: { name: string; css: string }[], family: Set<string>): string[] {
	const found: string[] = [];
	for (const { name, css } of files) {
		if (name === FAMILY_FILE) continue;
		for (const rule of cssRules(css.replace(/\/\*[\s\S]*?\*\//g, ""))) {
			const looks = rule.body.split(";").map((line) => line.split(":")[0].trim().toLowerCase()).filter((property) => property && !property.startsWith("--") && !PLACE_PROPERTY.test(property));
			if (looks.length === 0) continue;
			for (const selector of splitTop(rule.selector, /,/)) {
				const named = subjectClasses(selector).filter((one) => family.has(one));
				if (named.length === 0 || STYLE_EXCEPTIONS.some((one) => one.file === name && one.selector === selector.trim())) continue;
				found.push(`${name}: ${selector.trim()} sets ${looks.join(", ")}`);
			}
		}
	}
	return found;
}

function checkStyleRules(): void {
	readPageStyles();
	const files = fs.readdirSync(stylesDir).filter((name) => name.endsWith(".css")).sort().map((name) => ({ name, css: fs.readFileSync(path.join(stylesDir, name), "utf8") }));
	const family = familyClasses();
	for (const handle of ["rs-btn-primary", "rs-btn-danger", "rs-btn-quiet", "rs-btn-sm", "connector-slot-btn"]) assert(family.has(handle), `the family's classes include ${handle}`);
	same(lookRulesOutsideFamily(files, family), [], "rules outside 01-base.css that set a family button's look");
	for (const exception of STYLE_EXCEPTIONS) assert(files.some((file) => file.name === exception.file && file.css.includes(exception.selector)), `the style exception ${exception.selector} is still in ${exception.file}`);
	// The check itself: a fill, a size or a font through a handle is found, a place is not.
	const probe = (css: string) => lookRulesOutsideFamily([{ name: "99-probe.css", css }], family);
	same(probe(".pane .rs-btn { padding: 2px; }"), ["99-probe.css: .pane .rs-btn sets padding"], "a padding on a family button");
	same(probe("@media (max-width: 760px) { .connector-list .connector-slot-btn { height: 44px; } }"), ["99-probe.css: .connector-list .connector-slot-btn sets height"], "a height through a handle, in a media query");
	same(probe(".rs-quiet:hover { color: red; }"), ["99-probe.css: .rs-quiet:hover sets color"], "a colour through the old quiet class");
	same(probe(".pane .rs-btn { margin-left: auto; flex: 1 1 auto; width: 100%; } .row:has(> .rs-btn) { gap: 4px; } .x:not(.rs-btn) { color: red; }"), [], "places, a parent that holds one, and a rule for everything else");
	// The not-yet list names only classes the page still draws.
	const code = fs.readdirSync(path.join(pageSrc, "components")).map((name) => fs.readFileSync(path.join(pageSrc, "components", name), "utf8")).join("\n") + fs.readFileSync(path.join(pageSrc, "App.tsx"), "utf8");
	same(NOT_YET.filter((name) => !new RegExp(`["\`\\s]${name}["\`\\s$]`).test(code)), [], "not-yet classes no longer in the page");
	console.log("  ok  style: no look outside 01-base.css for a family button, and the check finds one");
}

function checkFontFiles(): void {
	const base = fs.readFileSync(path.join(stylesDir, FAMILY_FILE), "utf8");
	const medium = /@font-face\s*\{[^}]*font-family:\s*"Sen";[^}]*font-weight:\s*500;[^}]*src:\s*url\("\/fonts\/(Sen-Medium\.ttf)"\)/.exec(base);
	assert(medium, `${FAMILY_FILE} has an @font-face for Sen at weight 500`);
	assert(fs.statSync(path.join(fontsDir, medium[1])).size > 10_000, `${medium[1]} is in the page's fonts`);
	const licence = fs.readFileSync(path.join(fontsDir, "Sen-OFL.txt"), "utf8");
	assert(licence.includes("The Sen Project Authors") && licence.includes("SIL OPEN FONT LICENSE Version 1.1"), "Sen's licence text sits beside its fonts");
	console.log("  ok  font: Sen Medium and its licence text are in the page's fonts");
}

{
	checkFontFiles();
	checkStyleRules();
	const p = typeof chromium?.executablePath === "function" ? chromium.executablePath() : "";
	if (!p || !fs.existsSync(p)) {
		console.log("buttons look ui smoke: the page half skipped (Chromium not installed)");
		process.exit(0);
	}
}

const port = await freePort();
const baseUrl = `http://127.0.0.1:${port}`;
const tempRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "exxperts-buttons-look-")));
const tempHome = path.join(tempRoot, "home");
const agentsRoot = path.join(tempHome, ".exxperts", "app", "personalized-agents");
const agentDir = path.join(tempHome, ".exxperts", "agent");
const appDir = path.join(tempHome, ".exxperts", "app");
for (const dir of [agentsRoot, agentDir]) fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
process.env.HOME = tempHome;
process.env.USERPROFILE = tempHome;
process.env.EXXPERTS_CODING_AGENT_DIR = agentDir;
process.env.EXXETA_PERSISTENT_AGENTS_ROOT = agentsRoot;

const ROOM = "Look Room";
const SECOND_ROOM = "Second Room";
const SETTINGS_PANES = ["AI setup", "Instructions", "Skills", "Connectors", "Web search", "Appearance", "Remote access", "Profiles"];
const ROOM_PANES = ["Model", "Memory", "Instructions", "Folder", "Skills", "Connectors", "Scheduled tasks", "Conversation", "Archive or delete"];
const LONG_LABEL = "Delete this room and every one of its scheduled tasks, conversations and notes";
// A room's name is the person's own words, with no bound on its length.
const LONG_ROOM = "The quarterly planning room for the northern region's suppliers and every one of their contracts";

const provider = http.createServer((req, res) => {
	req.resume();
	req.on("end", () => {
		const sse = (event: string, payload: unknown) => res.write(`event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`);
		res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
		sse("message_start", { type: "message_start", message: { id: "msg_1", type: "message", role: "assistant", model: "claude-fake", content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 100, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } } });
		sse("content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } });
		sse("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Answer from the model." } });
		sse("content_block_stop", { type: "content_block_stop", index: 0 });
		sse("message_delta", { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 20 } });
		sse("message_stop", { type: "message_stop" });
		res.end();
	});
});

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

// What's new opens on a sign-in after an update: the record says the last
// minor line was seen, so the running line's releases show, and are swept.
let sweptWhatsNew = 0;
function seenOnlyTheLastLine(): void {
	const [major, minor] = (JSON.parse(fs.readFileSync(path.join(repoRoot, "package.json"), "utf8")).version as string).split(".").map(Number);
	fs.writeFileSync(path.join(appDir, "whats-new.json"), JSON.stringify({ acknowledgedVersion: `${major}.${Math.max(minor - 1, 0)}.0` }), { mode: 0o600 });
}
async function signIn(page: Page, where: string, ready = ".persistent-agent-card"): Promise<void> {
	seenOnlyTheLastLine();
	await page.goto(`${baseUrl}/auth/session?token=${SMOKE_AUTH_TOKEN}`);
	await page.locator(ready).first().waitFor({ timeout: 15000 });
	await installTools(page);
	const dismiss = page.locator(".whats-new-close");
	await dismiss.waitFor({ timeout: 15000 });
	// Read once the page has settled: a button whose colour is still easing
	// (the family's 120 ms transition) reads between its two looks.
	await waitUntil(() => page.evaluate(() => document.getAnimations().every((run) => run.playState !== "running")), `${where}: the page settles under What's new`, 5000);
	take(await sweep(page, `${where} What's new`));
	sweptWhatsNew++;
	await dismiss.click();
	await dismiss.waitFor({ state: "detached", timeout: 5000 });
}

const isPhone = (page: Page): boolean => (page.viewportSize()?.width ?? 1280) <= 760;
const navItem = (page: Page, label: string) => page.locator(".settings-dialog-nav-item").filter({ hasText: new RegExp(`^${label}$`) }).first();
const activePane = async (page: Page) => (await page.locator(".settings-dialog-nav-item.active").first().innerText()).trim();

async function goToPane(page: Page, label: string): Promise<void> {
	if (isPhone(page) && await page.locator(".settings-dialog-back").isVisible()) await page.locator(".settings-dialog-back").click();
	await navItem(page, label).click();
	await waitUntil(async () => (await activePane(page)) === label, `the pane ${label} is open`);
	// A pane fills in from its own request: wait until its words stop changing.
	let last = "";
	await waitUntil(async () => {
		const now = await page.locator(".settings-dialog-pane").first().innerText();
		const steady = now === last && !/Loading…|Reading…/.test(now);
		last = now;
		return steady;
	}, `the pane ${label} has settled`);
}

async function closeDialog(page: Page): Promise<void> {
	if (isPhone(page) && await page.locator(".settings-dialog-back").isVisible()) await page.locator(".settings-dialog-back").click();
	await page.locator(".settings-dialog-close").first().click();
	await page.locator(".settings-dialog").first().waitFor({ state: "detached", timeout: 5000 });
}

// The page's own colours flattened to sRGB through a canvas, so a color-mix
// reads the same as a hex, and the contrast of a word against everything
// painted behind it.
async function installTools(page: Page): Promise<void> {
	// tsx wraps the named functions below in a helper the page does not have.
	await page.evaluate("globalThis.__name = (target) => target");
	await page.evaluate(() => {
		type Rgba = [number, number, number, number];
		const context = document.createElement("canvas").getContext("2d", { willReadFrequently: true })!;
		const rgba = (colour: string): Rgba => {
			context.clearRect(0, 0, 1, 1);
			context.fillStyle = colour;
			context.fillRect(0, 0, 1, 1);
			const [r, g, b, a] = context.getImageData(0, 0, 1, 1).data;
			return [r, g, b, a / 255];
		};
		const over = (top: Rgba, under: Rgba): Rgba => [0, 1, 2].map((i) => top[i] * top[3] + under[i] * (1 - top[3])).concat(1) as Rgba;
		const behind = (element: Element): Rgba => {
			const layers: Rgba[] = [];
			for (let at: Element | null = element; at; at = at.parentElement) layers.push(rgba(getComputedStyle(at).backgroundColor));
			return layers.reduceRight<Rgba>((under, top) => over(top, under), [255, 255, 255, 1]);
		};
		const luminance = (colour: Rgba): number => {
			const [r, g, b] = colour.slice(0, 3).map((value) => {
				const c = value / 255;
				return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
			});
			return 0.2126 * r + 0.7152 * g + 0.0722 * b;
		};
		const ratio = (a: Rgba, b: Rgba): number => {
			const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
			return (hi + 0.05) / (lo + 0.05);
		};
		(window as any).__contrast = (element: Element) => {
			const back = behind(element);
			return ratio(over(rgba(getComputedStyle(element).color), back), back);
		};
		// A key hint's words: its colour faded by its own opacity and its boxes' up to its button.
		(window as any).__hint = (element: Element) => {
			const back = behind(element);
			const ink = rgba(getComputedStyle(element).color);
			for (let at: Element | null = element; at; at = at.parentElement) { ink[3] *= parseFloat(getComputedStyle(at).opacity); if (at.matches(".rs-btn")) break; }
			return ratio(over(ink, back), back);
		};
		(window as any).__fill = (element: Element) => rgba(getComputedStyle(element).backgroundColor).join(",");
		(window as any).__colour = (element: Element) => rgba(getComputedStyle(element).color).join(",");
		(window as any).__token = (name: string) => {
			const probe = document.createElement("i");
			probe.style.background = `var(${name})`;
			document.body.append(probe);
			const value = rgba(getComputedStyle(probe).backgroundColor).join(",");
			probe.remove();
			return value;
		};
		(window as any).__clear = (colour: string) => rgba(colour)[3] === 0;
		// How far a button's own fill stands out from what is behind it.
		(window as any).__standOut = (element: Element) => ratio(behind(element), behind(element.parentElement!));
	});
}

type Sweep = { checked: number; bad: string[]; unknown: string[] };

// Every visible button on screen, sorted into the family, the quiet look
// drawn outside it, the excluded and the not yet converted; each family or
// quiet-look button checked against its kind.
async function sweep(page: Page, where: string): Promise<Sweep> {
	await page.mouse.move(0, 0);
	const result = await page.evaluate(({ excluded, quietLooks, ownWords, notYet, touch }) => {
		const contrast = (window as any).__contrast as (element: Element) => number;
		const hint = (window as any).__hint as (element: Element) => number;
		const fill = (window as any).__fill as (element: Element) => string;
		const token = (window as any).__token as (name: string) => string;
		const clear = (window as any).__clear as (colour: string) => boolean;
		const ink = token("--exx-action-primary-bg");
		const red = token("--exx-action-danger-bg");
		const name = (element: Element) => `"${(element.textContent ?? "").trim().slice(0, 40) || element.getAttribute("aria-label")}" (${element.tagName.toLowerCase()}.${String(element.className).trim().split(/\s+/).join(".")})`;
		const out = { checked: 0, bad: [] as string[], unknown: [] as string[] };
		const shown = [...document.querySelectorAll("button, a.rs-btn, [role=button]")].filter((element) => element.getClientRects().length > 0 && getComputedStyle(element).visibility !== "hidden");
		for (const element of shown) {
			const quietLook = element.matches(quietLooks);
			const family = element.classList.contains("rs-btn") || quietLook;
			const kept = element.matches(excluded);
			if (family && kept) { out.bad.push(`${name(element)} is kept out of the family, yet carries rs-btn`); continue; }
			if (kept) continue;
			if (!family) {
				if (!notYet.some((one: string) => element.classList.contains(one))) out.unknown.push(name(element));
				continue;
			}
			out.checked++;
			const style = getComputedStyle(element);
			const box = element.getBoundingClientRect();
			const small = element.classList.contains("rs-btn-sm");
			const height = touch ? 44 : small ? 28 : 32;
			const wrong: string[] = [];
			if (style.fontFamily.split(",")[0].replace(/["']/g, "").trim() !== "Sen") wrong.push(`font ${style.fontFamily}`);
			if (style.fontWeight !== (quietLook ? "400" : "500") || style.fontSize !== "13px") wrong.push(`${style.fontWeight} ${style.fontSize}`);
			if (!["Top", "Right", "Bottom", "Left"].every((side) => clear(style.getPropertyValue(`border-${side.toLowerCase()}-color`)))) wrong.push(`an edge ${style.borderTopColor}`);
			if (style.borderTopLeftRadius !== "8px" || style.borderBottomRightRadius !== "8px") wrong.push(`corners ${style.borderTopLeftRadius}`);
			if (Math.abs(box.height - height) > 0.5) wrong.push(`${box.height} px tall, not ${height}`);
			if (element.classList.contains("rs-btn-icon") && Math.abs(box.width - box.height) > 0.5) wrong.push(`an icon ${box.width}x${box.height}`);
			const primary = element.classList.contains("rs-btn-primary");
			const danger = element.classList.contains("rs-btn-danger");
			if (primary && !danger && fill(element) !== ink) wrong.push(`a main fill ${fill(element)}, not ink ${ink}`);
			if (primary && danger && fill(element) !== red) wrong.push(`a red fill ${fill(element)}, not ${red}`);
			if (element.scrollWidth > element.clientWidth + 0.5 && !element.matches(ownWords)) wrong.push(`words ${element.scrollWidth} px in ${element.clientWidth} px`);
			if (element.scrollHeight > element.clientHeight + 0.5) wrong.push(`contents ${element.scrollHeight} px tall in ${element.clientHeight} px`);
			// An icon sits on the line of its words, centred like them.
			for (const icon of element.querySelectorAll(":scope > svg")) {
				const mark = icon.getBoundingClientRect();
				if (Math.abs(mark.top + mark.height / 2 - (box.top + box.height / 2)) > 1.5) wrong.push(`an icon ${Math.round(mark.top - box.top)} px from the top`);
				// Its words follow at the family's 6 px, with no space of their own.
				const words = icon.nextSibling;
				const first = words?.nodeType === Node.TEXT_NODE ? words.textContent!.search(/\S/) : -1;
				if (words && first >= 0) {
					const glyph = document.createRange();
					glyph.setStart(words, first);
					glyph.setEnd(words, first + 1);
					const gap = glyph.getBoundingClientRect().left - mark.right;
					if (Math.abs(gap - 6) > 1) wrong.push(`words ${gap.toFixed(1)} px from their icon`);
				}
			}
			// Words need 4.5:1; a mark with no words, 3:1.
			const least = element.classList.contains("rs-btn-icon") ? 3 : 4.5;
			if (!(element as HTMLButtonElement).disabled && contrast(element) < least) wrong.push(`words at ${contrast(element).toFixed(2)}:1`);
			// A key hint inside it (Esc, ↵) is words too, read as its fade-in ends;
			// a label's hidden layer (the panel's two-layer keys) is not read.
			for (const key of element.querySelectorAll("kbd")) for (const run of key.getAnimations()) run.finish();
			for (const key of element.querySelectorAll("kbd")) if (!(element as HTMLButtonElement).disabled && key.getClientRects().length && getComputedStyle(key).visibility !== "hidden" && hint(key) < 4.5) wrong.push(`its key hint "${key.textContent}" at ${hint(key).toFixed(2)}:1`);
			if (wrong.length) out.bad.push(`${name(element)}: ${wrong.join("; ")}`);
		}
		// Larger buttons never push a pane or the page sideways.
		const pane = document.querySelector(".settings-dialog-pane");
		const paneSideways = pane ? pane.scrollWidth - pane.clientWidth : 0;
		const pageSideways = document.documentElement.scrollWidth - window.innerWidth;
		if (paneSideways > 0 || pageSideways > 0) out.bad.push(`the pane scrolls ${paneSideways} px and the page ${pageSideways} px sideways`);
		return out;
	}, { excluded: EXCLUDED.join(","), quietLooks: QUIET_LOOK.join(","), ownWords: OWN_WORDS.join(","), notYet: NOT_YET, touch: isPhone(page) });
	result.bad.push(...await checkTouchPlaces(page));
	return { ...result, bad: result.bad.map((line) => `${where}: ${line}`), unknown: result.unknown.map((line) => `${where}: ${line}`) };
}

// The icon buttons that end a head or a bar keep their place at a finger's
// 44 px: their stylesheets pull them past the edge by half the growth from
// the box they had before (`old`, width and height), on the side facing the
// edge and above and below where they set the row's height. `pulled` is the
// element that carries the pull, when not the button itself; `across: false`
// is a button whose side faces a neighbour, never pulled that way; `down:
// false` one that sets no row's height, never pulled up or down. Two
// places keep the family's size with no pull, since pulled to their old box
// a focused ring would run off the screen: a room's top bar (Forget and the
// gear, 1 px from the top) and the gear ending Home's phone bar (at the
// screen's top and right edges).
type TouchPlace = { selector: string; old: [number, number]; pulled?: string; across?: false; down?: false };
const TOUCH_PLACES: TouchPlace[] = [
	{ selector: ".persistent-agent-card .card-gear-btn", old: [28, 28], pulled: ".persistent-agent-header-end" },
	// The settings window's phone bar sizes its close at 44 inside it, its mark matched to back's across the bar (the look's own smoke pins where).
	{ selector: ".settings-dialog-close", old: [32, 32], across: false },
	{ selector: ".artifact-viewer-close", old: [28, 28] },
	{ selector: ".artifact-viewer-back", old: [30, 30] },
	{ selector: ".whats-new-close", old: [30, 30], down: false },
	{ selector: ".help-head > .rs-btn-icon", old: [33, 26] },
];
// The two kept at the family's size, compared with themselves: their taps,
// their neighbours and their ring are still checked.
const KEPT_PLACES = [".topbar-actions > .rs-btn-icon", ".product-sidebar .sidebar-config-gear"].map((selector): TouchPlace => ({ selector, old: [44, 44] }));

// On a phone, each such button on screen: its mark within 1 px of where the
// button at its old box puts it, and its row as tall; every tap at its centre
// and 1 px inside its corners (inside their curve) lands on it; no two tappable boxes in its row
// overlap; a corner tap that reached the first tappable thing under it with
// the old box still does; focused by keyboard, its ring is whole. A button
// under a sheet or a window, or partly under an open menu, is skipped.
// With a mouse, the button keeps its family size and no pull.
async function checkTouchPlaces(page: Page): Promise<string[]> {
	return page.evaluate(({ places, touch }) => {
		const bad: string[] = [];
		const tappable = "button, a[href], [role=button], input, select, textarea";
		const shown = (element: Element) => element.getClientRects().length > 0 && getComputedStyle(element).visibility !== "hidden";
		const hits = (element: Element, x: number, y: number) => { const hit = document.elementFromPoint(x, y); return !!hit && (hit === element || element.contains(hit)); };
		const what = (element: Element | null) => element ? `${element.tagName.toLowerCase()}${[...element.classList].map((name) => `.${name}`).join("")}` : "nothing";
		const missed = (element: Element) => corners(element).filter(([x, y]) => !hits(element, x, y)).map(([x, y]) => what(document.elementFromPoint(x, y)));
		const mark = (button: Element) => {
			const svg = button.querySelector("svg");
			let box: DOMRect;
			if (svg) box = svg.getBoundingClientRect();
			else { const range = document.createRange(); range.selectNodeContents(button); box = range.getBoundingClientRect(); }
			return { x: box.left + box.width / 2, y: box.top + box.height / 2 };
		};
		// The centre, and 1 px inside each corner: inside its curve where the
		// corner is rounded, since a tap outside the curve is not the element's.
		const corners = (element: Element) => {
			const box = element.getBoundingClientRect();
			const radius = parseFloat(getComputedStyle(element).borderTopLeftRadius) || 0;
			const inset = radius * (1 - Math.SQRT1_2) + 1;
			return [[box.left + box.width / 2, box.top + box.height / 2], [box.left + inset, box.top + inset], [box.right - inset, box.top + inset], [box.left + inset, box.bottom - inset], [box.right - inset, box.bottom - inset]];
		};
		const menus = [...document.querySelectorAll("[role=menu]")].filter(shown).map((menu) => ({ menu, at: menu.getBoundingClientRect() }));
		const underMenu = (element: Element) => { const box = element.getBoundingClientRect(); return menus.some(({ menu, at }) => !menu.contains(element) && at.left < box.right && at.right > box.left && at.top < box.bottom && at.bottom > box.top); };
		for (const place of places) {
			// A button under a sheet, a window or its backdrop is out of reach either way, and so is one an open menu covers.
			for (const button of [...document.querySelectorAll(place.selector)].filter((element) => shown(element) && !element.closest("[inert]") && hits(element, mark(element).x, mark(element).y) && !underMenu(element))) {
				const name = `the ${place.selector} button`;
				const pulled = (place.pulled ? button.closest(place.pulled) : button) as HTMLElement;
				const style = getComputedStyle(pulled);
				if (!touch) {
					if (["Top", "Right", "Bottom", "Left"].some((side) => style.getPropertyValue(`margin-${side.toLowerCase()}`) !== "0px")) bad.push(`${name} has a margin with a mouse: ${style.margin}`);
					continue;
				}
				const row = pulled.parentElement!;
				const box = button.getBoundingClientRect();
				// The first tappable thing whose top lies under the box.
				const below = [...document.querySelectorAll(tappable)]
					.filter((element) => shown(element) && !element.closest("[inert]") && !row.contains(element) && !element.contains(button))
					.map((element) => ({ element, at: element.getBoundingClientRect() }))
					.filter(({ at }) => at.top >= box.top && at.top < box.bottom + 1 && at.right > box.left && at.left < box.right && at.width > 2 && at.height > 2)
					.sort((a, b) => a.at.top - b.at.top)[0]?.element;
				const now = { mark: mark(button), row: row.getBoundingClientRect().height, taps: below ? corners(below).slice(1).map(([x, y]) => document.elementFromPoint(x, y)) : [] };
				// The same button at its old box, with no pull.
				const own = button as HTMLElement;
				own.style.setProperty("width", `${place.old[0]}px`, "important");
				own.style.setProperty("height", `${place.old[1]}px`, "important");
				own.style.setProperty("min-width", "0", "important");
				own.style.setProperty("min-height", "0", "important");
				pulled.style.setProperty("margin", "0", "important");
				const then = { mark: mark(button), row: row.getBoundingClientRect().height, taps: below ? corners(below).slice(1).map(([x, y]) => hits(below, x, y)) : [] };
				for (const property of ["width", "height", "min-width", "min-height"]) own.style.removeProperty(property);
				pulled.style.removeProperty("margin");
				if (place.across !== false && Math.abs(now.mark.x - then.mark.x) > 1) bad.push(`${name}'s mark is ${(now.mark.x - then.mark.x).toFixed(1)} px across from its old place`);
				if (place.down !== false && Math.abs(now.mark.y - then.mark.y) > 1) bad.push(`${name}'s mark is ${(now.mark.y - then.mark.y).toFixed(1)} px up or down from its old place`);
				if (Math.abs(now.row - then.row) > 1) bad.push(`${name}'s row is ${now.row} px tall, ${then.row} px with its old box`);
				const lost = missed(button);
				if (lost.length) bad.push(`a tap inside ${name}'s ${box.width} x ${box.height} box lands on ${[...new Set(lost)].join(", ")}`);
				const others = [...row.querySelectorAll(tappable)].filter((element) => shown(element) && element !== button && !element.contains(button) && !button.contains(element));
				for (const other of others) {
					const them = other.getBoundingClientRect();
					if (Math.min(box.right, them.right) - Math.max(box.left, them.left) > 0.5 && Math.min(box.bottom, them.bottom) - Math.max(box.top, them.top) > 0.5) bad.push(`${name}'s box overlaps a tappable neighbour`);
				}
				// Focused by keyboard, its ring stays whole: inside the screen and
				// every box that clips it.
				own.focus({ preventScroll: true, focusVisible: true } as FocusOptions);
				const focused = getComputedStyle(own);
				const ring = focused.outlineStyle === "none" ? 0 : parseFloat(focused.outlineWidth) + parseFloat(focused.outlineOffset);
				own.blur();
				const reach = { left: box.left - ring, right: box.right + ring, top: box.top - ring, bottom: box.bottom + ring };
				if (!ring) bad.push(`${name} showed no focus ring`);
				if (reach.left < -0.5 || reach.top < -0.5 || reach.right > window.innerWidth + 0.5 || reach.bottom > window.innerHeight + 0.5) bad.push(`${name}'s focus ring runs off the screen`);
				for (let at = own.parentElement; at && at !== document.documentElement; at = at.parentElement) {
					const clips = getComputedStyle(at);
					const outer = at.getBoundingClientRect();
					const clip = { left: outer.left + at.clientLeft, top: outer.top + at.clientTop, right: outer.left + at.clientLeft + at.clientWidth, bottom: outer.top + at.clientTop + at.clientHeight };
					const across = clips.overflowX !== "visible" && (reach.left < clip.left - 0.5 || reach.right > clip.right + 0.5);
					const down = clips.overflowY !== "visible" && (reach.top < clip.top - 0.5 || reach.bottom > clip.bottom + 0.5);
					// A rounded clip cuts inside its corners' curve: the ring's own
					// rounded corner must stay inside it.
					const curve = Math.max(0, parseFloat(clips.borderTopRightRadius) - at.clientLeft);
					const bend = (parseFloat(focused.borderTopRightRadius) || 0) + ring;
					const corner = clips.overflowX !== "visible" && curve > 0 && [[1, 1], [-1, 1], [1, -1], [-1, -1]].some(([sx, sy]) => {
						const ringAt = { x: (sx > 0 ? reach.left : reach.right) + sx * bend, y: (sy > 0 ? reach.top : reach.bottom) + sy * bend };
						const clipAt = { x: (sx > 0 ? clip.left : clip.right) + sx * curve, y: (sy > 0 ? clip.top : clip.bottom) + sy * curve };
						const inCorner = sx * (clipAt.x - ringAt.x) > 0 && sy * (clipAt.y - ringAt.y) > 0;
						return inCorner && Math.hypot(clipAt.x - ringAt.x, clipAt.y - ringAt.y) + bend > curve + 0.5;
					});
					if (across || down || corner) bad.push(`${name}'s focus ring is cut by ${what(at)}${corner ? "'s rounded corner" : ""}`);
				}
				// A corner tap that reached it with the old box still does.
				const taken = now.taps.filter((hit, corner) => then.taps[corner] && !(hit && (hit === below || below!.contains(hit))));
				if (taken.length) bad.push(`${name}'s box takes a tap meant for the ${what(below!)} under it (it lands on ${[...new Set(taken.map(what))].join(", ")})`);
			}
		}
		// On a phone a room's top bar keeps one line: the sidebar's button and
		// the way home share the centre of Forget's and the gear's 44 px boxes.
		const bar = [...document.querySelectorAll(".sidebar-toggle-floating, .topbar-home-btn, .topbar-actions > .rs-btn-icon")].filter((element) => shown(element) && !element.closest("[inert]") && hits(element, mark(element).x, mark(element).y));
		const line = bar.map((element) => mark(element).y);
		if (touch && bar.some((element) => element.matches(".topbar-actions > *")) && Math.max(...line) - Math.min(...line) > 1) bad.push(`a room's top bar marks sit ${(Math.max(...line) - Math.min(...line)).toFixed(1)} px apart up and down`);
		return bad;
	}, { places: [...TOUCH_PLACES, ...KEPT_PLACES], touch: isPhone(page) });
}

// A label too long for a phone stops at the edge of its place with "…",
// keeps its full words for a screen reader, and the page never scrolls
// sideways. Delete room has its own line on a phone, as a button with a
// person's own words needs: beside other words a button keeps its width, so
// a short label is never cut. The words are put in by hand: no button of
// this family carries a person's own words yet.
async function checkLongLabel(page: Page, where: string): Promise<void> {
	await goToPane(page, "Archive or delete");
	const button = page.locator(".room-danger-zone .rs-btn-danger");
	const read = await button.evaluate((element, label) => {
		element.textContent = label;
		const box = element.getBoundingClientRect();
		const pane = document.querySelector(".settings-dialog-pane")!;
		const row = element.closest(".settings-row")!;
		return {
			overflow: getComputedStyle(element).textOverflow,
			cut: element.scrollWidth > element.clientWidth,
			inside: box.right <= row.getBoundingClientRect().right + 0.5 && box.right <= window.innerWidth,
			words: element.textContent,
			paneSideways: pane.scrollWidth - pane.clientWidth,
			pageSideways: document.documentElement.scrollWidth - window.innerWidth,
		};
	}, LONG_LABEL);
	same([read.overflow, read.cut, read.inside, read.words], ["ellipsis", true, true, LONG_LABEL], `${where}: a long label ends in "…" inside its row and keeps its words`);
	assert(read.paneSideways <= 0 && read.pageSideways <= 0, `${where}: a long label scrolls the pane ${read.paneSideways} px and the page ${read.pageSideways} px sideways`);
	same(await page.getByRole("button", { name: LONG_LABEL }).count(), 1, `${where}: the long label is the button's name`);
}

async function checkFontLoads(page: Page, where: string): Promise<void> {
	await page.evaluate(() => document.fonts.ready);
	const faces = await page.evaluate(() => [...document.fonts].filter((face) => face.family.replace(/["']/g, "") === "Sen").map((face) => `${face.weight}:${face.status}`));
	assert(faces.includes("500:loaded"), `${where}: Sen 500 is loaded in the page, the faces are ${faces.join(", ")}`);
}

const DEVICES = [["desktop", { width: 1280, height: 800 }], ["phone", { width: 390, height: 844 }]] as const;
const unknown = new Set<string>();
const bad: string[] = [];
let checked = 0;
const take = (one: Sweep) => { checked += one.checked; bad.push(...one.bad); one.unknown.forEach((line) => unknown.add(line.replace(/^[^:]+: /, ""))); };
// Quiet and red-words buttons off their text edge, and the rows seen pulled, by device.
const edgesOff: string[] = [];
const pulled = new Map<string, Set<string>>();
// The settings windows' new look, where a button sits off that edge, by place and width in both themes.
const lookPlaced = new Set<string>();
async function edges(page: Page, where: string): Promise<void> {
	const one = await checkTextEdges(page, where);
	edgesOff.push(...one.bad);
	for (const line of one.look) lookPlaced.add(line.replace(/ (light|dark)\b/, ""));
	for (const row of one.rows) pulled.set(row, (pulled.get(row) ?? new Set()).add(where.split(" ")[0]));
}

// Home before any AI or room: Connect AI is the main action.
async function sweepFirstRun(browser: Browser): Promise<void> {
	for (const [device, viewport] of DEVICES) {
		for (const colorScheme of ["light", "dark"] as const) {
			const context = await browser.newContext({ viewport, colorScheme, hasTouch: device === "phone", isMobile: device === "phone" });
			const page = await context.newPage();
			await signIn(page, `${device} ${colorScheme} first-run`, ".home-connect-card");
			take(await sweep(page, `${device} ${colorScheme} first-run Home`));
			same(await page.locator(".home-connect-card .rs-btn").evaluateAll((buttons) => buttons.map((one) => [one.textContent, one.classList.contains("rs-btn-primary")])), [["Connect AI", true]], `${device} ${colorScheme}: Connect AI is the first run's main action`);
			await context.close();
		}
	}
	console.log("  ok  first-run Home");
}

// An icon-only button centres its mark exactly at each size, whatever the
// font's metrics; a labelled button's icon sits on the middle of its words'
// small letters, within a pixel of the box's centre.
// The buttons are built from the family's own classes: few screens of this
// task carry an icon-only family button yet.
async function checkIconCentring(page: Page, where: string): Promise<void> {
	const off = await page.evaluate(() => {
		const holder = document.createElement("div");
		holder.style.cssText = "position:fixed;left:0;top:0;display:flex;gap:8px;z-index:9999";
		document.body.append(holder);
		const wrong: string[] = [];
		for (const kind of ["rs-btn rs-btn-icon", "rs-btn rs-btn-icon rs-btn-sm", "rs-btn", "rs-btn rs-btn-sm"]) {
			for (const size of [15, 16, 18]) {
				const button = document.createElement("button");
				button.className = kind;
				button.type = "button";
				button.innerHTML = `<svg class="ui-icon" width="${size}" height="${size}" viewBox="0 0 16 16"><path d="M2 8h12" stroke="currentColor"/></svg>`;
				if (!kind.includes("rs-btn-icon")) button.append("Add a folder");
				holder.append(button);
				const box = button.getBoundingClientRect();
				const mark = button.querySelector("svg")!.getBoundingClientRect();
				const vertical = mark.top + mark.height / 2 - (box.top + box.height / 2);
				const sideways = kind.includes("rs-btn-icon") ? mark.left + mark.width / 2 - (box.left + box.width / 2) : 0;
				if (Math.abs(vertical) > (kind.includes("rs-btn-icon") ? 0.5 : 1) || Math.abs(sideways) > 0.5) wrong.push(`${kind} ${box.height} px with a ${size} px icon: ${vertical.toFixed(2)} px down, ${sideways.toFixed(2)} px across`);
			}
		}
		holder.remove();
		return wrong;
	});
	same(off, [], `${where}: icons off the centre of their buttons`);
}

// Memory: its search, a room waiting to be memorized, and a room opened. The
// waiting room's button carries the room's name: a long one ends in "…" inside
// its place, keeps its words for a screen reader, and never pushes the page
// sideways.
async function checkMemory(page: Page, where: string): Promise<void> {
	await page.locator(".list-btn", { hasText: /^Memory$/ }).click();
	const memorize = page.locator(".mem-absorb-rooms .rs-btn", { hasText: "memorize" });
	await memorize.first().waitFor({ timeout: 15000 });
	take(await sweep(page, `${where} Memory`));
	const read = await memorize.first().evaluate((element) => {
		const box = element.getBoundingClientRect();
		const place = element.closest(".mem-absorb-callout")!.getBoundingClientRect();
		return {
			cut: element.scrollWidth > element.clientWidth,
			overflow: getComputedStyle(element).textOverflow,
			inside: box.left >= place.left - 0.5 && box.right <= place.right + 0.5 && box.right <= window.innerWidth,
			pageSideways: document.documentElement.scrollWidth - window.innerWidth,
		};
	});
	assert(read.inside && read.pageSideways <= 0 && read.overflow === "ellipsis", `${where}: the long room's Memorize button stays inside its place, got ${JSON.stringify(read)}`);
	if (isPhone(page)) assert(read.cut, `${where}: on a phone the long room's name is cut with "…"`);
	same(await page.getByRole("button", { name: `${LONG_ROOM}: memorize →` }).count(), 1, `${where}: the button's name keeps the room's whole name`);
	await page.getByRole("button", { name: `Expand ${ROOM}` }).click();
	await page.locator(".mem-detail-actions .mem-close").waitFor({ timeout: 10000 });
	take(await sweep(page, `${where} Memory, a room opened`));
	await edges(page, `${where} Memory, a room opened`);
}

// Files: the room's Attachments, its gallery (with a mouse), and a file an
// old run made, opened in the viewer with Download, Delete and Details in its
// foot: Delete in red words, the others quiet.
async function checkFiles(page: Page, where: string, socket: PageSocket): Promise<void> {
	await page.goto(`${baseUrl}/`);
	const enter = page.locator(".persistent-agent-card").filter({ hasText: ROOM }).getByRole("button", { name: /^(Enter|Resume)$/ });
	await enter.waitFor({ timeout: 15000 });
	await installTools(page);
	await enter.click();
	// The top bar's Forget removes: plain at rest beside the gear, red when reached.
	const bar = page.locator(".topbar-actions");
	await bar.getByRole("button", { name: "Room settings" }).waitFor({ timeout: 10000 });
	await checkIconDanger(page, `${where} the room's Forget`, { plain: bar.getByRole("button", { name: "Room settings" }), danger: bar.getByRole("button", { name: "Forget" }) });
	// A work card's plain ask, as the room asks it: Deny and Allow, with their
	// keys while the focus is on the page and there is a keyboard.
	await waitUntil(() => socket.readies() > 0, `${where}: the room's connection is ready`, 10000);
	socket.send({ type: "ui_request", kind: "confirm", id: `look-ask-${where.replace(" ", "-")}`, title: "Run this command?", message: "echo look" });
	const ask = page.locator(".wk-ask").last();
	const [allow, deny] = [ask.locator(".wk-btn.primary"), ask.locator(".wk-btn:not(.primary)")];
	await allow.waitFor({ timeout: 5000 });
	await page.locator(".messages").click({ position: { x: 4, y: 4 } });
	const keys = async () => [await allow.locator("kbd").allInnerTexts(), await deny.locator("kbd").allInnerTexts()];
	if (!isPhone(page)) await waitUntil(async () => (await keys()).every((one) => one.length > 0), `${where}: the ask's keys show`, 3000);
	const [allowKeys, denyKeys] = await keys();
	same([allowKeys.length > 0, denyKeys], isPhone(page) ? [false, []] : [true, ["Esc"]], `${where}: the ask's key hints`);
	take(await sweep(page, `${where} a work card's ask`));
	await deny.click();
	await allow.waitFor({ state: "detached", timeout: 5000 });
	// On a phone the entry is in the drawer, closed in a room.
	if (isPhone(page)) await page.getByRole("button", { name: "Show sidebar" }).first().click();
	await page.locator(".attachments-entry").click();
	const panel = page.locator(".attachments-panel");
	await panel.locator(".att-card").filter({ hasText: "Old run" }).waitFor({ timeout: 10000 });
	take(await sweep(page, `${where} Attachments`));
	// A card's ⋯ sits over its preview. With a mouse it shows on the card's
	// hover and comes to keyboard focus by Tab from the card, shown; on touch
	// it always shows. Its menu opens from the keyboard and it stays shown.
	const notes = panel.locator(".att-card").filter({ hasText: "Tide notes" });
	const holder = notes.locator(".att-more-holder");
	const shownAs = () => holder.evaluate((one) => getComputedStyle(one).opacity);
	if (!isPhone(page)) {
		await waitUntil(async () => (await shownAs()) === "0", `${where}: the ⋯ hides while the card is not pointed at`, 3000);
		await notes.hover();
		await waitUntil(async () => (await shownAs()) === "1", `${where}: the ⋯ shows on the card's hover`, 3000);
		await page.mouse.move(0, 0);
		await waitUntil(async () => (await shownAs()) === "0", `${where}: the ⋯ hides again`, 3000);
	}
	await notes.locator(".att-open").focus();
	await page.keyboard.press("Tab");
	assert(await notes.locator(".att-more").evaluate((one) => one === document.activeElement), `${where}: Tab from the card reaches its ⋯`);
	await waitUntil(async () => (await shownAs()) === "1", `${where}: the focused ⋯ shows`, 3000);
	await page.keyboard.press("Enter");
	await page.locator(".att-menu").waitFor({ timeout: 5000 });
	take(await sweep(page, `${where} Attachments, a card's menu`));
	same(await shownAs(), "1", `${where}: the ⋯ stays shown while its menu is open`);
	// Delete leaves a toast with Undo, which brings the file back.
	await page.locator(".att-menu").getByRole("menuitem", { name: "Delete" }).click();
	const undo = page.locator(".room-toast").getByRole("button", { name: "Undo" });
	await undo.waitFor({ timeout: 5000 });
	take(await sweep(page, `${where} a toast`));
	await edges(page, `${where} a toast`);
	await undo.click();
	await notes.waitFor({ timeout: 10000 });
	if (!isPhone(page)) {
		await panel.getByRole("button", { name: "Show as a gallery" }).click();
		const gallery = page.locator(".attachments-gallery");
		await gallery.getByRole("button", { name: "Back to the conversation" }).waitFor({ timeout: 5000 });
		take(await sweep(page, `${where} Attachments, the gallery`));
		await gallery.getByRole("button", { name: "Back to the conversation" }).click();
		await panel.waitFor({ timeout: 5000 });
	}
	await panel.locator(".att-card").filter({ hasText: "Old run" }).locator(".att-open").click();
	const foot = page.locator("aside.artifact-viewer .asset-viewer-footer-row");
	await foot.getByRole("button", { name: "Details" }).waitFor({ timeout: 5000 });
	// The viewer slides in: its buttons are read where it settles.
	await waitUntil(() => page.locator("aside.artifact-viewer").evaluate((viewer) => viewer.getAnimations({ subtree: true }).every((run) => run.playState !== "running")), "the viewer settles", 5000);
	take(await sweep(page, `${where} a file in the viewer`));
	await edges(page, `${where} a file in the viewer`);
	const kinds = await foot.locator("button").evaluateAll((buttons) => buttons.map((one) => `${one.textContent!.trim()}: ${["rs-btn-quiet", "rs-btn-danger", "rs-btn-primary"].filter((kind) => one.classList.contains(kind)).join(" ")}`));
	same(kinds, ["Download: rs-btn-quiet", "Delete: rs-btn-danger", "Details: rs-btn-quiet"], `${where}: the viewer's foot`);
}

// The model picker (Room settings, Model; Settings, AI setup) has the quiet
// button's look from its own style file: no edge and no fill at rest; the
// quiet button's fill when pointed at with a mouse, focused by keyboard and
// while its list is open, and its focus ring; a short model's name whole,
// though pulled out to the text edge; its words at 4.5:1 at rest and
// on that fill, an inherited row's grey and the provider after the name
// included (the provider shows only beside a second ready provider, so one
// is put in the trigger for each reading); switched off, its colours at rest
// with no fill and no hand when pointed at, since a read-only picker is where
// a person reads the model (a switched-off copy of each trigger, as a
// read-only device or a shared server's member sees it). Returns how many
// pickers on the pane follow the default.
async function checkModelPick(page: Page, where: string): Promise<number> {
	const picks = page.locator(".settings-dialog-pane .room-model-pick");
	// The pickers wait switched off until the pane's models are read.
	await waitUntil(async () => (await picks.count()) >= 2 && (await page.locator(".settings-dialog-pane .room-model-pick:disabled").count()) === 0, `${where}: the model pickers can be used`, 10000);
	const count = await picks.count();
	assert(count >= 2, `${where}: ${count} model pickers on the pane`);
	type Reading = { fill: string; ring: string; name: number; provider: number; colours: string[] };
	const read = (pick: Locator): Promise<Reading> => pick.evaluate((element) => {
		for (const run of document.getAnimations()) run.finish();
		const contrast = (window as any).__contrast as (element: Element) => number;
		const colour = (window as any).__colour as (element: Element) => string;
		const fill = (window as any).__fill as (element: Element) => string;
		const provider = element.querySelector(".room-model-pick-provider") ?? element.insertBefore(Object.assign(document.createElement("span"), { className: "room-model-pick-provider probe", textContent: "Provider" }), element.querySelector(".disclosure-chevron"));
		const style = getComputedStyle(element);
		const name = element.querySelector(".room-model-pick-name")!;
		const out = { fill: fill(element), ring: `${style.outlineStyle} ${style.outlineWidth} ${style.outlineOffset} ${style.outlineColor}`, name: Number(contrast(name).toFixed(2)), provider: Number(contrast(provider).toFixed(2)), colours: [colour(name), colour(provider)] };
		if (provider.classList.contains("probe")) provider.remove();
		return out;
	});
	// The quiet button's own fill (open, as any quiet button with a menu) and keyboard ring, beside the first picker.
	const quiet = await picks.first().evaluate((element) => {
		const probe = document.createElement("button");
		probe.type = "button";
		probe.className = "rs-btn rs-btn-quiet";
		probe.textContent = "Sort";
		probe.setAttribute("aria-haspopup", "menu");
		probe.setAttribute("aria-expanded", "true");
		element.parentElement!.append(probe);
		for (const run of document.getAnimations()) run.finish();
		const filled = ((window as any).__fill as (element: Element) => string)(probe);
		probe.removeAttribute("aria-expanded");
		probe.focus({ focusVisible: true } as FocusOptions);
		const style = getComputedStyle(probe);
		const ring = `${style.outlineStyle} ${style.outlineWidth} ${style.outlineOffset} ${style.outlineColor}`;
		probe.remove();
		return { fill: filled, ring };
	});
	const clear = (fill: string) => fill.endsWith(",0");
	const readable = (state: string, reading: Reading) => assert(reading.name >= 4.5 && reading.provider >= 4.5, `${where}: a model picker ${state}: its name at ${reading.name}:1 and the provider at ${reading.provider}:1, under 4.5`);
	let inherited = 0;
	const resting: Reading[] = [];
	for (let i = 0; i < count; i++) {
		const pick = picks.nth(i);
		await page.mouse.move(0, 0);
		await pick.evaluate((element) => (element as HTMLElement).blur());
		if (await pick.evaluate((element) => element.classList.contains("inherited"))) inherited++;
		const rest = await read(pick);
		resting.push(rest);
		assert(clear(rest.fill) && rest.ring.startsWith("none"), `${where}: a model picker at rest has the fill ${rest.fill} and the ring ${rest.ring}`);
		const edge = await pick.evaluate((element) => ["top", "right", "bottom", "left"].map((side) => getComputedStyle(element).getPropertyValue(`border-${side}-color`)));
		assert(edge.every((one) => /^(rgba\(0, 0, 0, 0\)|transparent)$/.test(one)), `${where}: a model picker at rest has an edge ${edge.join(" ")}`);
		readable("at rest", rest);
		const cut = await pick.evaluate((element) => { const name = element.querySelector(".room-model-pick-name")!; return name.scrollWidth - name.clientWidth; });
		assert(cut <= 0, `${where}: a model picker cuts a short model's name by ${cut} px`);
		if (isPhone(page)) {
			// On its own line under the label, its words start on the label's edge.
			const off = await pick.evaluate((element) => {
				const words = document.createRange();
				words.selectNodeContents(element.querySelector(".room-model-pick-name")!);
				return Number((words.getBoundingClientRect().left - element.closest(".room-model-row")!.querySelector(".settings-row-label")!.getBoundingClientRect().left).toFixed(1));
			});
			assert(Math.abs(off) <= 1, `${where}: a model picker's words start ${off} px from its label's edge`);
		}
		if (!isPhone(page)) {
			await pick.hover();
			const pointed = await read(pick);
			same(pointed.fill, quiet.fill, `${where}: a model picker pointed at, its fill`);
			readable("pointed at", pointed);
			await page.mouse.move(0, 0);
		}
		await pick.evaluate((element) => (element as HTMLElement).focus({ focusVisible: true } as FocusOptions));
		const focused = await read(pick);
		same([focused.fill, focused.ring], [quiet.fill, quiet.ring], `${where}: a model picker focused by keyboard, its fill and ring`);
		readable("focused by keyboard", focused);
		await pick.click();
		const menu = page.locator(".room-model-menu");
		await menu.waitFor({ timeout: 5000 });
		await page.mouse.move(0, 0);
		const open = await read(pick);
		same(open.fill, quiet.fill, `${where}: a model picker with its list open, its fill`);
		readable("with its list open", open);
		await page.keyboard.press("Escape");
		await menu.waitFor({ state: "detached", timeout: 5000 });
	}
	// Switched off (read-only, or while it saves): a copy of each trigger, as
	// the page draws one (no arrow), reads as that trigger at rest.
	for (let i = 0; i < count; i++) {
		await page.mouse.move(0, 0);
		await picks.nth(i).evaluate((element) => {
			const off = element.cloneNode(true) as HTMLButtonElement;
			off.disabled = true;
			off.dataset.probe = "off";
			off.querySelector(".disclosure-chevron")?.remove();
			element.after(off);
		});
		const off = page.locator(".room-model-pick[data-probe=off]");
		if (!isPhone(page)) await off.hover({ force: true });
		const disabled = await read(off);
		const pointer = await off.evaluate((element) => getComputedStyle(element).cursor);
		await off.evaluate((element) => element.remove());
		await page.mouse.move(0, 0);
		assert(clear(disabled.fill) && pointer === "default", `${where}: a switched-off model picker under the pointer has the fill ${disabled.fill} and the cursor ${pointer}`);
		same(disabled.colours, resting[i].colours, `${where}: a switched-off model picker's words and provider, in its colours at rest`);
		readable("switched off", disabled);
	}
	return inherited;
}

// A room with no folder yet: its notice offers Choose folder and a cross.
async function checkNotice(page: Page, where: string): Promise<void> {
	await page.goto(`${baseUrl}/`);
	const enter = page.locator(".persistent-agent-card").filter({ hasText: SECOND_ROOM }).getByRole("button", { name: /^(Enter|Resume)$/ });
	await enter.waitFor({ timeout: 15000 });
	await installTools(page);
	await enter.click();
	await page.locator(".room-workspace-nudge-dismiss").waitFor({ timeout: 15000 });
	take(await sweep(page, `${where} a room's notice`));
}

// A family button whose menu is open shows it with a fill, icon-only or
// ordinary, on a settings card; closed, it looks like any button of its
// kind. A disclosure toggle (aria-expanded, no menu) never gains the fill.
async function checkOpenLook(page: Page, where: string): Promise<void> {
	const read = await page.evaluate(() => {
		const standOut = (window as any).__standOut as (element: Element) => number;
		const card = document.createElement("div");
		card.className = "settings-rows";
		card.style.cssText = "position:fixed;left:0;top:0;z-index:9999;display:flex;gap:8px;padding:8px;background:var(--panel-2)";
		document.body.append(card);
		const out: Record<string, number> = {};
		for (const [kind, cls] of [["icon", "rs-btn rs-btn-icon"], ["ordinary", "rs-btn"]]) {
			for (const [state, attributes] of [["open menu", { "aria-haspopup": "menu", "aria-expanded": "true" }], ["closed menu", { "aria-haspopup": "menu", "aria-expanded": "false" }], ["plain", {}], ["open disclosure", { "aria-expanded": "true" }]] as const) {
				const button = document.createElement("button");
				button.className = cls;
				button.type = "button";
				button.textContent = kind === "icon" ? "⋯" : "Sort";
				for (const [name, value] of Object.entries(attributes)) button.setAttribute(name, value);
				card.append(button);
				out[`${kind} ${state}`] = Number(standOut(button).toFixed(3));
			}
		}
		card.remove();
		return out;
	});
	for (const kind of ["icon", "ordinary"]) {
		assert(read[`${kind} open menu`] >= 1.06, `${where}: an ${kind} button with its menu open stands out from its card by ${read[`${kind} open menu`]}, under 1.06`);
		same([read[`${kind} closed menu`], read[`${kind} open disclosure`]], [read[`${kind} plain`], read[`${kind} plain`]], `${where}: an ${kind} button with its menu closed, and an open disclosure, look like a plain one`);
	}
}

// The rows that pull a quiet or red-words button out by its inset, so its
// words keep the text edge (01-base.css, --exx-btn-inset). The first that
// holds a button names it.
const PULLED_ROWS = [".connector-remove-group", ".connector-tech-body", ".memory-entry-tools", ".memory-entry-actions", ".memory-entry-confirm", ".room-schedules-delete-confirm", ".memory-history-row", ".room-danger-zone", ".remote-device-actions", ".create-room-actions", ".asset-viewer-footer-row", ".room-toast", ".room-model-row"];

// Where the settings windows' new look sets a quiet or red-words button in
// from the text edge, as its pages were built: a card's own buttons keep its
// padding, a section's small actions their own inset. Pinned so none moves
// unseen; the look's page smokes pin the rest of each page.
const LOOK_PLACED = [
	"desktop Room settings, Archive or delete: \"Delete room\" ends a row 15.0 px from the text edge, not 3.0",
	"desktop Room settings, Conversation: \"Forget\" ends a row 15.0 px from the text edge, not 3.0",
	"desktop Room settings, Memory: \"Hide\" starts a line 11.0 px from the text edge, not 0.0",
	"desktop Room settings, a note's delete confirm: \"Hide\" starts a line 11.0 px from the text edge, not 0.0",
	"desktop Room settings, a task's delete confirm: \"Cancel\" starts a line 5.0 px from the text edge, not 3.0",
	"desktop Room settings, an archived note's delete confirm: \"Hide\" starts a line 11.0 px from the text edge, not 0.0",
	"desktop Settings, a connector's page: \"Copy\" ends a row 11.0 px from the text edge, not 0.0",
	"desktop Settings, a connector's page: \"Remove\" ends a row 15.0 px from the text edge, not 3.0",
	"desktop at 760 px Room settings, Memory: \"Hide\" starts a line 12.0 px from the text edge, not 0.0",
	"phone Room settings, Archive or delete: \"Delete room\" starts a line 17.0 px from the text edge, not 5.0",
	"phone Room settings, Conversation: \"Forget\" starts a line 17.0 px from the text edge, not 5.0",
	"phone Room settings, Memory: \"Hide\" starts a line 12.0 px from the text edge, not 0.0",
	"phone Room settings, a note's delete confirm: \"Hide\" starts a line 12.0 px from the text edge, not 0.0",
	"phone Room settings, a task's delete confirm: \"Cancel\" starts a line 11.0 px from the text edge, not 9.0",
	"phone Room settings, an archived note's delete confirm: \"Hide\" starts a line 12.0 px from the text edge, not 0.0",
	"phone Settings, a connector's page: \"Copy\" ends a row 17.0 px from the text edge, not 5.0",
	"phone Settings, a connector's page: \"Remove\" ends a row 17.0 px from the text edge, not 5.0",
];

// A quiet or red-words button that starts a line under text, or ends a row at
// its right edge, is pulled out by its inset where the nearest box with a side
// a person sees (a fill, a side border, or one that clips) leaves room for the
// inset and its focus ring, and by that box's room less the ring where it does
// not: its words sit the inset less that pull from the text edge, within 1 px.
// Its fill (its box) and focus ring stay inside that box, every box that
// clips, and the screen. The model picker's inset is its own padding (on a
// phone, as small as its pull), and it sits alone in its row's value: its
// line is the row.
async function checkTextEdges(page: Page, where: string): Promise<{ bad: string[]; rows: string[]; look: string[] }> {
	const read = await page.evaluate((rowNames) => {
		const out = { bad: [] as string[], rows: [] as string[], look: [] as string[] };
		const words = (button: Element) => {
			const range = document.createRange();
			range.selectNodeContents(button);
			const rects = [...range.getClientRects()].filter((rect) => rect.width > 0);
			return rects.length ? { left: Math.min(...rects.map((rect) => rect.left)), right: Math.max(...rects.map((rect) => rect.right)) } : null;
		};
		const content = (element: Element) => {
			const style = getComputedStyle(element);
			const box = element.getBoundingClientRect();
			return { left: box.left + parseFloat(style.borderLeftWidth) + parseFloat(style.paddingLeft), right: box.right - parseFloat(style.borderRightWidth) - parseFloat(style.paddingRight) };
		};
		// Inside its edge and any scroll bar.
		const inside = (element: Element) => {
			const left = element.getBoundingClientRect().left + element.clientLeft;
			return { left, right: left + element.clientWidth };
		};
		const seen = (colour: string) => !/^(transparent|rgba\(0, 0, 0, 0\))$/.test(colour);
		const edged = (element: Element) => {
			const style = getComputedStyle(element);
			return seen(style.backgroundColor) || style.overflowX !== "visible" || style.boxShadow !== "none" || (["Left", "Right"] as const).some((side) => parseFloat(style.getPropertyValue(`border-${side.toLowerCase()}-width`)) > 0 && seen(style.getPropertyValue(`border-${side.toLowerCase()}-color`)));
		};
		// The text edge: the content box of the first holder not pulled on that side.
		const holder = (button: Element, side: "marginLeft" | "marginRight") => {
			for (let at = button.parentElement; at; at = at.parentElement) if (parseFloat(getComputedStyle(at)[side]) >= 0) return at;
			return document.body;
		};
		for (const button of document.querySelectorAll<HTMLElement>(".rs-btn.rs-btn-quiet, .rs-btn.rs-btn-danger:not(.rs-btn-primary, .rs-btn-icon), .room-model-pick")) {
			if (!button.getClientRects().length || getComputedStyle(button).visibility === "hidden") continue;
			// Under an open dialog the page is out of reach: it is read with its own screen.
			const modal = document.querySelector("[aria-modal=true]");
			if (modal && !modal.contains(button)) continue;
			// Memory's "Show all" is a bar as wide as its list, its words in the middle: no text edge to keep.
			if (button.matches(".mem-hist-more")) continue;
			const box = button.getBoundingClientRect();
			const text = words(button);
			if (!text) continue;
			// The model picker's inset is its own side's padding: on a phone its
			// words start on the label's edge (41-room-model.css). Any other
			// button's is the inset it sees, which a row may set smaller.
			const own = getComputedStyle(button);
			const insetOf = (side: "Left" | "Right") => button.matches(".room-model-pick") ? parseFloat(own[`padding${side}`]) + parseFloat(own[`border${side}Width`]) : parseFloat(own.getPropertyValue(button.matches(".rs-btn-sm") ? "--exx-btn-inset-sm" : "--exx-btn-inset"));
			const insetLeft = insetOf("Left");
			const insetRight = insetOf("Right");
			const unit = button.closest(".room-model-row > .settings-row-value") ?? button;
			const line = [...unit.parentElement!.children].filter((other) => {
				if (other === unit || !other.getClientRects().length) return false;
				const rect = other.getBoundingClientRect();
				return rect.bottom > box.top + 2 && rect.top < box.bottom - 2;
			});
			const left = content(holder(unit, "marginLeft")).left;
			const right = content(holder(unit, "marginRight")).right;
			const starts = line.every((other) => other.getBoundingClientRect().left >= box.right - 1) && box.left - left < insetLeft + 1;
			const ends = line.every((other) => other.getBoundingClientRect().right <= box.left + 1) && right - box.right < insetRight + 1;
			if (!starts && !ends) continue;
			const name = `"${(button.textContent ?? "").trim().slice(0, 30)}"`;
			out.rows.push(rowNames.find((row) => button.closest(row)) ?? `${name} in ${button.parentElement!.className}`);
			button.focus({ preventScroll: true, focusVisible: true } as FocusOptions);
			const style = getComputedStyle(button);
			const ring = style.outlineStyle === "none" ? 0 : parseFloat(style.outlineWidth) + parseFloat(style.outlineOffset);
			button.blur();
			if (!ring) out.bad.push(`${name} showed no focus ring`);
			let edge: Element = button.parentElement!;
			while (edge.parentElement && !edged(edge)) edge = edge.parentElement;
			const room = inside(edge);
			const want = (inset: number, space: number) => inset - Math.max(0, Math.min(inset, space - ring));
			// The settings windows' new look sets some buttons in from that edge (a card's own buttons, a section's small actions): those are read as where they sit.
			const off = button.closest(".settings-dialog.settings-look-next") ? out.look : out.bad;
			if (starts && Math.abs(text.left - left - want(insetLeft, left - room.left)) > 1) off.push(`${name} starts a line ${(text.left - left).toFixed(1)} px from the text edge, not ${want(insetLeft, left - room.left).toFixed(1)}`);
			if (ends && Math.abs(right - text.right - want(insetRight, room.right - right)) > 1) off.push(`${name} ends a row ${(right - text.right).toFixed(1)} px from the text edge, not ${want(insetRight, room.right - right).toFixed(1)}`);
			const reach = { left: box.left - ring, right: box.right + ring };
			if (reach.left < room.left - 0.5 || reach.right > room.right + 0.5) out.bad.push(`${name}'s fill or focus ring crosses the edge of .${String(edge.className).split(" ")[0]}`);
			if (reach.left < 0 || reach.right > window.innerWidth) out.bad.push(`${name}'s focus ring runs off the screen`);
			for (let at = button.parentElement; at && at !== document.documentElement; at = at.parentElement) {
				if (getComputedStyle(at).overflowX === "visible") continue;
				const clip = inside(at);
				if (reach.left < clip.left - 0.5 || reach.right > clip.right + 0.5) out.bad.push(`${name}'s fill or focus ring is cut by .${String(at.className).split(" ")[0]}`);
			}
		}
		return out;
	}, PULLED_ROWS);
	return { bad: read.bad.map((line) => `${where}: ${line}`), rows: read.rows, look: read.look.map((line) => `${where}: ${line}`) };
}

// An icon that forgets or removes looks like any icon at rest; hovered (with
// a mouse) and focused by keyboard, its mark is the danger red and stands
// out from its own wash by the 3:1 an icon needs. Given a real pair (a plain
// icon and one that removes, side by side) it reads those; otherwise a made-up pair.
async function checkIconDanger(page: Page, where: string, pair?: { plain: Locator; danger: Locator }): Promise<void> {
	if (!pair) await page.evaluate(() => {
		const card = document.createElement("div");
		card.id = "icon-danger";
		card.className = "settings-rows";
		card.style.cssText = "position:fixed;left:0;top:0;z-index:9999;display:flex;gap:8px;padding:8px;background:var(--panel-2)";
		for (const cls of ["rs-btn rs-btn-icon", "rs-btn rs-btn-icon rs-btn-danger"]) {
			const button = document.createElement("button");
			button.className = cls;
			button.type = "button";
			button.textContent = "×";
			button.style.transition = "none";
			card.append(button);
		}
		document.body.append(card);
	});
	const { plain, danger } = pair ?? { plain: page.locator("#icon-danger > button").first(), danger: page.locator("#icon-danger > button").last() };
	// A real button eases between its looks (the family's 120 ms): read it settled.
	const settled = (button: Locator) => waitUntil(() => button.evaluate((element) => element.getAnimations().every((run) => run.playState !== "running")), `${where}: the icon settles`, 5000);
	const read = async (button: Locator) => (await settled(button), button.evaluate((element) => ({ fill: (window as any).__fill(element) as string, mark: (window as any).__colour(element) as string, contrast: (window as any).__contrast(element) as number })));
	const red = await page.evaluate(() => (window as any).__token("--error-text") as string);
	await page.mouse.move(400, 400);
	const [restPlain, restDanger] = [await read(plain), await read(danger)];
	same([restDanger.fill, restDanger.mark], [restPlain.fill, restPlain.mark], `${where}: an icon that removes, at rest, looks like a plain icon`);
	const states: [string, () => Promise<void>][] = [["focused", () => danger.evaluate((element: HTMLElement) => element.focus({ focusVisible: true } as FocusOptions))]];
	if (!isPhone(page)) states.unshift(["hovered", () => danger.hover()]);
	for (const [state, enter] of states) {
		await enter();
		const now = await read(danger);
		same(now.mark, red, `${where}: an icon that removes, ${state}, has a danger red mark`);
		assert(now.fill !== restDanger.fill, `${where}: an icon that removes, ${state}, shows a wash`);
		assert(now.contrast >= 3, `${where}: an icon that removes, ${state}, stands out from its wash by ${now.contrast.toFixed(2)}, under 3`);
		await page.mouse.move(400, 400);
		await danger.evaluate((element: HTMLElement) => element.blur());
	}
	await page.evaluate(() => document.getElementById("icon-danger")?.remove());
}

// Show the archived notes and wait until their buttons are there.
async function showArchive(page: Page): Promise<void> {
	await page.locator(".memory-archive-head .rs-btn").filter({ hasText: /^Show$/ }).click();
	await page.locator(".memory-archive-entries .memory-entry-actions").first().waitFor({ timeout: 10000 });
}

// On the narrowest phone, a Memorize row with both its buttons keeps its words
// whole beside them, or lets the buttons wrap: the words never run under one.
async function checkHistoryRowFit(page: Page, where: string): Promise<void> {
	const viewport = page.viewportSize()!;
	await page.setViewportSize({ width: 360, height: viewport.height });
	const clash = await page.evaluate(([undo, whatChanged]) => {
		const rows = document.querySelector(".settings-dialog-pane .memory-history-rows")!;
		const row = document.createElement("li");
		row.className = "memory-history-row";
		row.id = "history-fit";
		const when = document.createElement("span");
		when.className = "memory-history-when";
		when.textContent = "14 Nov, 00:20";
		const what = document.createElement("span");
		what.className = "memory-history-what";
		what.textContent = "Memorized 3 conversations";
		const button = (label: string, extra: string) => {
			const one = document.createElement("button");
			one.type = "button";
			one.className = `rs-btn rs-btn-quiet rs-btn-sm rs-quiet${extra}`;
			one.textContent = label;
			return one;
		};
		row.append(when, what, button(undo, ""), button(whatChanged, " memory-history-toggle"));
		rows.prepend(row);
		const range = document.createRange();
		range.selectNodeContents(what);
		const words = [...range.getClientRects()].filter((rect) => rect.width > 0);
		const out: string[] = [];
		for (const one of row.querySelectorAll("button")) {
			const box = one.getBoundingClientRect();
			if (words.some((rect) => rect.right > box.left + 0.5 && rect.left < box.right - 0.5 && rect.bottom > box.top + 0.5 && rect.top < box.bottom - 0.5)) out.push(`the words run under "${one.textContent}"`);
		}
		const edge = row.getBoundingClientRect();
		if (words.some((rect) => rect.right > edge.right + 0.5)) out.push("the words run past the row's edge");
		row.remove();
		return out;
	}, [HISTORY_UNDO_LABEL, WHAT_CHANGED_LABEL]);
	await page.setViewportSize(viewport);
	same(clash, [], `${where}: a Memorize row with Undo and What changed at 360 px`);
}

// On a phone, Sort and Arrange's line costs little height: the first card
// starts at most 12 px lower under Home's head than it did when Sort stood
// beside the subtitle (110 px there), while Sort and Arrange stay a finger's
// 44 px, every tap inside them lands on them, neither covers another control,
// and neither reaches up into the subtitle's line, where a pressed wash would
// touch its words.
const PHONE_FIRST_CARD_WITH_SORT_BESIDE = 110;
async function checkSortLineAir(page: Page, where: string): Promise<void> {
	const read = await page.evaluate(() => {
		const tappable = "button, a[href], [role=button], input, select, textarea";
		const hero = document.querySelector(".landing-hero")!.getBoundingClientRect();
		const subtitle = document.querySelector(".landing-hero-head p")!.getBoundingClientRect();
		const firstCard = document.querySelector(".landing-grid > *")!.getBoundingClientRect();
		const words = [...document.querySelectorAll<HTMLElement>(".room-sort-row .room-sort-btn")];
		const others = [...document.querySelectorAll(tappable)].filter((element) => element.getClientRects().length > 0 && !words.some((word) => word === element || word.contains(element)));
		return {
			firstCard: +(firstCard.top - hero.top).toFixed(1),
			words: words.map((word) => {
				const box = word.getBoundingClientRect();
				// The centre, and 1 px inside each corner's curve: a pill's corner is not its own.
				const inset = Math.min(parseFloat(getComputedStyle(word).borderTopLeftRadius) || 0, box.height / 2) * (1 - Math.SQRT1_2) + 1;
				const points = [[box.left + box.width / 2, box.top + box.height / 2], [box.left + inset, box.top + inset], [box.right - inset, box.top + inset], [box.left + inset, box.bottom - inset], [box.right - inset, box.bottom - inset]];
				const missed = points.filter(([x, y]) => { const hit = document.elementFromPoint(x, y); return !hit || !(hit === word || word.contains(hit)); }).length;
				const covers = others.filter((other) => { const them = other.getBoundingClientRect(); return Math.min(box.right, them.right) - Math.max(box.left, them.left) > 0.5 && Math.min(box.bottom, them.bottom) - Math.max(box.top, them.top) > 0.5; }).map((other) => other.className);
				return { text: (word.textContent ?? "").trim(), height: box.height, missed, covers, underSubtitle: +(box.top - subtitle.bottom).toFixed(1) };
			}),
		};
	});
	assert(read.firstCard <= PHONE_FIRST_CARD_WITH_SORT_BESIDE + 12, `${where}: the first card starts ${read.firstCard} px under Home's head, more than 12 px lower than ${PHONE_FIRST_CARD_WITH_SORT_BESIDE}`);
	assert(read.words.length === 2 && read.words.every((word) => Math.abs(word.height - 44) <= 0.5 && word.missed === 0 && word.covers.length === 0), `${where}: Sort and Arrange are each a 44 px tap area that covers no other control, got ${JSON.stringify(read.words)}`);
	assert(read.words.every((word) => word.underSubtitle >= 0), `${where}: Sort and Arrange start under the subtitle's line, got ${JSON.stringify(read.words)}`);
}

async function sweepEveryScreen(browser: Browser): Promise<void> {
	for (const [device, viewport] of DEVICES) {
		for (const colorScheme of ["light", "dark"] as const) {
			const context = await browser.newContext({ viewport, colorScheme, hasTouch: device === "phone", isMobile: device === "phone" });
			const page = await context.newPage();
			const socket = await routePageSocket(page);
			const where = `${device} ${colorScheme}`;
			await signIn(page, where);
			// Two rooms in an order of their own, so Home shows Sort and Arrange.
			await page.locator(".room-sort-arrange").waitFor({ timeout: 10000 });
			take(await sweep(page, `${where} Home`));
			// Sort and Arrange read as words: the quiet kind, no fill at rest.
			const sortRow = page.locator(".room-sort-row .room-sort-btn");
			const fillOf = (button: Locator) => button.evaluate((element) => getComputedStyle(element).backgroundColor);
			same(await sortRow.evaluateAll((all) => all.map((one) => `${(one.textContent ?? "").trim()}: ${one.classList.contains("rs-btn-quiet") ? "quiet" : "not quiet"}`)), ["Sort: Custom ▾: quiet", "Arrange: quiet"], `${where}: Home's Sort and Arrange`);
			same(await sortRow.evaluateAll((all) => all.map((one) => getComputedStyle(one).backgroundColor)), ["rgba(0, 0, 0, 0)", "rgba(0, 0, 0, 0)"], `${where}: Sort and Arrange have no fill at rest`);
			// "Arrange" ends on the head's text edge, or as near as Home's side leaves its focus ring whole (4 px of the 16 on a phone).
			const arrangeEdge = await sortRow.last().evaluate((button) => {
				const range = document.createRange();
				range.selectNodeContents(button);
				const words = range.getBoundingClientRect().right;
				const head = button.closest(".landing-hero-head")!;
				const right = head.getBoundingClientRect().right - parseFloat(getComputedStyle(head).paddingRight);
				const landing = button.closest(".landing")!;
				const inner = landing.getBoundingClientRect().left + landing.clientLeft + landing.clientWidth;
				const inset = parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--exx-btn-inset-sm"));
				return { off: +(right - words).toFixed(1), want: +(inset - Math.max(0, Math.min(inset, inner - right - 4))).toFixed(1), ring: +(inner - button.getBoundingClientRect().right - 4).toFixed(1) };
			});
			assert(Math.abs(arrangeEdge.off - arrangeEdge.want) <= 1 && arrangeEdge.ring >= -0.5, `${where}: "Arrange" ends ${arrangeEdge.off} px from the head's text edge, not ${arrangeEdge.want}, with ${arrangeEdge.ring} px to spare past its ring`);
			// Sort's words stand on the subtitle's last line, on its baseline; on a phone they take a line of their own under it, and the subtitle keeps its two lines at most.
			const head = await page.evaluate(() => {
				const baseline = (element: Element) => { const mark = document.createElement("span"); mark.style.cssText = "display:inline-block;width:0;height:0"; element.append(mark); const at = mark.getBoundingClientRect().bottom; mark.remove(); return at; };
				const subtitle = document.querySelector(".landing-hero-head p")!;
				const range = document.createRange();
				range.selectNodeContents(subtitle);
				return { subtitle: baseline(subtitle), lines: new Set([...range.getClientRects()].filter((rect) => rect.width > 0).map((rect) => Math.round(rect.top))).size, sort: baseline(document.querySelector(".room-sort-row .room-sort-btn")!), arrange: baseline(document.querySelector(".room-sort-arrange")!) };
			});
			assert(Math.abs(head.sort - head.arrange) <= 0.5 && head.lines <= 2 && (isPhone(page) ? head.sort > head.subtitle + 10 : Math.abs(head.sort - head.subtitle) <= 0.5), `${where}: Sort's words on the subtitle's baseline (on a phone, on a line under it) and the subtitle in two lines at most, got ${JSON.stringify(head)}`);
			if (isPhone(page)) await checkSortLineAir(page, where);
			// Sort's menu opens under its trigger, whatever the trigger's height, and the trigger shows it is open.
			const sort = sortRow.first();
			await sort.click();
			const sortMenu = page.locator(".room-sort-menu");
			await sortMenu.waitFor({ timeout: 5000 });
			const [trigger, menu] = [(await sort.boundingBox())!, (await sortMenu.boundingBox())!];
			assert(menu.y >= trigger.y + trigger.height, `${where}: Sort's menu starts ${(trigger.y + trigger.height - menu.y).toFixed(1)} px over its trigger`);
			assert(await fillOf(sort) !== "rgba(0, 0, 0, 0)", `${where}: Sort shows no wash while its menu is open`);
			await sort.click();
			await sortMenu.waitFor({ state: "detached", timeout: 5000 });
			await page.getByRole("button", { name: "Create a new room" }).click();
			await page.locator(".create-room-overlay .create-room-actions").waitFor({ timeout: 5000 });
			take(await sweep(page, `${where} Create room`));
			await page.locator(".create-room-actions").getByRole("button", { name: "Cancel" }).click();
			await page.locator(".create-room-overlay").waitFor({ state: "detached", timeout: 5000 });

			await page.locator(".persistent-agent-card").filter({ hasText: ROOM }).locator(".card-gear-btn").click();
			await page.waitForSelector(".rs-shell", { timeout: 10000 });
			for (const pane of ROOM_PANES) {
				await goToPane(page, pane);
				// Topics start closed: open each, so the notes' own buttons are swept.
				const closed = page.locator(".settings-dialog-pane .memory-topic-head[aria-expanded=false]:visible");
				for (let left = 10; left > 0 && await closed.count(); left--) await closed.first().click();
				if (pane === "Memory") await showArchive(page);
				take(await sweep(page, `${where} Room settings, ${pane}`));
				await edges(page, `${where} Room settings, ${pane}`);
				// The room picks its conversation model; Memory follows the default.
				if (pane === "Model") same(await checkModelPick(page, `${where} Room settings, Model`), 1, `${where}: Room settings, Model's pickers that follow the default`);
				// A second connector waits: like every skill, it is a row with its switch, so neither pane has a picker to open.
				if (pane === "Connectors") {
					const section = page.locator(".settings-dialog-pane .room-connectors-section");
					assert(await section.locator(".room-skills-row input[role=switch]").count() >= 2, `${where}: Room settings, Connectors: the waiting connector has its row and switch`);
					same(await section.getByRole("button", { name: "Enable connectors" }).count(), 0, `${where}: Room settings, Connectors: a picker to open`);
				}
				if (pane === "Memory" && device === "phone") await checkHistoryRowFit(page, where);
				if (pane === "Memory") {
					await page.locator(".settings-dialog-pane .memory-entry-tools .rs-btn-danger").first().click();
					const confirm = page.locator(".settings-dialog-pane .memory-entry-confirm").first();
					await confirm.waitFor({ timeout: 5000 });
					await edges(page, `${where} Room settings, a note's delete confirm`);
					await confirm.getByRole("button", { name: "Keep it" }).click();
					await confirm.waitFor({ state: "detached", timeout: 5000 });
					await page.locator(".memory-archive-entries .memory-entry-actions .rs-btn-danger").first().click();
					const archived = page.locator(".memory-archive-entries .memory-entry-confirm").first();
					await archived.waitFor({ timeout: 5000 });
					await edges(page, `${where} Room settings, an archived note's delete confirm`);
					await archived.getByRole("button", { name: "Keep it" }).click();
					await archived.waitFor({ state: "detached", timeout: 5000 });
				}
				if (pane === "Scheduled tasks") {
					await page.locator(".room-schedules-job-actions .rs-btn-danger").first().click();
					await page.locator(".room-schedules-delete-confirm").waitFor({ timeout: 5000 });
					await edges(page, `${where} Room settings, a task's delete confirm`);
					await page.locator(".room-schedules-delete-confirm .rs-btn-quiet").click();
				}
			}
			await checkFontLoads(page, where);
			await checkIconCentring(page, where);
			await checkOpenLook(page, where);
			await checkIconDanger(page, where);
			// The final danger of a confirm fills red; Cancel is ordinary.
			await goToPane(page, "Archive or delete");
			await page.locator(".room-danger-zone .rs-btn-danger").click();
			const confirm = page.locator(".confirm-dialog-backdrop");
			await confirm.waitFor({ timeout: 5000 });
			take(await sweep(page, `${where} Delete room's confirm`));
			same(await confirm.locator(".rs-btn").evaluateAll((buttons) => buttons.map((one) => one.className)), ["rs-btn", "rs-btn rs-btn-primary rs-btn-danger"], `${where}: the confirm's Cancel and its red fill`);
			await confirm.getByRole("button", { name: "Cancel" }).click();
			await confirm.waitFor({ state: "detached", timeout: 5000 });
			if (device === "phone") await checkLongLabel(page, where);
			await closeDialog(page);

			await page.locator(".product-sidebar-footer button, .home-gear, button[aria-label='Settings']").first().click();
			await page.locator(".sidebar-config-menu").waitFor({ timeout: 5000 });
			take(await sweep(page, `${where} the gear's menu`));
			// Help's guide, from the menu: beside it with a mouse, in place on a phone.
			const help = page.getByRole("menuitem", { name: "Help" });
			if (device === "phone") await help.click();
			else await help.hover();
			await page.getByRole("menuitem", { name: "How it works" }).click();
			await page.locator(".help-head").waitFor({ timeout: 5000 });
			take(await sweep(page, `${where} Help`));
			await page.locator(".help-head").getByRole("button", { name: "Close" }).click();
			await page.locator(".help-head").waitFor({ state: "detached", timeout: 5000 });
			await page.locator(".product-sidebar-footer button, .home-gear, button[aria-label='Settings']").first().click();
			await page.locator(".sidebar-config-menu").waitFor({ timeout: 5000 });
			await page.locator(".sidebar-config-menu button, .sidebar-config-menu a").filter({ hasText: /Settings/ }).first().click();
			await page.waitForSelector(".settings-overlay", { timeout: 10000 });
			for (const pane of SETTINGS_PANES) {
				await goToPane(page, pane);
				take(await sweep(page, `${where} Settings, ${pane}`));
				await edges(page, `${where} Settings, ${pane}`);
				if (pane === "AI setup") {
					await checkModelPick(page, `${where} Settings, AI setup`);
					// A profile's models opened from its ⋯: Remove profile ends the editor's row.
					await page.getByRole("button", { name: "Manage Fake Claude" }).click();
					await page.getByRole("menuitem", { name: "Approve models" }).click();
					const remove = page.locator(".configure-profile-remove");
					await remove.waitFor({ timeout: 5000 });
					take(await sweep(page, `${where} Settings, a profile's models`));
					await edges(page, `${where} Settings, a profile's models`);
					await page.locator(".create-room-actions").getByRole("button", { name: "Cancel" }).click();
					await remove.waitFor({ state: "detached", timeout: 5000 });
				}
				if (pane === "Connectors") {
					// A connector's own page: its fact rows' buttons, Check connection and Remove.
					await page.locator(".connector-item", { hasText: "notes-server" }).locator(".connector-item-hit").click();
					await page.locator(".connector-page").first().waitFor({ timeout: 5000 });
					// It can't connect (its address refuses): Technical details opened, so its Copy is read too.
					await page.locator(".connector-page .connector-tech summary").click();
					await page.locator(".connector-page .connector-tech-body .rs-btn").waitFor({ timeout: 5000 });
					take(await sweep(page, `${where} Settings, a connector's page`));
					await edges(page, `${where} Settings, a connector's page`);
					await page.locator(".connector-page-back").click();
					await page.locator(".connector-list").first().waitFor({ timeout: 5000 });
				}
			}
			await closeDialog(page);
			await checkMemory(page, where);
			await checkFiles(page, where, socket);
			await checkNotice(page, where);
			await context.close();
			console.log(`  ok  ${where}: Home, every Room settings and Settings pane, a confirm, Memory, the files, a toast, a room's notice`);
		}
	}
	// At 760 px with a mouse, a note's buttons fit beside its kind and date, so
	// the row's right pull meets the pane's own side.
	{
		const context = await browser.newContext({ viewport: { width: 760, height: 800 } });
		const page = await context.newPage();
		const where = "desktop at 760 px";
		await signIn(page, where);
		await installTools(page);
		await page.locator(".persistent-agent-card").filter({ hasText: ROOM }).locator(".card-gear-btn").click();
		await page.waitForSelector(".rs-shell", { timeout: 10000 });
		await goToPane(page, "Memory");
		const closed = page.locator(".settings-dialog-pane .memory-topic-head[aria-expanded=false]:visible");
		for (let left = 10; left > 0 && await closed.count(); left--) await closed.first().click();
		await showArchive(page);
		const beside = await page.locator(".memory-entry-head").evaluateAll((heads) => heads.filter((head) => {
			const meta = head.querySelector(".memory-entry-meta")?.getBoundingClientRect();
			const tools = head.querySelector(".memory-entry-tools")?.getBoundingClientRect();
			return meta && tools && tools.top < meta.bottom && tools.bottom > meta.top;
		}).length);
		assert(beside > 0, `${where}: no note's buttons sit beside its kind and date`);
		take(await sweep(page, `${where} Room settings, Memory`));
		await edges(page, `${where} Room settings, Memory`);
		await context.close();
		console.log(`  ok  ${where}: a note's buttons beside its kind and date`);
	}
	assert(sweptWhatsNew >= 8, `What's new was swept at each sign-in, ${sweptWhatsNew} times`);
	same([...unknown].sort(), [], "buttons that are neither family, kept out, nor not yet converted");
	same(bad, [], "family buttons off their kind's look");
	same(edgesOff, [], "quiet and red-words buttons off the text edge, or cut");
	same([...lookPlaced].sort(), [...LOOK_PLACED].sort(), "the new look's buttons set in from the text edge, where");
	same(Object.fromEntries([...pulled].map(([row, seen]) => [row, [...seen].sort()]).sort()), {
		"\"Forget\" in settings-row": ["desktop", "phone"],
		"\"Hide\" in pane-head-actions": ["desktop", "phone"],
		".asset-viewer-footer-row": ["desktop", "phone"],
		".connector-remove-group": ["desktop", "phone"],
		".connector-tech-body": ["desktop", "phone"],
		".create-room-actions": ["desktop", "phone"],
		".memory-entry-actions": ["desktop", "phone"],
		".memory-entry-confirm": ["desktop", "phone"],
		".memory-entry-tools": ["desktop", "phone"],
		".memory-history-row": ["desktop", "phone"],
		".remote-device-actions": ["desktop", "phone"],
		".room-danger-zone": ["desktop", "phone"],
		".room-model-row": ["desktop", "phone"],
		".room-schedules-delete-confirm": ["desktop", "phone"],
		".room-toast": ["desktop", "phone"],
	}, "the rows whose quiet or red-words buttons meet a text edge, where");
	assert(checked > 150, `the sweep checked ${checked} family buttons`);
	console.log(`  ok  ${checked} family buttons swept, every other button sorted`);
}

try {
	// First run: no AI and no room yet, on a server of its own.
	await startServer();
	const firstRun = await chromium.launch();
	try {
		await sweepFirstRun(firstRun);
	} finally {
		await firstRun.close();
	}
	await stopSmokeServer(server);
	server = null;

	await new Promise<void>((resolve) => provider.listen(0, "127.0.0.1", resolve));
	const providerPort = (provider.address() as AddressInfo).port;
	fs.writeFileSync(path.join(agentDir, "models.json"), JSON.stringify({
		providers: { "fake-claude": { name: "Fake Claude", baseUrl: `http://127.0.0.1:${providerPort}`, api: "anthropic-messages", models: [{ id: "claude-fake", name: "Claude Fake", input: ["text"], contextWindow: 200000, maxTokens: 16000, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }] } },
	}), { mode: 0o600 });
	fs.writeFileSync(path.join(agentDir, "auth.json"), JSON.stringify({ "fake-claude": { type: "api_key", key: "synthetic-claude" } }), { mode: 0o600 });
	fs.writeFileSync(path.join(appDir, "custom-ai-profiles.json"), JSON.stringify({ version: 1, profiles: [{ id: "custom-fake-claude", providerId: "fake-claude", label: "Fake Claude", roomModels: ["claude-fake"], learnModel: "claude-fake", reviewMemoryModel: "claude-fake" }] }), { mode: 0o600 });
	fs.writeFileSync(path.join(appDir, "persistent-agent-ai-profile.json"), JSON.stringify({ profileId: "custom-fake-claude" }), { mode: 0o600 });

	const agents = await import("../src/persistent-agents.js");
	const roomModels = await import("../src/room-models.js");
	const lookRoom = agents.createPersistentAgentFromScaffoldInput({ displayName: ROOM, userName: "Synthetic User", preferredUserAddress: "Synthetic User" }).agent.agentId;
	roomModels.writeRoomModels(lookRoom, { conversation: { provider: "fake-claude", model: "claude-fake" } });
	const secondRoom = agents.createPersistentAgentFromScaffoldInput({ displayName: SECOND_ROOM, userName: "Synthetic User", preferredUserAddress: "Synthetic User" }).agent.agentId;
	roomModels.writeRoomModels(secondRoom, { conversation: { provider: "fake-claude", model: "claude-fake" } });
	// A room with a long name, as full of remembered conversations as a room
	// gets (ten), so Memory offers to memorize it.
	const longRoom = agents.createPersistentAgentFromScaffoldInput({ displayName: LONG_ROOM, userName: "Synthetic User", preferredUserAddress: "Synthetic User" }).agent.agentId;
	roomModels.writeRoomModels(longRoom, { conversation: { provider: "fake-claude", model: "claude-fake" } });
	const l1b = path.join(agentsRoot, longRoom, "L1b", "current.md");
	const scaffold = fs.readFileSync(l1b, "utf-8");
	const recent = /^##\s+Recent Context\s*$/m.exec(scaffold);
	assert(recent, "the scaffold has a Recent Context section");
	const pages = Array.from({ length: 10 }, (_, i) => `### RC-${String(i + 1).padStart(4, "0")} | CLOSED | 2026-09-09 | Supplier call ${i + 1}\n\n**Session arc:** Supplier call ${i + 1}.\n\n**Body:**\n- Supplier call ${i + 1}.\n\n**Parked:**\nNone\n`);
	fs.writeFileSync(l1b, `${scaffold.slice(0, recent.index + recent[0].length)}\n\n${pages.join("\n")}`, "utf-8");
	// Eleven remembered conversations in the room's history, one past what
	// Memory lists before its "Show all".
	const saves = (await import("../src/persistent-agent-store.js")).createPersistentAgentInstance(lookRoom).checkpointEventDir();
	fs.mkdirSync(saves, { recursive: true });
	for (let i = 1; i <= 11; i += 1) {
		const checkpointId = `look-save-${i}`;
		fs.writeFileSync(path.join(saves, `${checkpointId}.json`), JSON.stringify({ schemaVersion: 1, operation: "checkpoint", agentId: lookRoom, checkpointId, approvedAt: new Date(Date.UTC(2026, 8, i)).toISOString(), checkpoint: { approvedEntry: { title: `Supplier call ${i}`, chars: 400 } }, result: { estimatedTokens: 1000 + 100 * i } }));
	}
	// A folder that can be read, so Folder shows Change folder, Add a folder and Allow changes.
	const project = path.join(tempHome, "Documents", "Price Check");
	const reference = path.join(tempHome, "Documents", "Reference");
	for (const dir of [project, reference]) fs.mkdirSync(dir, { recursive: true });
	fs.writeFileSync(path.join(agentDir, "mcp.json"), JSON.stringify({ mcpServers: {} }));
	// A paired device, so Remote access shows its Revoke. Its key is made up and never used.
	const paired = new Date().toISOString();
	fs.writeFileSync(path.join(appDir, "remote-devices.json"), JSON.stringify({ devices: [{ id: "look-device", name: "Look Phone", capability: "read-only", keyHash: crypto.createHash("sha256").update("synthetic-device").digest("hex"), createdAt: paired, lastSeenAt: paired, expiresAt: new Date(Date.now() + 30 * 86400000).toISOString() }] }), { mode: 0o600 });

	await startServer();
	const seed = async (method: "POST" | "PUT", route: string, body: unknown): Promise<any> => {
		const answer = await authedFetch(`${baseUrl}${route}`, { method, headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
		const text = await answer.text();
		assert(answer.ok, `seeding ${route}: ${answer.status} ${text}`);
		return text ? JSON.parse(text) : null;
	};
	const room = `/api/persistent-agents/${encodeURIComponent(lookRoom)}`;
	await seed("PUT", "/api/settings/room-order", { mode: "custom", customOrder: [secondRoom, lookRoom, longRoom] });
	await seed("PUT", `${room}/workspace-default`, { root: project, workspaceAccessMode: "bounded" });
	fs.writeFileSync(path.join(agentsRoot, lookRoom, "runtime", "also-allowed.json"), JSON.stringify({ folders: [{ path: reference, access: "read" }], sites: [] }), { mode: 0o600 });
	await seed("POST", `${room}/memory/entries`, { topic: "General", kind: "fact", text: "Reports go out on Fridays.", newTopic: true });
	// A note in the archive, so its Restore and Delete show.
	const archived = await seed("POST", `${room}/memory/entries`, { topic: "General", kind: "fact", text: "Reports went out on Mondays." });
	const dropped = await authedFetch(`${baseUrl}${room}/memory/entries/${encodeURIComponent(archived.entry.id)}`, { method: "DELETE" });
	assert(dropped.ok, `archiving a note: ${dropped.status}`);
	// A pinned practice note: the longest line of a note's kind and date beside its four buttons.
	const practice = await seed("POST", `${room}/memory/entries`, { topic: "General", kind: "practice", text: "Ask before sending a report." });
	await seed("PUT", `${room}/memory/entries/${encodeURIComponent(practice.entry.id)}`, { pinned: true });
	await seed("POST", `${room}/schedules`, { name: "Weekly summary", type: "once", schedule: "+30m", prompt: "Write the weekly summary.", enabled: true });
	await seed("POST", "/api/skills", { id: "plain-words", displayName: "plain-words", description: "A synthetic skill.", instructions: "Answer plainly." });
	await seed("PUT", `${room}/skill-settings`, { action: "enable", name: "plain-words" });
	await seed("POST", "/api/skills", { id: "short-lists", displayName: "short-lists", description: "A second synthetic skill.", instructions: "Answer in short lists." });
	await seed("POST", "/api/mcp/servers", { name: "notes-server", url: "http://127.0.0.1:9/mcp" });
	await seed("POST", "/api/mcp/servers", { name: "files-server", url: "http://127.0.0.1:9/mcp-files" });
	await seed("PUT", `${room}/mcp-connectors`, { action: "grant", name: "notes-server" });
	// Attachments: a picture, a note, and a page an old run left outside the shelf, which can be deleted.
	await seed("POST", `${room}/files`, { filename: "harbour-photo.png", contentBase64: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==" });
	await seed("POST", `${room}/files`, { filename: "tide-notes.md", contentBase64: Buffer.from("# Tide notes\nHigh water at six.\n").toString("base64") });
	const ledgerDir = path.join(agentsRoot, lookRoom, "runtime", "task-ledger");
	fs.mkdirSync(ledgerDir, { recursive: true });
	fs.writeFileSync(path.join(ledgerDir, "tsk-oldrun.json"), JSON.stringify({ schemaVersion: 1, taskId: "tsk-oldrun", roomId: lookRoom, conversationId: "conv-old", templateId: "deck", templateVersion: 1, title: "Old run", startedAt: "2026-10-02T10:00:00.000Z", endedAt: "2026-10-02T10:05:00.000Z", outcome: "orphaned", viewedAt: "2026-10-02T10:06:00.000Z", summary: "A page about the market.", artifacts: [{ relativePath: "tasks/tsk-oldrun/old-run.html", bytes: 52, extension: ".html" }] }));

	const browser = await chromium.launch();
	try {
		// A conversation, so Conversation shows Forget.
		const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
		const page = await context.newPage();
		await signIn(page, "setup");
		await page.locator(".persistent-agent-card").filter({ hasText: ROOM }).getByRole("button", { name: "Enter" }).click();
		await page.locator("textarea").first().fill("Open a conversation.");
		await sendFromBox(page);
		await page.getByText("Answer from the model.").first().waitFor({ timeout: 45000 });
		await page.locator("button.send-btn").waitFor({ timeout: 30000 });
		await context.close();
		await sweepEveryScreen(browser);
	} finally {
		await browser.close();
	}
	console.log("buttons look ui smoke passed");
} finally {
	await stopSmokeServer(server);
	provider.close();
	fs.rmSync(tempRoot, { recursive: true, force: true });
}
