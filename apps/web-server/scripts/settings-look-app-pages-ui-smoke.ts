// The settings windows' new look on Settings' Web search, Appearance, Remote
// access and Profiles pages (47-settings-look-app-pages.css). With the switch
// off, each page renders as before: "Get Tailscale" an ordinary button and the
// data folder's path one chip. Every rule of the page file sits under the
// switch's class, and the page loads it after the look's first file; the
// selectors that checks outside this file read stay on the same elements. With
// the switch on, in both themes: Web search's switch in its row's middle, its
// radio buttons on their titles' middle and the address with Save beside it
// across the column; the saved and the error line as one strip with a dot, on all three pages that show them; Appearance's
// two rows; "Get Tailscale" an ordinary small button while the tunnel is
// missing, with the switches on its edge, the rooms' and devices' rows; Profiles
// as one list, a refused name and the path cut in the middle; and the lines
// that were in colour as soft words after a dot. At 390: the switches on
// their label's line, Save beside the address, "Get Tailscale" 44 tall under its
// help from the left and a device's choice at a finger's size. States the lab cannot reach
// (a tunnel, a device, a second profile, a refused save) are the page's own
// requests answered here, so nothing on the server changes. Set
// LOOK_OFF_READING to a file to keep the switch-off reading (markup and every
// element's computed style) for comparing two builds.
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, type Browser, type Locator, type Page, type Route } from "playwright";
import { authedFetch, SMOKE_SERVER_AUTH_ENV, SMOKE_SERVER_SPAWN_TREE_OPTIONS, smokeHomeEnv, stopSmokeServer, freePort, waitForServer } from "./smoke-server-process.js";
import { answered, assert, closeWindow, contrast, DARK, desktop, goToPage, installColourTools, LIGHT, LOOK_FILE, lookPages, nearColour, notLookPageFilesAfterLook, phone, requestsFromNow, rulesOutsideRoots, same, SWITCH_CLASS, type Theme } from "./settings-look-smoke-parts.js";

{
	const p = typeof chromium?.executablePath === "function" ? chromium.executablePath() : "";
	if (!p || !fs.existsSync(p)) {
		console.log("settings look app pages ui smoke skipped (Chromium not installed)");
		process.exit(0);
	}
}

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const webServerDir = path.resolve(scriptDir, "..");
const repoRoot = path.resolve(webServerDir, "..", "..");
const stylesDir = path.join(repoRoot, "apps", "web-ui", "src", "styles");
const PAGES_FILE = "47-settings-look-app-pages.css";
const port = await freePort();
const baseUrl = `http://127.0.0.1:${port}`;

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "exxperts-settings-look-app-pages-"));
const tempHome = path.join(tempRoot, "home");
const agentsRoot = path.join(tempHome, ".exxperts", "app", "personalized-agents");
const agentDir = path.join(tempHome, ".exxperts", "agent");
for (const dir of [agentsRoot, agentDir]) fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
process.env.HOME = tempHome;
process.env.USERPROFILE = tempHome;
process.env.EXXPERTS_CODING_AGENT_DIR = agentDir;
process.env.EXXETA_PERSISTENT_AGENTS_ROOT = agentsRoot;

const ROOM = "Look Room";
const look = lookPages({ baseUrl, room: ROOM });
const { openPage } = look;

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

// --- The page's own requests, answered here ------------------------------------

const json = (route: Route, body: unknown, status = 200) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
const LONG_PATH = "/Users/alexandra.example/Library/Mobile Documents/com~apple~CloudDocs/Shared with the finance team/exxperts data/profiles-and-rooms";
const LONG_TAIL = "/exxperts data/profiles-and-rooms";
const WINDOWS_PATH = "C:\\Users\\alexandra.example\\OneDrive - Example Company\\Shared with the finance team\\Documents\\exxperts data\\profiles";
const WINDOWS_TAIL = "\\exxperts data\\profiles";
const OFF_STATUS = { enabled: false, address: null, port: 8443, tunnelAddress: null, scheme: null, dnsName: null, tlsFallbackReason: null, degradedReason: null, stateFile: "absent", keepAwake: false };
const ON_STATUS = { ...OFF_STATUS, enabled: true, address: "100.101.102.103", tunnelAddress: "100.101.102.103", scheme: "http", stateFile: "valid", keepAwake: true };
const DEGRADED_STATUS = { ...OFF_STATUS, tunnelAddress: "100.101.102.103", stateFile: "valid", degradedReason: "the tunnel address is gone" };
const ROOMS = [
	{ id: "r1", displayName: "Board papers", exposed: true, bashEnabled: false, writeEnabled: false },
	{ id: "r2", displayName: "Desk Room", exposed: true, bashEnabled: true, writeEnabled: true },
	{ id: "r3", displayName: "Monthly reporting", exposed: false, bashEnabled: false, writeEnabled: false },
];
const ONE_LINE_ROOMS = ROOMS.map((room) => ({ ...room, bashEnabled: false, writeEnabled: false }));
const day = 86_400_000;
const DEVICES = [
	{ id: "d1", name: "Alex's iPhone", capability: "full", createdAt: new Date(Date.now() - 9 * day).toISOString(), lastSeenAt: new Date(Date.now() - 3_600_000).toISOString(), expiresAt: "" },
	{ id: "d2", name: "Work iPad", capability: "read-only", createdAt: new Date(Date.now() - 30 * day).toISOString(), lastSeenAt: new Date(Date.now() - 600_000).toISOString(), expiresAt: "" },
];
const WEB_SEARCH = { provider: "duckduckgo", baseUrl: "", source: "settings", providerSearch: true, webPages: false, saved: { provider: "duckduckgo", baseUrl: "" }, envProvider: null, unreadable: null };
const WEB_SEARCH_SEARXNG = { ...WEB_SEARCH, provider: "searxng", baseUrl: "http://localhost:8080", saved: { provider: "searxng", baseUrl: "http://localhost:8080" } };
const IDLE_ENGINE = { phase: "idle", baseUrl: null, message: null, running: false };
const FAILED_ENGINE = { phase: "error", baseUrl: null, message: "The search engine could not be started.", running: false };
const profilesOf = (dir: string, names = ["client-demo", "archive-2025"]) => ({ active: null, profiles: names.map((name) => ({ name })), home: { dir, defaultDir: dir, source: "default", canMove: true } });
const REFUSED_NAME = "Use letters, numbers and hyphens only.";

type Scene = {
	webSearch?: { payload?: unknown; put?: "ok" | "fail"; engine?: unknown };
	remote?: { status?: unknown; devices?: unknown[]; rooms?: unknown[]; exposure?: "ok" | "fail" };
	profiles?: unknown | "fail";
	/** A folder picked for Move, and the plan for it, answered; nothing is moved. */
	movePlan?: { dir: string; mode: "migrate"; moving: string[] };
};

/** Answers the page's requests for its settings as the scene says, in place of any answers before. */
async function answer(page: Page, scene: Scene): Promise<void> {
	await page.unrouteAll({ behavior: "ignoreErrors" });
	const web = { payload: WEB_SEARCH, put: "ok", engine: IDLE_ENGINE, ...scene.webSearch };
	await page.route("**/api/settings/web-search", (route) => {
		if (route.request().method() === "GET") return json(route, web.payload);
		if (web.put === "fail") return json(route, { error: "The settings file could not be written." }, 500);
		const body = JSON.parse(route.request().postData() ?? "{}");
		const saved = web.payload as typeof WEB_SEARCH;
		return json(route, { ...saved, ...(body.provider ? { provider: body.provider, saved: { provider: body.provider, baseUrl: body.baseUrl ?? saved.saved.baseUrl } } : {}) });
	});
	await page.route("**/api/web-search/searxng/setup", (route) => json(route, web.engine));
	const remote = { status: OFF_STATUS, devices: [], rooms: ROOMS, exposure: "ok", ...scene.remote };
	await page.route("**/api/remote/status", (route) => json(route, remote.status));
	await page.route("**/api/remote/devices", (route) => json(route, { devices: remote.devices }));
	await page.route("**/api/remote/rooms", (route) => json(route, { rooms: remote.rooms }));
	await page.route("**/api/remote/enroll-pending", (route) => json(route, { pending: [] }));
	await page.route("**/api/remote/enroll-code", (route) => json(route, { url: "http://100.101.102.103:8443/pair", expiresAt: new Date(Date.now() + 600_000).toISOString() }));
	await page.route("**/api/remote/rooms/exposure", (route) => remote.exposure === "ok" ? json(route, { ok: true }) : json(route, { error: "The room could not be changed." }, 500));
	const profiles = scene.profiles ?? profilesOf(LONG_PATH);
	await page.route("**/api/settings/state-profile", (route) => profiles === "fail" ? json(route, { error: "The profiles could not be read." }, 500) : json(route, profiles));
	await page.route("**/api/settings/state-profile/create", (route) => json(route, { error: REFUSED_NAME }, 400));
	// No folder picker here: Move offers the typed path, and nothing on this computer opens.
	await page.route("**/api/system/choose-folder", (route) => json(route, scene.movePlan ? { supported: true, cancelled: false, path: scene.movePlan.dir } : { supported: false, cancelled: false, path: null }));
	if (scene.movePlan) { const plan = scene.movePlan; await page.route("**/api/settings/state-home/plan", (route) => json(route, plan)); }
}

const visible = (page: Page, selector: string) => page.locator(selector).filter({ visible: true }).first();
const ROOTS: Record<string, string> = { "Web search": "section[aria-label='Web search']", Appearance: ".settings-segments", "Remote access": "section[aria-label='Remote access']", Profiles: ".state-profiles" };

/** Opens Settings on one of the four pages with the scene's answers, its requests answered and the pointer away.
 * The app reads some of them once as it loads (remote access's state), so the page loads again under the answers. */
async function openOn(page: Page, label: string, scene: Scene = {}): Promise<Locator> {
	await answer(page, scene);
	await page.reload();
	await page.locator(".persistent-agent-card").first().waitFor({ timeout: 15000 });
	await installColourTools(page);
	// The gear itself: with remote access on, the footer's first button is its pill, which opens the window elsewhere.
	requestsFromNow(page);
	await page.locator("button.sidebar-config-gear").filter({ visible: true }).first().click();
	await page.locator(".sidebar-config-menu button, .sidebar-config-menu a").filter({ hasText: /Settings/ }).first().click();
	await page.waitForSelector(".settings-overlay", { timeout: 10000 });
	await goToPage(page, label);
	const pane = visible(page, ".settings-dialog-pane");
	await pane.locator(ROOTS[label]).first().waitFor({ timeout: 10000 });
	await answered(page, `Settings ${label}`);
	await page.mouse.move(5, 5);
	return pane;
}

type Box = { left: number; right: number; top: number; bottom: number; width: number; height: number };
const boxOf = (target: Locator): Promise<Box> => target.evaluate((element) => { const { left, right, top, bottom, width, height } = element.getBoundingClientRect(); return { left, right, top, bottom, width, height }; });
/** A card's text edge on the right: its box less its edge and padding. */
const textEdgeOf = (card: Locator): Promise<number> => card.evaluate((element) => { const style = getComputedStyle(element); return element.getBoundingClientRect().right - parseFloat(style.borderRightWidth) - parseFloat(style.paddingRight); });
const near = (a: number, b: number, what: string, within = 1) => assert(Math.abs(a - b) <= within, `${what}: ${a.toFixed(1)} against ${b.toFixed(1)}`);
const middle = (box: Box) => box.top + box.height / 2;
/** Each row's height between its lines: without the divider above it, or a card's foot drawn under it. */
const rowHeights = (rows: Locator) => rows.evaluateAll((elements) => elements.map((row) => Math.round(row.getBoundingClientRect().height - parseFloat(getComputedStyle(row).borderTopWidth) - parseFloat(getComputedStyle(row).borderBottomWidth))));

/** The colours of the theme's tokens, as a person sees them on the open page. Needs the colour tools openOn installs. */
const tokens = (page: Page) => page.evaluate(() => {
	const w = window as any;
	const dialog = document.querySelector(".settings-dialog")!;
	const read = (name: string) => w.__seen(dialog, getComputedStyle(dialog).getPropertyValue(name).trim());
	return { text: read("--fg"), soft: read("--fg-soft"), muted: read("--muted"), ok: read("--success"), warn: read("--warning"), danger: read("--error") };
});
/** A line's words and its dot: the words' colour and contrast, and the dot's fill and size. Needs the colour tools openOn installs. */
const lineOf = (target: Locator) => target.evaluate((element) => {
	const w = window as any;
	const style = getComputedStyle(element);
	const dot = getComputedStyle(element, "::before");
	return { words: w.__seen(element, style.color) as string, contrast: Number(w.__contrast(element).toFixed(2)), dot: dot.content === "none" ? null : w.__seen(element, dot.backgroundColor) as string, dotSize: [dot.width, dot.height, dot.borderRadius], size: `${style.fontSize}/${style.lineHeight}`, fill: w.__fill(element) as string, behind: w.__fill(element.parentElement!) as string };
});
/** A strip's dot and the first line of its words: their middles, and how many lines the words take. The dot is
 * its ::before, so a zero-wide stand-in with the dot's height, margins and alignment is put beside it and measured. */
const dotAndFirstLine = (target: Locator) => target.evaluate((element) => {
	const dot = getComputedStyle(element, "::before");
	const probe = document.createElement("i");
	Object.assign(probe.style, { display: "block", flex: "0 0 0px", width: "0px", height: dot.height, marginTop: dot.marginTop, marginBottom: dot.marginBottom, marginLeft: `-${getComputedStyle(element).columnGap}`, alignSelf: dot.alignSelf });
	element.prepend(probe);
	const stand = probe.getBoundingClientRect();
	probe.remove();
	const words = [...element.childNodes].find((node) => node.nodeType === Node.TEXT_NODE && node.textContent!.trim())!;
	const range = document.createRange();
	range.selectNodeContents(words);
	const lines = [...range.getClientRects()];
	return { dot: stand.top + stand.height / 2, firstLine: lines[0].top + lines[0].height / 2, lines: new Set(lines.map((line) => Math.round(line.top))).size };
});
const chroma = (hex: string) => { const rgb = [1, 3, 5].map((at) => parseInt(hex.slice(at, at + 2), 16)); return Math.max(...rgb) - Math.min(...rgb); };

/** The ink-filled buttons and links on the open page, as a person sees them. Needs the colour tools openOn installs. */
const INK = { [LIGHT]: "#111111", [DARK]: "#f4f1ec" };
async function inkedOn(page: Page, theme: Theme): Promise<string[]> {
	return page.evaluate((ink) => {
		const w = window as any;
		const pane = [...document.querySelectorAll(".settings-dialog-pane")].find((element) => element.getClientRects().length)!;
		return [...pane.querySelectorAll("button, a.rs-btn")].filter((element) => element.getClientRects().length > 0 && w.__painted(getComputedStyle(element).backgroundColor) && w.__seen(element, getComputedStyle(element).backgroundColor) === ink).map((element) => element.textContent!.trim());
	}, INK[theme]);
}

// --- The page file -------------------------------------------------------------

async function checkRulesUnderSwitch(browser: Browser): Promise<void> {
	const page = await openPage(browser, desktop(1280), "off");
	const roots = [SWITCH_CLASS];
	const css = fs.readFileSync(path.join(stylesDir, PAGES_FILE), "utf8");
	same(await rulesOutsideRoots(page, css, roots), [], `rules in ${PAGES_FILE} outside ${SWITCH_CLASS}`);
	// The check finds a rule outside, in a media query too, and a longer class name is not the root.
	same(await rulesOutsideRoots(page, `.state-profiles .settings-chip { color: red; } ${SWITCH_CLASS}-x .a { color: red; } .settings-dialog .remote-rooms { color: red; } @media (max-width: 760px) { ${SWITCH_CLASS} .a, .b { color: red; } }`, roots), [".state-profiles .settings-chip", `${SWITCH_CLASS}-x .a`, ".settings-dialog .remote-rooms", ".b"], "the check's own probe");
	const imports = [...fs.readFileSync(path.join(repoRoot, "apps", "web-ui", "src", "styles.css"), "utf8").matchAll(/@import "\.\/styles\/([^"]+)";/g)].map((match) => match[1]);
	same(notLookPageFilesAfterLook(imports), [], `the style files after ${LOOK_FILE} that are not the look's page files`);
	assert(imports.indexOf(PAGES_FILE) > imports.indexOf(LOOK_FILE), `${PAGES_FILE} loads after ${LOOK_FILE}`);
	const loaded = await page.evaluate(() => [...document.styleSheets].some((sheet) => [...sheet.cssRules].some((rule) => rule instanceof CSSStyleRule && rule.selectorText.includes(".state-profile-path-head"))));
	assert(loaded, "the page's stylesheet carries the page file's rules");
	await page.context().close();
	console.log(`  ok  every rule of ${PAGES_FILE} sits under ${SWITCH_CLASS}, and it loads after ${LOOK_FILE}`);
}

// --- With the switch off ---------------------------------------------------------

/** A page's markup, with React's generated ids blanked, and every element's computed style, by property name
 * (the browser lists custom properties in no fixed order). */
async function readOffPage(root: Locator) {
	return root.evaluate((element) => {
		const blank = (text: string) => text.replace(/«[^»]*»|:r[0-9a-z]+:/g, "#id");
		const styles = [element, ...element.querySelectorAll("*")].map((one) => {
			const style = getComputedStyle(one);
			return `${one.tagName.toLowerCase()}.${[...one.classList].join(".")} ${[...style].sort().map((name) => `${name}:${style.getPropertyValue(name)}`).join(";")}`;
		});
		return { markup: blank(element.outerHTML), styles: styles.map(blank) };
	});
}

const OFF_PAGES: Array<[string, string, Scene]> = [
	["Web search, DuckDuckGo", "Web search", {}],
	["Web search, SearXNG", "Web search", { webSearch: { payload: WEB_SEARCH_SEARXNG } }],
	["Appearance", "Appearance", {}],
	["Remote access", "Remote access", {}],
	["Profiles", "Profiles", {}],
];

async function checkOff(browser: Browser): Promise<void> {
	const reading: Record<string, unknown> = {};
	for (const [where, options] of [["1440 light", desktop(1440, 900, LIGHT)], ["390 light", phone(LIGHT)]] as const) {
		const page = await openPage(browser, options, "off");
		for (const [name, label, scene] of OFF_PAGES) {
			const pane = await openOn(page, label, scene);
			same(await page.locator(".settings-look-next").count(), 0, `${where}, switch off, ${name}: elements with the look's class`);
			if (label === "Remote access") {
				// Today's "Get Tailscale": the family's ordinary button, a link.
				same(await pane.getByRole("link", { name: "Get Tailscale" }).evaluate((link) => link.className), "rs-btn", `${where}, switch off: Get Tailscale`);
			}
			if (label === "Profiles") {
				// Today's path: one chip holding the whole path as its words.
				same(await pane.locator(".settings-chip").evaluateAll((chips) => chips.map((chip) => [chip.tagName.toLowerCase(), chip.children.length, chip.textContent, chip.getAttribute("title")])), [["code", 0, LONG_PATH, LONG_PATH]], `${where}, switch off: the data folder's path`);
			}
			reading[`${where}, ${name}`] = await readOffPage(pane);
			await closeWindow(page);
		}
		await page.context().close();
	}
	if (process.env.LOOK_OFF_READING) fs.writeFileSync(process.env.LOOK_OFF_READING, JSON.stringify(reading, null, 1));
	console.log(`  ok  switch off: the four pages at 1440 and 390 with no look class, Get Tailscale today's button and the path one chip${process.env.LOOK_OFF_READING ? ` (reading kept in ${process.env.LOOK_OFF_READING})` : ""}`);
}

// --- Selectors that checks outside this file read ---------------------------------

const OUTSIDE_SELECTORS = [".settings-overlay", ".settings-dialog-nav button", "section[aria-label=\"Web search\"]", "section[aria-label=\"Web search\"] .settings-rows", "section[aria-label=\"Web search\"] .settings-row", "section[aria-label=\"Web search\"] .settings-row .settings-row-label", "section[aria-label=\"Web search\"] label.settings-row-choice", "section[aria-label=\"Web search\"] label.settings-row-choice .settings-row-sub", "section[aria-label=\"Web search\"] input[type=radio]", "#web-search-base-url"];

async function checkOutsideSelectors(browser: Browser): Promise<void> {
	const found: Record<string, unknown> = {};
	for (const switchLook of ["off", "on"] as const) {
		const page = await openPage(browser, desktop(1440, 900, LIGHT), switchLook);
		const pane = await openOn(page, "Web search", { webSearch: { payload: WEB_SEARCH_SEARXNG } });
		// An element by its tag and its words; the window by its tag alone, since the look's shell orders its parts differently.
		found[switchLook] = await page.evaluate((selectors) => selectors.map((selector) => [selector, [...document.querySelectorAll(selector)].map((element) => `${element.tagName.toLowerCase()} ${element.querySelector(".settings-dialog-nav") ? "" : (element.textContent ?? "").trim().slice(0, 30)}`)]), OUTSIDE_SELECTORS);
		same([await pane.getByRole("radio").count(), await pane.getByRole("button", { name: "Save" }).count()], [3, 1], `switch ${switchLook}: the three radios and Save`);
		await page.context().close();
	}
	for (const [selector, elements] of found.off as Array<[string, string[]]>) assert(elements.length > 0, `switch off: ${selector} finds nothing`);
	const differ = (found.off as Array<[string, string[]]>).filter(([selector, elements], i) => JSON.stringify(elements) !== JSON.stringify((found.on as Array<[string, string[]]>)[i][1])).map(([selector]) => selector);
	same(differ, [], "the outside checks' selectors that find other elements with the switch on");
	console.log(`  ok  the outside checks' ${OUTSIDE_SELECTORS.length} selectors, the three radios and Save find the same elements with the switch on and off (the Web pages row shows only on a shared server: not seen here)`);
}

// --- With the switch on -----------------------------------------------------------

async function checkWebSearch(browser: Browser): Promise<void> {
	for (const theme of [LIGHT, DARK] as const) {
		const page = await openPage(browser, desktop(1440, 900, theme), "on");
		const at = `${theme}, Web search`;
		const pane = await openOn(page, "Web search", { webSearch: { payload: WEB_SEARCH_SEARXNG } });
		const row = pane.locator("label.settings-row").filter({ has: page.locator(".workspaces-tool-switch") }).first();
		same(await row.getAttribute("data-tall"), "", `${at}: the switch's words run past two lines`);
		near(middle(await boxOf(row.locator(".workspaces-tool-switch"))), middle(await boxOf(row)), `${at}: the switch's middle on its row's`);
		const radios = await pane.locator(".settings-row-choice").evaluateAll((rows) => rows.map((one) => {
			const [radio, title] = [one.querySelector("input")!, one.querySelector(".settings-row-label")!].map((part) => part.getBoundingClientRect());
			return (radio.top + radio.bottom) / 2 - (title.top + title.bottom) / 2;
		}));
		same(radios, [0, 0, 0], `${at}: each radio button's middle under its title's`);
		const field = await boxOf(pane.locator("#web-search-base-url"));
		const save = await boxOf(pane.getByRole("button", { name: "Save" }));
		// The field and Save share the page's column (one form rule, 44).
		near(save.right - field.left, 718, `${at}: the address field and Save across the column`);
		near(middle(save), middle(field), `${at}: Save on the field's line`);
		near(save.left - field.right, 8, `${at}: Save 8 after the field`);
		const label = await boxOf(pane.locator(".web-search-searxng-label"));
		assert(label.bottom <= field.top && label.left === field.left, `${at}: "Address" above the field`);
		const start = await boxOf(pane.getByRole("button", { name: "Start one on this computer" }));
		assert(start.top >= field.bottom && start.left === field.left, `${at}: "Start one on this computer" under the field`);
		same(await inkedOn(page, theme), [], `${at}: ink buttons`);
		await page.context().close();
	}
	console.log("  ok  Web search, both themes: the switch's middle on its row's, the radio buttons' on their titles'; the address field and Save across the column, Save 8 after it, Address above and Start one under it; no ink button");
}

/** The saved or error line on the open page, after `act`. */
async function reportLine(page: Page, which: "saved" | "error", act: () => Promise<void>): Promise<Locator> {
	await act();
	const line = visible(page, `.settings-dialog-pane .archived-rooms-note${which === "error" ? ".workspaces-error" : ":not(.workspaces-error)"}`);
	await line.waitFor({ timeout: 10000 });
	await page.mouse.move(5, 5);
	return line;
}

async function checkReportLines(browser: Browser): Promise<void> {
	const measured: string[] = [];
	for (const theme of [LIGHT, DARK] as const) {
		const page = await openPage(browser, desktop(1440, 900, theme), "on");
		const lines: Array<[string, "saved" | "error", Box, Awaited<ReturnType<typeof lineOf>>, Awaited<ReturnType<typeof dotAndFirstLine>>]> = [];
		const off = (pane: Locator) => pane.getByRole("radio").nth(2).click({ force: true });
		const hide = (pane: Locator) => pane.getByRole("button", { name: "Hidden" }).first().click();
		for (const [label, which, scene, act] of [
			["Web search", "saved", {}, off],
			["Web search", "error", { webSearch: { put: "fail" } }, off],
			["Remote access", "saved", {}, hide],
			["Remote access", "error", { remote: { exposure: "fail" } }, hide],
			["Profiles", "error", { profiles: "fail" }, null],
		] as Array<[string, "saved" | "error", Scene, ((pane: Locator) => Promise<void>) | null]>) {
			const pane = await openOn(page, label, scene);
			const line = await reportLine(page, which, async () => { if (act) await act(pane); });
			lines.push([label, which, await boxOf(line), await lineOf(line), await dotAndFirstLine(line)]);
			if (label === "Profiles") {
				// The one way on, Try again, inside the strip at its right end, on the words' first line.
				const retry = line.getByRole("button", { name: "Try again" });
				same(await retry.count(), 1, `${theme}, Profiles' error line: Try again inside the strip`);
				const [strip, button, placed] = [await boxOf(line), await boxOf(retry), lines.at(-1)![4]];
				near(button.right, strip.right - 8, `${theme}, Profiles' error line: Try again at the strip's right end`);
				near(middle(button), placed.firstLine, `${theme}, Profiles' error line: Try again on the words' line`, 1.5);
			}
			await closeWindow(page);
		}
		const colours = await (async () => { await openOn(page, "Appearance"); const read = await tokens(page); await closeWindow(page); return read; })();
		const at = (label: string, which: string) => `${theme}, ${label}'s ${which} line`;
		// Remote access's saved line takes two lines at 1440, so the dot's place is checked on words that wrap.
		assert(lines.some(([, , , , placed]) => placed.lines > 1), `${theme}: no report line wraps, so the dot's line is not checked`);
		for (const [label, which, box, line, placed] of lines) {
			same([line.words, line.dot, line.dotSize, line.size], [colours.text, which === "saved" ? colours.ok : colours.danger, ["8px", "8px", "50%"], "13px/18px"], `${at(label, which)}: words, dot and size`);
			near(placed.dot, placed.firstLine, `${at(label, which)}: the dot on the words' first line (${placed.lines} lines)`, 1.5);
			assert(line.contrast >= 4.5, `${at(label, which)}: words at ${line.contrast}:1`);
			assert(box.height >= 40 && line.fill !== line.behind, `${at(label, which)}: a strip of at least 40 on its own fill (${box.height}, ${line.fill} on ${line.behind})`);
			measured.push(`${theme} ${label} ${which} ${line.contrast}`);
		}
		// One place and one size: each page's saved and error lines share their box.
		for (const label of ["Web search", "Remote access"]) {
			const [saved, error] = (["saved", "error"] as const).map((which) => lines.find(([l, w]) => l === label && w === which)![2]);
			same([error.left, error.top, error.width], [saved.left, saved.top, saved.width], `${theme}, ${label}: the error line in the saved line's place, as wide`);
		}
		await page.context().close();
	}
	console.log(`  ..  ${measured.join("; ")}`);
	console.log("  ok  saved and error lines, both themes: one strip of at least 40 in one place and width on Web search and Remote access, and Profiles' error line: words in the text colour at 13/18, at least 4.5:1, a green or a red 8 px dot");
}

async function checkAppearance(browser: Browser): Promise<void> {
	for (const theme of [LIGHT, DARK] as const) {
		const page = await openPage(browser, desktop(1440, 900, theme), "on");
		const pane = await openOn(page, "Appearance");
		const card = visible(page, ".settings-dialog-pane .settings-rows");
		const edge = await textEdgeOf(card);
		const rows = await rowHeights(card.locator(".settings-row"));
		same(rows, [64, 64], `${theme}, Appearance: two form rows`);
		for (const end of await pane.locator(".settings-segments").evaluateAll((tracks) => tracks.map((track) => track.getBoundingClientRect().right))) near(end, edge, `${theme}, Appearance: a choice ends on the card's right padding`);
		await page.context().close();
	}
	console.log("  ok  Appearance, both themes: two form rows of 64, each choice ending on the card's right padding");
}

/** A device's Revoke pressed once: the row grows only downward, the access choice and Revoke hold their place, and
 * "Keep it" comes on the question's first line, under Revoke and ending where it ends; on a phone under the question,
 * its words near the name's edge. Keep it then puts the row back. */
async function revokeAsked(page: Page, pane: Locator, at: string, onPhone = false): Promise<void> {
	const row = pane.locator(".remote-device-row").first();
	const placed = () => row.evaluate((element) => {
		const box = (target: Element) => { const { left, right, top, bottom } = target.getBoundingClientRect(); return { left, right, top, bottom }; };
		const buttons = [...element.querySelectorAll(".remote-device-actions > button")];
		return { row: box(element), choice: box(element.querySelector(".remote-capability-seg")!), revoke: box(buttons.at(-1)!), keep: buttons.length > 1 ? box(buttons[0]) : null };
	});
	const before = await placed();
	await row.getByRole("button", { name: "Revoke" }).click();
	const question = row.locator(".remote-device-armed");
	await question.waitFor();
	await page.mouse.move(5, 5);
	const after = await placed();
	same([after.row.top, after.choice], [before.row.top, before.choice], `${at}, Revoke asked: the row's top and the access choice hold their place`);
	if (!onPhone) same(after.revoke, before.revoke, `${at}, Revoke asked: Revoke holds its place`);
	assert(after.row.bottom > before.row.bottom, `${at}, Revoke asked: the row grows downward`);
	const keep = after.keep!;
	if (onPhone) {
		// The two answers on one line under the question: Keep it at the name's edge, the confirming Revoke where
		// Revoke ends at rest.
		const [said, name] = [await boxOf(question), await boxOf(row.locator(".settings-row-label"))];
		assert(keep.top >= said.bottom, `${at}, Revoke asked: Keep it under the question (${keep.top} against ${said.bottom})`);
		same([after.revoke.top, after.revoke.bottom, after.revoke.right], [keep.top, keep.bottom, before.revoke.right], `${at}, Revoke asked: the confirming Revoke on Keep it's line, ending where Revoke ends`);
		const words = await row.getByRole("button", { name: "Keep it" }).evaluate((element) => { const range = document.createRange(); range.selectNodeContents(element); return range.getBoundingClientRect().left; });
		// Pulled as Revoke is on the right: its words as near the name's edge as its focus ring leaves room for.
		assert(words >= name.left - 0.5 && words <= name.left + 8, `${at}, Revoke asked: Keep it's words at ${words} against the name's edge ${name.left}`);
		await row.getByRole("button", { name: "Keep it" }).click();
		await question.waitFor({ state: "detached" });
		return;
	}
	const firstLine = await question.evaluate((element) => { const range = document.createRange(); range.selectNodeContents(element); const line = range.getClientRects()[0]; return line.top + line.height / 2; });
	near((keep.top + keep.bottom) / 2, firstLine, `${at}, Revoke asked: Keep it on the question's first line`, 1.5);
	near(keep.right, after.revoke.right, `${at}, Revoke asked: Keep it ends where Revoke ends`);
	assert(keep.top >= after.revoke.bottom, `${at}, Revoke asked: Keep it under Revoke (${keep.top} against ${after.revoke.bottom})`);
	await row.getByRole("button", { name: "Keep it" }).click();
	await question.waitFor({ state: "detached" });
}

async function checkRemoteAccess(browser: Browser): Promise<void> {
	const measured: string[] = [];
	for (const theme of [LIGHT, DARK] as const) {
		const page = await openPage(browser, desktop(1440, 900, theme), "on");
		const at = `${theme}, Remote access`;
		// The tunnel not found: Get Tailscale an ordinary small button on the switch's edge, no ink on the page.
		let pane = await openOn(page, "Remote access", { remote: { rooms: ONE_LINE_ROOMS } });
		same(await inkedOn(page, theme), [], `${at}, tunnel not found: ink buttons`);
		const tailscale = pane.getByRole("link", { name: "Get Tailscale" });
		same([await tailscale.getAttribute("class"), (await boxOf(tailscale)).height], ["rs-btn rs-btn-sm", 28], `${at}: Get Tailscale, the family's small button`);
		const toggle = pane.locator(".workspaces-tool-switch").first();
		near((await boxOf(tailscale)).right, (await boxOf(toggle)).right, `${at}: Get Tailscale and the switch end on one x`);
		// A row's control in the row's middle; once the help beside it runs long, on the title's line (one row rule, 44).
		const tunnel = pane.locator(".settings-row").filter({ has: page.getByRole("link", { name: "Get Tailscale" }) });
		const tall = (await tunnel.getAttribute("data-tall")) !== null;
		near(middle(await boxOf(tailscale)), middle(await boxOf(tall ? tunnel.locator(".settings-row-label", { hasText: /^Tunnel$/ }) : tunnel)), `${at}: Get Tailscale's middle on ${tall ? "the Tunnel line" : "the row's middle"}`);
		// The fill once the button's fade has ended.
		const fillOf = () => tailscale.evaluate(async (element) => { await Promise.all(element.getAnimations().map((animation) => animation.finished)); return (window as any).__seen(element, getComputedStyle(element).backgroundColor); });
		const rest = await fillOf();
		await tailscale.hover();
		const hover = await fillOf();
		await page.mouse.down();
		const pressed = await fillOf();
		await page.mouse.move(5, 5);
		await page.mouse.up();
		assert(rest !== hover && hover !== pressed && rest !== pressed, `${at}: Get Tailscale at rest ${rest}, under the pointer ${hover}, pressed ${pressed}`);
		await tailscale.focus();
		await page.keyboard.press("Shift");
		same(await tailscale.evaluate((element) => [element.matches(":focus-visible"), getComputedStyle(element).outlineStyle, getComputedStyle(element).outlineWidth]), [true, "solid", "2px"], `${at}: the keyboard's ring on Get Tailscale`);
		measured.push(`${theme} Get Tailscale ${rest} hover ${hover} pressed ${pressed}`);
		// Rooms: names in the text colour while remote access is off, one-line rows 48.
		const colours = await tokens(page);
		const roomRows = pane.locator(".remote-room-row");
		same(await rowHeights(roomRows), [48, 48, 48], `${at}: one-line room rows`);
		same([...new Set(await pane.locator(".remote-room-row .settings-row-label").evaluateAll((labels) => labels.map((label) => (window as any).__seen(label, getComputedStyle(label).color))))], [colours.text], `${at}: room names while remote access is off`);
		// No device: the muted line under the title and no card.
		const empty = pane.locator(".remote-devices:not(.remote-rooms) > .settings-empty");
		same([await empty.innerText(), await pane.locator(".remote-devices:not(.remote-rooms) > .settings-rows").count()], ["No devices are paired yet.", 0], `${at}: no device`);
		const emptyLine = await lineOf(empty);
		same(emptyLine.words, colours.muted, `${at}: the no-device line is muted`);
		assert(emptyLine.contrast >= 4.5, `${at}: the no-device line at ${emptyLine.contrast}:1`);
		await closeWindow(page);
		// A room that runs commands: every room row takes 64.
		pane = await openOn(page, "Remote access");
		same(await rowHeights(pane.locator(".remote-room-row")), [64, 64, 64], `${at}: room rows once a room has its second line`);
		await closeWindow(page);
		// On, with devices: no ink button; the two switches on one x; device rows 64 with the choice and Revoke at one x.
		pane = await openOn(page, "Remote access", { remote: { status: ON_STATUS, devices: DEVICES } });
		same(await inkedOn(page, theme), [], `${at}, tunnel found: ink buttons`);
		await closeWindow(page);
		// On with no device yet: the empty line 12 under the pairing panel.
		pane = await openOn(page, "Remote access", { remote: { status: ON_STATUS } });
		const [panelAlone, emptyUnder] = [await boxOf(pane.locator(".remote-pairing-panel")), await boxOf(pane.locator(".remote-devices:not(.remote-rooms) > .settings-empty"))];
		same(Math.round(emptyUnder.top - panelAlone.bottom), 12, `${at}: no device yet, its line under the pairing panel`);
		await closeWindow(page);
		pane = await openOn(page, "Remote access", { remote: { status: ON_STATUS, devices: DEVICES } });
		const [panel, deviceCard] = [await boxOf(pane.locator(".remote-pairing-panel")), await boxOf(pane.locator(".remote-devices:not(.remote-rooms) > .settings-rows"))];
		same(Math.round(deviceCard.top - panel.bottom), 12, `${at}: the device card under the pairing panel`);
		same(await pane.getByRole("link", { name: "Get Tailscale" }).count(), 0, `${at}, tunnel found: Get Tailscale`);
		const ends = await pane.locator(".settings-rows").first().locator(".workspaces-tool-switch").evaluateAll((switches) => switches.map((element) => element.getBoundingClientRect().right));
		same(ends.length, 2, `${at}: two switches while on`);
		near(ends[0], ends[1], `${at}: the switches end on one x`);
		const devices = await pane.locator(".remote-device-row").evaluateAll((rows) => rows.map((row) => [Math.round(row.getBoundingClientRect().height - parseFloat(getComputedStyle(row).borderTopWidth)), row.querySelector(".remote-capability-seg")!.getBoundingClientRect().left, [...row.querySelectorAll("button")].at(-1)!.getBoundingClientRect().right]));
		same(devices.map(([height]) => height), [64, 64], `${at}: device rows`);
		same(new Set(devices.map(([, left]) => left)).size, 1, `${at}: the access choice at one x (${devices.map(([, left]) => left).join(", ")})`);
		same(new Set(devices.map(([, , right]) => right)).size, 1, `${at}: Revoke at one x`);
		// The access choice in the segmented look: a 32 track, 28 segments, the chosen one lighter than the track, the other not.
		const choice = await pane.locator(".remote-device-row .remote-capability-seg").first().evaluate((track) => {
			const w = window as any;
			const on = track.querySelector("button.on")!;
			const off = track.querySelector("button:not(.on)")!;
			return { track: track.getBoundingClientRect().height, segments: [...track.querySelectorAll("button")].map((button) => button.getBoundingClientRect().height), fills: [w.__fill(on), w.__fill(off), w.__fill(track)] as string[], onWords: Number(w.__contrast(on).toFixed(2)), offWords: Number(w.__contrast(off).toFixed(2)) };
		});
		same([choice.track, choice.segments], [32, [28, 28]], `${at}: the access choice`);
		const [onLight, offLight, trackLight] = choice.fills.map((fill) => contrast(fill, "#000000"));
		same([onLight > trackLight, offLight > trackLight], [true, false], `${at}: the chosen access lighter than the track, the other not (${choice.fills.join(", ")})`);
		nearColour(choice.fills[0], theme === LIGHT ? "#ffffff" : "#565655", `${at}: the access choice's chosen fill`);
		assert(choice.onWords >= 4.5, `${at}: the access choice's chosen words at ${choice.onWords}:1`);
		assert(choice.offWords >= 4.5, `${at}: the access choice's other words at ${choice.offWords}:1`);
		measured.push(`${theme} access choice words ${choice.offWords}`);
		await revokeAsked(page, pane, at);
		await closeWindow(page);
		await page.context().close();
	}
	console.log(`  ..  ${measured.join("; ")}`);
	console.log("  ok  Remote access, both themes: with the tunnel not found Get Tailscale an ordinary small button on the Tunnel line and the switch's edge, with hover, pressed and the ring; room rows 48, or 64 once a room has its second line, names in the text colour while off; no device, the muted line and no card; once on, no ink button, the device card 12 under the pairing panel, the switches on one x, device rows 64 with the access choice and Revoke at one x");
}

async function checkProfiles(browser: Browser): Promise<void> {
	for (const theme of [LIGHT, DARK] as const) {
		const page = await openPage(browser, desktop(1440, 900, theme), "on");
		const at = `${theme}, Profiles`;
		const pane = await openOn(page, "Profiles");
		const list = pane.locator(".state-profiles:not(.settings-group) > .settings-rows");
		const rows = list.locator(":scope > .settings-row");
		same(await rows.count(), 4, `${at}: the standard profile, two more and New profile`);
		const newProfile = rows.last();
		// One list in one box: New profile its last row, with the line every row has above it, and its first row with none.
		const [last, made] = [await boxOf(rows.nth(2)), await boxOf(newProfile)];
		near(made.top, last.bottom, `${at}: New profile follows the list's last row`);
		same(await rows.evaluateAll((elements) => elements.map((row) => parseFloat(getComputedStyle(row).borderTopWidth) > 0 && getComputedStyle(row).borderTopStyle !== "none")), [false, true, true, true], `${at}: a line above every row but the first`);
		const card = await list.evaluate((element) => { const style = getComputedStyle(element); return [style.borderTopWidth, style.borderRadius, (window as any).__seen(element, style.backgroundColor)]; });
		const cardFill = await page.evaluate(() => (window as any).__seen(document.querySelector(".settings-dialog")!, getComputedStyle(document.querySelector(".settings-dialog")!).getPropertyValue("--exx-surface-card").trim()));
		same(card, ["1px", "12px", cardFill], `${at}: the one box`);
		same(await list.evaluate((element) => ["::before", "::after"].map((part) => getComputedStyle(element, part).content)), ["none", "none"], `${at}: no box drawn behind the list`);
		// Two-line rows: each profile's row 64, with or without its buttons.
		same(await rowHeights(rows.filter({ hasNot: page.locator("input") })), [64, 64, 64], `${at}: the profiles' rows`);
		// New profile: the field 160 wide and Create profile 8 after it, at the row's right, its words beside them.
		const restRow = await boxOf(newProfile);
		const field = await boxOf(newProfile.locator("input"));
		const create = await boxOf(newProfile.getByRole("button", { name: "Create profile" }));
		const help = await boxOf(newProfile.locator(".settings-row-sub"));
		same(field.width, 160, `${at}: the name field's width`);
		near(middle(create), middle(field), `${at}: Create profile on the field's line`);
		near(middle(field), middle(await boxOf(newProfile.locator(".settings-row-main"))), `${at}: the name field centred on its words`);
		near(create.left - field.right, 8, `${at}: Create profile 8 after the field`);
		near(create.right, (await boxOf(rows.first())).right, `${at}: Create profile on the card's right padding`);
		assert(help.right <= field.left, `${at}: New profile's help ends before the field (${help.right} against ${field.left})`);
		// "Loaded" on the card's right padding; the other profiles' Switch and Delete each at one x.
		const edge = (await boxOf(rows.first())).right;
		near((await boxOf(rows.first().locator(".settings-row-value"))).right, edge, `${at}: Loaded on the card's right padding`);
		for (const name of ["Switch", "Delete"]) {
			const xs = await rows.getByRole("button", { name, exact: true }).evaluateAll((buttons) => buttons.map((button) => [button.getBoundingClientRect().left, button.getBoundingClientRect().right]));
			same(xs.length, 2, `${at}: two ${name} buttons`);
			same(xs[0], xs[1], `${at}: ${name} at one x`);
		}
		near((await boxOf(rows.nth(1).getByRole("button", { name: "Delete" }))).right, edge, `${at}: Delete ends on the card's right padding`);
		// A refused name: the red edge, and its reason under the field after a red dot.
		await newProfile.getByRole("button", { name: "Create profile" }).click();
		const reason = newProfile.locator(".settings-row-sub.workspaces-error");
		await reason.waitFor();
		await page.mouse.move(5, 5);
		const colours = await tokens(page);
		const input = newProfile.locator("input");
		same(await input.evaluate(async (element) => { await Promise.all(element.getAnimations().map((animation) => animation.finished)); return [element.getAttribute("aria-invalid"), (window as any).__seen(element, getComputedStyle(element).borderTopColor)]; }), ["true", colours.danger], `${at}: the refused field's edge`);
		const line = await lineOf(reason);
		same([await reason.innerText(), line.words, line.dot], [REFUSED_NAME, colours.text, colours.danger], `${at}: the reason's words and dot`);
		assert((await boxOf(reason)).top >= (await boxOf(input)).bottom, `${at}: the reason under the field`);
		const refusedRow = await boxOf(newProfile);
		near((await boxOf(input)).top - refusedRow.top, field.top - restRow.top, `${at}: the field stays where it was when a name is refused`, 0.5);
		// Move with no folder picker: the typed path's field fills its row, as today, not the name field's 160.
		await pane.getByRole("button", { name: "Move", exact: true }).click();
		const typed = pane.getByRole("textbox", { name: "New data folder path" });
		const [typedBox, check] = [await boxOf(typed), await boxOf(pane.getByRole("button", { name: "Check", exact: true }))];
		assert(typedBox.width !== 160, `${at}: the typed path's field takes the name field's 160`);
		near(check.left - typedBox.right, 8, `${at}: Check 8 after the typed path's field`);
		near(check.right, await textEdgeOf(visible(page, ".state-profiles.settings-group .settings-rows")), `${at}: the typed path's field and Check fill their row to the card's right padding`);
		await closeWindow(page);
		// Move pressed once, with a folder picked and its plan: the path and its help keep their place, no narrower, and the
		// question's two buttons come on a line of their own under it, ending on the card's right padding. Never the second press.
		const moving = await openOn(page, "Profiles", { movePlan: { dir: "/Users/alexandra.example/Documents/exxperts data", mode: "migrate", moving: [".exxperts", ".exxperts-client-demo"] } });
		const folderCard = visible(page, ".state-profiles.settings-group .settings-rows");
		const [chipAtRest, helpAtRest] = [await boxOf(moving.locator(".settings-chip")), await boxOf(folderCard.locator(".settings-row-sub").first())];
		await moving.getByRole("button", { name: "Move", exact: true }).click();
		const confirmMove = moving.getByRole("button", { name: "Move and reload" });
		await confirmMove.waitFor();
		await page.mouse.move(5, 5);
		const [chipAsked, helpAsked] = [await boxOf(moving.locator(".settings-chip")), await boxOf(folderCard.locator(".settings-row-sub").first())];
		same([chipAsked.left, chipAsked.top, helpAsked.left, helpAsked.top], [chipAtRest.left, chipAtRest.top, helpAtRest.left, helpAtRest.top], `${at}, Move asked: the path and its help keep their place`);
		assert(chipAsked.width >= chipAtRest.width && helpAsked.width >= helpAtRest.width, `${at}, Move asked: the path and its help no narrower than at rest (${chipAsked.width}, ${helpAsked.width} against ${chipAtRest.width}, ${helpAtRest.width})`);
		const [asked, keepMove, moveBox] = [await boxOf(folderCard.locator(".state-profile-asking")), await boxOf(moving.getByRole("button", { name: "Keep it" })), await boxOf(confirmMove)];
		assert(keepMove.top >= asked.bottom && moveBox.top >= asked.bottom, `${at}, Move asked: Keep it and Move and reload under the question (${keepMove.top}, ${moveBox.top} against ${asked.bottom})`);
		near(moveBox.right, await textEdgeOf(folderCard), `${at}, Move asked: Move and reload ends on the card's right padding`);
		await closeWindow(page);
		// Nineteen profiles: every one in the list's box, New profile still its last row.
		const many = await openOn(page, "Profiles", { profiles: profilesOf(LONG_PATH, Array.from({ length: 19 }, (_, i) => `client-${i + 1}`)) });
		const tops = await many.locator(".state-profiles:not(.settings-group) > .settings-rows > .settings-row").evaluateAll((elements) => elements.map((row) => [row.getBoundingClientRect().top, row.getBoundingClientRect().bottom]));
		same(tops.length, 21, `${at}, nineteen profiles: rows`);
		same(tops.slice(1).every(([top], i) => top >= tops[i][1] - 1), true, `${at}, nineteen profiles: the rows in their order`);
		near(tops[20][0], tops[19][1], `${at}, nineteen profiles: New profile follows the last one`);
		await closeWindow(page);
		await page.context().close();
	}
	console.log("  ok  Profiles, both themes: one list in one box, a line above every row but the first, New profile its last row; the name field 160 with Create profile 8 after it at the right, beside the help; Loaded and Delete on the card's right padding, Switch and Delete each at one x; a refused name: the red edge and its reason under the field after a red dot; the typed data folder path's field filling its row to Check on the card's padding; nineteen profiles all in the list's box");
}

async function checkDataFolderPath(browser: Browser): Promise<void> {
	for (const [where, options, dir, tail] of [["1440 light", desktop(1440, 900, LIGHT), LONG_PATH, LONG_TAIL], ["1440 light, a Windows path", desktop(1440, 900, LIGHT), WINDOWS_PATH, WINDOWS_TAIL], ["390 light", phone(LIGHT), LONG_PATH, LONG_TAIL]] as const) {
		const page = await openPage(browser, options, "on");
		const pane = await openOn(page, "Profiles", { profiles: profilesOf(dir) });
		const chip = pane.locator(".settings-chip");
		const read = await chip.evaluate((element) => {
			const style = getComputedStyle(element);
			const head = element.querySelector(".state-profile-path-head") as HTMLElement;
			const tailPart = element.querySelector(".state-profile-path-tail") as HTMLElement;
			const card = element.closest(".settings-rows")!;
			const column = element.closest(".settings-dialog-pane")!;
			return {
				face: [style.fontFamily.includes("monospace"), style.fontSize, style.lineHeight, style.whiteSpace],
				height: element.getBoundingClientRect().height,
				headCut: head.scrollWidth > head.clientWidth,
				// Whole: drawn at its natural width to the fraction, since any shrink at all draws its "…".
				tail: [tailPart.getAttribute("data-text"), (() => { const drawn = tailPart.getBoundingClientRect().width; const kept = tailPart.style.cssText; tailPart.style.flex = "none"; tailPart.style.maxWidth = "none"; const natural = tailPart.getBoundingClientRect().width; tailPart.style.cssText = kept; return drawn >= natural - 0.01; })(), tailPart.getBoundingClientRect().right <= element.getBoundingClientRect().right],
				title: element.getAttribute("title"),
				read: [...element.children].filter((child) => child.getAttribute("aria-hidden") !== "true").map((child) => child.textContent),
				cardInColumn: card.getBoundingClientRect().right <= column.getBoundingClientRect().right - parseFloat(getComputedStyle(column).paddingRight) + 0.5,
			};
		});
		same(read.face, [true, "13px", "20px", "nowrap"], `${where}: the path's face`);
		same(read.height, 20, `${where}: the path on one line`);
		same([read.headCut, read.tail, read.title, read.read, read.cardInColumn], [true, [tail, true, true], dir, [dir], true], `${where}: cut in the middle, its last two parts whole, whole in its tip and to a screen reader, the card in the column`);
		const snapshot = await chip.ariaSnapshot();
		assert(snapshot.includes(dir) && !snapshot.includes("…"), `${where}: what a screen reader gets: ${snapshot}`);
		// A selection of the path copies it whole, once.
		await chip.click({ clickCount: 3 });
		same(await page.evaluate(() => getSelection()!.toString().trim()), dir, `${where}: the path a selection copies`);
		if (where.startsWith("390")) {
			// Nothing scrolls sideways on any of the four pages.
			for (const label of ["Profiles", "Web search", "Appearance", "Remote access"]) {
				if (label !== "Profiles") { await closeWindow(page); await openOn(page, label, label === "Web search" ? { webSearch: { payload: WEB_SEARCH_SEARXNG, engine: FAILED_ENGINE } } : { remote: { status: ON_STATUS, devices: DEVICES } }); }
				same((await page.locator(".settings-dialog-nav-item.active").first().textContent())?.trim(), label, "390: the page measured");
				same(await page.evaluate(() => { const pane = [...document.querySelectorAll(".settings-dialog-pane")].find((element) => element.getClientRects().length)!; return [pane.scrollWidth - pane.clientWidth, document.documentElement.scrollWidth - window.innerWidth]; }), [0, 0], `390, ${label}: sideways scroll`);
			}
		}
		await page.context().close();
	}
	// Last two parts wider than the line: the tail gives way too, with its own "…", and nothing passes the line's edge.
	{
		const page = await openPage(browser, phone(LIGHT), "on");
		const longEnds = "/Users/alexandra.example/quarterly-reporting-for-the-finance-team-2025/board-papers-and-minutes-archive";
		const pane = await openOn(page, "Profiles", { profiles: profilesOf(longEnds) });
		const ends = await pane.locator(".settings-chip").evaluate((element) => {
			const tail = element.querySelector(".state-profile-path-tail") as HTMLElement;
			const inner = element.getBoundingClientRect().right - parseFloat(getComputedStyle(element).paddingRight);
			return [tail.scrollWidth > tail.clientWidth, getComputedStyle(tail).textOverflow, tail.getBoundingClientRect().right <= inner + 0.5];
		});
		same(ends, [true, "ellipsis", true], "390, last two parts wider than the line: the tail cut with its own ellipsis, inside the line");
		await page.context().close();
	}
	console.log("  ok  the data folder: the path in the code face at 13/20 on one line, cut in the middle with its last two parts whole (slashes and backslashes), whole in its tip, to a screen reader and in a selection, the card in the column; ends too long for the line cut with their own ellipsis; at 390 none of the four pages scrolls sideways");
}

async function checkStateLines(browser: Browser): Promise<void> {
	const measured: string[] = [];
	for (const theme of [LIGHT, DARK] as const) {
		const page = await openPage(browser, desktop(1440, 900, theme), "on");
		await openOn(page, "Appearance");
		const colours = await tokens(page);
		await closeWindow(page);
		const cases: Array<[string, string, Scene, string, string, ((pane: Locator) => Promise<void>) | null, string | null]> = [
			["the tunnel degraded", "Remote access", { remote: { status: DEGRADED_STATUS } }, ".remote-hint-degraded", colours.warn, null, null],
			["a failed engine start", "Web search", { webSearch: { payload: WEB_SEARCH_SEARXNG, engine: FAILED_ENGINE } }, ".web-search-searxng-status.failed", colours.warn, null, null],
			["a device's Revoke asked", "Remote access", { remote: { status: ON_STATUS, devices: DEVICES } }, ".remote-device-armed", colours.danger, (pane) => pane.getByRole("button", { name: "Revoke" }).first().click(), ".remote-device-row"],
			["a profile's Delete asked", "Profiles", {}, ".room-danger-armed", colours.danger, (pane) => pane.getByRole("button", { name: "Delete" }).first().click(), ".settings-row"],
		];
		for (const [name, label, scene, selector, dot, act, rowSelector] of cases) {
			const at = `${theme}, ${name}`;
			const pane = await openOn(page, label, scene);
			if (act) await act(pane);
			const line = visible(page, `.settings-dialog-pane ${selector}`);
			await line.waitFor({ timeout: 10000 });
			await page.mouse.move(5, 5);
			const read = await lineOf(line);
			same([read.words, read.dot, read.dotSize], [colours.soft, dot, ["8px", "8px", "50%"]], `${at}: soft words after a dot of its colour`);
			assert(read.contrast >= 4.5, `${at}: words at ${read.contrast}:1`);
			measured.push(`${theme} ${name} ${read.contrast}`);
			if (rowSelector) {
				const row = line.locator(`xpath=ancestor::*[contains(concat(' ', normalize-space(@class), ' '), ' ${rowSelector.slice(1)} ')][1]`);
				same(await row.evaluate((element) => getComputedStyle(element).backgroundColor), "rgba(0, 0, 0, 0)", `${at}: the row's tint`);
				const confirm = row.locator("button.rs-btn-danger");
				const red = await confirm.evaluate((element) => (window as any).__seen(element, getComputedStyle(element).color));
				assert(chroma(red) > 24 && parseInt(red.slice(1, 3), 16) > parseInt(red.slice(3, 5), 16), `${at}: the confirming button's words ${red}`);
			}
			await closeWindow(page);
		}
		await page.context().close();
	}
	console.log(`  ..  ${measured.join("; ")}`);
	console.log("  ok  lines once in colour, both themes: the tunnel degraded, a failed engine start, a device's Revoke asked and a profile's Delete asked are soft words at 4.5:1 or more after an 8 px dot of their colour, no tinted row, the confirming button still red");
}

async function checkPhone(browser: Browser): Promise<void> {
	const page = await openPage(browser, phone(LIGHT), "on");
	const at = "390 light";
	const onLabelLine = async (row: Locator, what: string) => near(middle(await boxOf(row.locator(".workspaces-tool-switch"))), middle(await boxOf(row.locator(".settings-row-label").first())), `${at}, ${what}: the switch's middle on its label's line`);
	// Web search: the switch on its label's line; Save on the address field's line, 8 after it.
	let pane = await openOn(page, "Web search", { webSearch: { payload: WEB_SEARCH_SEARXNG } });
	await onLabelLine(pane.locator("label.settings-row").filter({ has: page.locator(".workspaces-tool-switch") }).first(), "Web search");
	const [field, save] = [await boxOf(pane.locator("#web-search-base-url")), await boxOf(pane.getByRole("button", { name: "Save" }))];
	near(middle(save), middle(field), `${at}, Web search: Save on the field's line`);
	near(save.left - field.right, 8, `${at}, Web search: Save 8 after the field`);
	await closeWindow(page);
	// Remote access off: its switch on its label's line; Get Tailscale 44 tall at its words' width, under the Tunnel's help from the card's
	// left padding, so the help keeps its width.
	pane = await openOn(page, "Remote access", { remote: { rooms: ONE_LINE_ROOMS } });
	const rows = pane.locator(".ai-setup-section > .settings-rows").first().locator(":scope > .settings-row");
	await onLabelLine(rows.first(), "Remote access");
	const [tailscale, help, toggle] = [await boxOf(pane.getByRole("link", { name: "Get Tailscale" })), await boxOf(rows.nth(1).locator(".settings-row-sub").first()), await boxOf(rows.first().locator(".workspaces-tool-switch"))];
	same([tailscale.height, tailscale.top >= help.bottom, Math.round(tailscale.left - help.left)], [44, true, 0], `${at}, Remote access: Get Tailscale 44 tall, under the Tunnel's help on its left edge`);
	assert(toggle.right - tailscale.right > 100 && toggle.right - help.right < 24, `${at}, Remote access: Get Tailscale at its words' width, the help at the card's (${tailscale.right} and ${help.right} against ${toggle.right})`);
	await closeWindow(page);
	// On, with devices: the access choice 44 tall across the row like the rooms', Revoke ending its line; both rows one height.
	pane = await openOn(page, "Remote access", { remote: { status: ON_STATUS, devices: DEVICES } });
	const devices = await pane.locator(".remote-device-row").evaluateAll((elements) => elements.map((row) => {
		const choice = row.querySelector(".remote-capability-seg")!.getBoundingClientRect();
		const revoke = [...row.querySelectorAll("button")].at(-1)!.getBoundingClientRect();
		const name = row.querySelector(".settings-row-label")!.getBoundingClientRect();
		return { height: Math.round(row.getBoundingClientRect().height - parseFloat(getComputedStyle(row).borderTopWidth)), choice: [choice.left - name.left, choice.height, [...row.querySelectorAll(".remote-capability-seg button")].map((button) => button.getBoundingClientRect().height)], revokeMiddle: Math.abs(revoke.top + revoke.height / 2 - (choice.top + choice.height / 2)), gap: Math.round(revoke.left - choice.right) };
	}));
	same(devices.map((device) => device.choice), [[0, 44, [40, 40]], [0, 44, [40, 40]]], `${at}, devices: the access choice from the name's edge, 44 tall with 40 segments`);
	same([new Set(devices.map((device) => device.height)).size, devices.every((device) => device.revokeMiddle <= 1), devices.map((device) => device.gap)], [1, true, [12, 12]], `${at}, devices: one height, Revoke 12 after the choice on its line`);
	await revokeAsked(page, pane, `${at}, devices`, true);
	await closeWindow(page);
	// Profiles: a refused name's reason right under the field, above Create profile; Move asked: its two buttons start
	// on the card's left padding, as the page's other questions' do at this width.
	pane = await openOn(page, "Profiles");
	const newProfile = pane.locator(".state-profiles:not(.settings-group) > .settings-rows > .settings-row").last();
	await newProfile.getByRole("button", { name: "Create profile" }).click();
	const reason = newProfile.locator(".settings-row-sub.workspaces-error");
	await reason.waitFor();
	const [nameField, reasonBox, create] = [await boxOf(newProfile.locator("input")), await boxOf(reason), await boxOf(newProfile.getByRole("button", { name: "Create profile" }))];
	assert(reasonBox.top >= nameField.bottom && reasonBox.bottom <= create.top, `${at}, Profiles: the refused name's reason between the field and Create profile (${reasonBox.top}..${reasonBox.bottom} against ${nameField.bottom}, ${create.top})`);
	assert(create.left === nameField.left && create.width < nameField.width / 2, `${at}, Profiles: Create profile at its words' width from the field's left edge (${create.left}, ${create.width} against ${nameField.left}, ${nameField.width})`);
	await closeWindow(page);
	pane = await openOn(page, "Profiles", { movePlan: { dir: "/Users/alexandra.example/Documents/exxperts data", mode: "migrate", moving: [".exxperts", ".exxperts-client-demo"] } });
	await pane.getByRole("button", { name: "Move", exact: true }).click();
	await pane.getByRole("button", { name: "Move and reload" }).waitFor();
	const folderCard = visible(page, ".state-profiles.settings-group .settings-rows");
	const leftPadding = await folderCard.evaluate((element) => { const style = getComputedStyle(element); return element.getBoundingClientRect().left + parseFloat(style.borderLeftWidth) + parseFloat(style.paddingLeft); });
	near((await boxOf(pane.getByRole("button", { name: "Keep it" }))).left, leftPadding, `${at}, Profiles, Move asked: Keep it starts on the card's left padding`);
	await closeWindow(page);
	await page.context().close();
	console.log("  ok  390: the switches on their label's line; Save 8 after the address field on its line; Get Tailscale 44 tall under the Tunnel's help from the card's left padding; a device's access choice 44 tall from the name's edge with Revoke 12 after it on its line, both rows one height; Revoke asked holds the choice and Revoke, Keep it on the question's line; on Profiles a refused name's reason between the field and Create profile, and Move asked's buttons from the card's left padding");
}

/** The spec's type scale: five sizes and three weights; no half pixels. */
const SIZES = ["24px", "18px", "14px", "13px", "12px"];
/** 600 is a section's label (44). */
const WEIGHTS = ["400", "500", "600", "700"];

async function checkScale(browser: Browser): Promise<void> {
	const off: string[] = [];
	const page = await openPage(browser, desktop(1440, 900, LIGHT), "on");
	for (const [label, scene] of [
		["Web search", { webSearch: { payload: WEB_SEARCH_SEARXNG, engine: FAILED_ENGINE } }],
		["Appearance", {}],
		["Remote access", { remote: { status: DEGRADED_STATUS } }],
		["Remote access", { remote: { status: ON_STATUS, devices: DEVICES } }],
		["Profiles", {}],
	] as Array<[string, Scene]>) {
		await openOn(page, label, scene);
		// Every element that shows words of its own, and the field's text.
		off.push(...await page.evaluate(({ sizes, weights, label }) => {
			const pane = [...document.querySelectorAll(".settings-dialog-pane")].find((element) => element.getClientRects().length)!;
			return [...pane.querySelectorAll("*")].filter((element) => element.getClientRects().length > 0 && ([...element.childNodes].some((node) => node.nodeType === Node.TEXT_NODE && node.textContent!.trim()) || element.matches("input:not([type=checkbox], [type=radio])")))
				.map((element) => [element, getComputedStyle(element)] as const)
				.filter(([, style]) => !sizes.includes(style.fontSize) || !weights.includes(style.fontWeight))
				.map(([element, style]) => `${label}: ${element.tagName.toLowerCase()}.${[...element.classList].join(".")} "${(element.textContent ?? "").trim().slice(0, 24)}" ${style.fontSize} ${style.fontWeight}`);
		}, { sizes: SIZES, weights: WEIGHTS, label }));
		await closeWindow(page);
	}
	await page.context().close();
	same([...new Set(off)], [], "words off the type scale");
	console.log("  ok  the four pages, switch on: every word at 24, 18, 14, 13 or 12 px and weight 400, 500, 600 or 700");
}

let model: http.Server | undefined;
try {
	const agents = await import("../src/persistent-agents.js");
	agents.createPersistentAgentFromScaffoldInput({ displayName: ROOM, userName: "Synthetic User", preferredUserAddress: "Synthetic User" });
	// A model server is never asked here; the app wants one set up to show its rooms.
	const modelPort = await freePort();
	model = http.createServer((_req, res) => { res.writeHead(500); res.end(); }).listen(modelPort, "127.0.0.1");
	fs.writeFileSync(path.join(agentDir, "models.json"), JSON.stringify({ providers: { synthetic: { name: "Synthetic", baseUrl: `http://127.0.0.1:${modelPort}/v1`, api: "openai-completions", models: [{ id: "room-model", name: "Room Model", input: ["text"], contextWindow: 128000, maxTokens: 16384 }] } } }));
	await startServer();
	const key = await authedFetch(`${baseUrl}/api/auth/api-key`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ provider: "synthetic", key: "synthetic-test-key" }) });
	assert(key.ok, `saving the synthetic key: ${key.status}`);
	// What's new seen before any page opens: a window of it showing late would be closed, and its request sent, while a settings window waits for its own.
	const seen = await authedFetch(`${baseUrl}/api/whats-new/seen`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
	assert(seen.ok, `marking what's new as seen: ${seen.status}`);
	const browser = await chromium.launch({ ignoreDefaultArgs: ["--hide-scrollbars"] });
	try {
		// Each row runs on its own and the run fails at the end with every row that failed.
		const failed: string[] = [];
		const only = process.env.LOOK_ROWS?.split(",");
		for (const row of [checkRulesUnderSwitch, checkOff, checkOutsideSelectors, checkWebSearch, checkReportLines, checkAppearance, checkRemoteAccess, checkProfiles, checkDataFolderPath, checkStateLines, checkPhone, checkScale]) {
			if (only && !only.includes(row.name)) continue;
			try {
				await row(browser);
			} catch (error) {
				failed.push(`${row.name}: ${(error as Error).message.split("\n").filter((line, i) => i === 0 || /waiting for/.test(line)).slice(0, 2).join(" ").replace(/\u001b\[\d+m/g, "")}`);
				console.log(`  FAIL ${failed.at(-1)}`);
				for (const context of browser.contexts()) { if (process.env.LOOK_DEBUG_SHOTS) for (const open of context.pages()) await open.screenshot({ path: `${process.env.LOOK_DEBUG_SHOTS}/${row.name}.png` }).catch(() => {}); await context.close(); }
			}
		}
		assert(failed.length === 0, `${failed.length} rows failed:\n${failed.join("\n")}`);
	} finally {
		await browser.close();
	}
	console.log("settings look app pages ui smoke passed");
} finally {
	await stopSmokeServer(server);
	model?.close();
	fs.rmSync(tempRoot, { recursive: true, force: true });
}
