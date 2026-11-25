// The settings windows' new look on a connector's own page and the two pages
// that add one (51-settings-look-connector-pages.css). With the switch off,
// these pages render as before: their markup and every element's computed
// style, the tools' menu and the questions included, read in each state the
// page has. With the switch on, Settings' Connectors list, a room's
// Connectors and a shared server's Connectors read as before too. Every rule
// of the page file sits under the switch's class. With the switch on, in both
// themes: the arrow back on the title line that stays put with the tile, the
// name and its tag, the Status row first in the facts (state or what went
// wrong, and its one step), the facts in two columns, the tools with their selects in one column and their menu, Remove
// in its own card and a removal that failed under it, and both add pages in
// the list's place, fields in one column with Add before Cancel. Over remote
// access at 390, no button but the way back and nothing sideways.
//
// The world is real: a server on a scratch home, connectors in its own file,
// their last checks kept as the server keeps them, a stand-in connector on
// this computer that answers, and two rooms. Nothing signs in anywhere and
// nothing is downloaded: the sign-ins, the checks, the tools each connector
// lists, the choices and their saves are answered in the page, so each scene
// is the same on every run. Set LOOK_OFF_READING to a file to keep the
// switch-off reading, LOOK_OFF_BASE to one kept from a page built from the
// base to compare against it, LOOK_OFF_WIDTHS to "1440,390" to read both
// widths (1440 alone otherwise); LOOK_ROWS to run some rows; LOOK_SHOTS to a
// folder for a picture of each scene.
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";
import type { AddressInfo } from "node:net";
import { fileURLToPath } from "node:url";
import { chromium, type Browser, type Locator, type Page, type Route } from "playwright";
import { authedFetch, SMOKE_SERVER_AUTH_ENV, SMOKE_SERVER_SPAWN_TREE_OPTIONS, smokeHomeEnv, stopSmokeServer, freePort, waitForServer } from "./smoke-server-process.js";
import { waitEvery } from "./smoke-wait.js";
import { answered, assert, closeWindow, DARK, desktop, goToPage, installColourTools, LIGHT, LOOK_FILE, lookPages, notLookPageFilesAfterLook, phone, requestsFromNow, rulesOutsideRoots, same, SWITCH_CLASS, type Theme } from "./settings-look-smoke-parts.js";

{
	const p = typeof chromium?.executablePath === "function" ? chromium.executablePath() : "";
	if (!p || !fs.existsSync(p)) {
		console.log("settings look connector pages ui smoke skipped (Chromium not installed)");
		process.exit(0);
	}
}

const waitUntil = waitEvery(100);
const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const webServerDir = path.resolve(scriptDir, "..");
const repoRoot = path.resolve(webServerDir, "..", "..");
const stylesDir = path.join(repoRoot, "apps", "web-ui", "src", "styles");
const PAGE_FILE = "51-settings-look-connector-pages.css";
const port = await freePort();
const baseUrl = `http://127.0.0.1:${port}`;

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "exxperts-settings-look-connector-pages-"));
const tempHome = path.join(tempRoot, "home");
const agentsRoot = path.join(tempHome, ".exxperts", "app", "personalized-agents");
const agentDir = path.join(tempHome, ".exxperts", "agent");
for (const dir of [agentsRoot, agentDir]) fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
process.env.HOME = tempHome;
process.env.USERPROFILE = tempHome;
process.env.EXXPERTS_CODING_AGENT_DIR = agentDir;
process.env.PI_CODING_AGENT_DIR = agentDir;
process.env.EXXETA_PERSISTENT_AGENTS_ROOT = agentsRoot;

const { CONNECTOR_WORDS: WORDS, lineText } = await import("../../web-ui/src/connector-rows.js");
const { CONNECTOR_REQUEST_LINES } = await import("../src/connector-form.js");
const authStore = await import("pi-mcp-adapter/mcp-auth.ts" as string);

const ROOM = "Look Room";
const OTHER_ROOM = "Board papers";
const look = lookPages({ baseUrl, room: ROOM });
const { openPage, openWindow } = look;

// --- The stand-in connector on this computer -----------------------------------------

const standIn = http.createServer((req, res) => {
	let raw = "";
	req.on("data", (chunk) => { raw += chunk; });
	req.on("end", () => {
		if (new URL(req.url ?? "/", "http://x").pathname !== "/wiki/mcp") return void res.writeHead(401, { "content-type": "text/plain" }).end("sign in first");
		if (req.method !== "POST") return void res.writeHead(405).end();
		const message = JSON.parse(raw || "{}");
		if (message.id === undefined) return void res.writeHead(202).end();
		const result = message.method === "initialize" ? { protocolVersion: message.params?.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: "stand-in", version: "1.0.0" } }
			: message.method === "tools/list" ? { tools: [{ name: "search_pages", description: "Search pages.", inputSchema: { type: "object" } }] } : {};
		res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ jsonrpc: "2.0", id: message.id, result }));
	});
});
await new Promise<void>((resolve) => standIn.listen(0, "127.0.0.1", resolve));
const standInAt = (where: string) => `http://127.0.0.1:${(standIn.address() as AddressInfo).port}${where}`;
/** Nothing listens on port 9: the kept checks say what a check found there. */
const NOWHERE = "http://127.0.0.1:9/mcp";
/** A web address of 200 characters, which wraps in its row. */
const LONG_ADDRESS = `https://projects.example.com/${"workspace-".repeat(16)}mcp`.slice(0, 200);

// --- The connectors, as the server keeps them ----------------------------------------

const C = {
	/** Signed in, on in two rooms, its tools in every source. */
	wiki: { id: "team-wiki", name: "Team wiki" },
	/** A program that answered, with its tools. */
	office: { id: "office-files", name: "Office files" },
	/** A program never checked, that downloads at its first start: a check held past a few seconds gets it ready. */
	fresh: { id: "fresh-files", name: "Fresh files" },
	/** Its web address wasn't found: Change address, and Technical details. */
	ticket: { id: "ticket-desk", name: "Ticket desk" },
	/** It didn't answer: Try again, and Change address. */
	slow: { id: "slow-desk", name: "Slow desk" },
	/** Its key was turned down: Change key. */
	keyed: { id: "keyed-desk", name: "Keyed desk" },
	/** Signing in, in the browser. */
	tracker: { id: "project-tracker", name: "Project tracker" },
	/** A long web address, not connected. */
	long: { id: "long-address", name: "Long address" },
	/** A program brought in from another app: its note, and no Remove. */
	imported: { id: "desktop-files", name: "Desktop files" },
} as const;
type Key = keyof typeof C;
const EVERY: Key[] = ["wiki", "office", "fresh", "ticket", "slow", "keyed", "tracker", "long", "imported"];

/** The tools each connector lists, as the page reads them: every source of a choice on Team wiki. */
const WIKI_TOOLS = {
	count: 7,
	names: ["search_pages", "get_page", "list_spaces", "create_page", "move_page", "delete_page", "archive_page"],
	titles: {},
	descriptions: {
		search_pages: "Search pages by the words in their title or text.",
		get_page: "Read one page.",
		list_spaces: "List the spaces you can see, with their owners, their pages and the people who can read them, in the order you last opened them.",
		create_page: "Create a page in a space.",
		move_page: "Move a page to another space.",
		archive_page: "Archive a page.",
	},
	readOnly: ["search_pages", "get_page", "list_spaces"],
	resources: ["read_page_resource"],
	excluded: ["archive_page"],
	cachedAt: 1,
};
const OFFICE_TOOLS = { count: 2, names: ["list_files", "write_file"], titles: {}, descriptions: { list_files: "List the files in a folder.", write_file: "Write a file." }, readOnly: ["list_files"], cachedAt: 1 };
const TOOLS: Partial<Record<string, typeof WIKI_TOOLS | typeof OFFICE_TOOLS>> = { [C.wiki.id]: WIKI_TOOLS, [C.office.id]: OFFICE_TOOLS };
/** Always allow, Ask first and Blocked each chosen once; the rest by default. */
const WIKI_CHOICES = { search_pages: "allow", create_page: "ask", move_page: "blocked" } as const;

// --- The page's own requests, answered here ---------------------------------------------

type Scene = {
	/** The connectors the list shows, by key. */
	list?: Key[];
	/** Over remote access, read-only. */
	remote?: boolean;
	/** A shared server's short page. */
	shared?: boolean;
};
/** The choices as the page reads them: readable with these, or unreadable and why. */
const choices: { unreadable: "cannot-read" | "newer" | null; byConnector: Record<string, Record<string, string>> } = { unreadable: null, byConnector: {} };
/** How the next save of a tool's choice goes: kept, refused (nothing saved), or its answer lost with the read after it. */
let saveGoes: "kept" | "refused" | "lost" = "kept";
let failNextStatus = false;
/** A name the status answer gives the first room a connector is on in, for a phone's long-name scene. */
let longRoomName: string | null = null;
/** How a removal goes: refused by the server, or left to it. */
let removalGoes: "refused" | "server" = "refused";
const signIns = new Map<string, "pending">();
/** How a sign-in under way ends when the page next asks, by why it failed. */
const signInEnds = new Map<string, string>();
/** A check's answer for a scene, over the one the connector keeps. */
const checkOverrides = new Map<string, unknown>();
/** The program the status answer says can't start, for the room that can change its files. */
let startRefusedFor: string | null = null;
const heldChecks = new Map<string, { until: Promise<void>; answer: unknown }>();
/** The checks of the connectors nothing answers here, as the server kept them. */
const CHECK_ANSWERS: Record<string, unknown> = {
	[C.ticket.id]: { ok: false, httpStatus: 404, error: "HTTP 404" },
	[C.slow.id]: { ok: false, error: "fetch failed" },
	[C.keyed.id]: { ok: false, httpStatus: 401, error: "HTTP 401" },
	[C.long.id]: { ok: false, needsAuth: true, httpStatus: 401 },
	[C.tracker.id]: { ok: false, needsAuth: true, httpStatus: 401 },
	[C.wiki.id]: { ok: true, toolCount: 7, toolNames: WIKI_TOOLS.names },
};
const nameOf = (route: Route) => decodeURIComponent(new URL(route.request().url()).pathname.split("/").at(-2)!);

function resetWorld(): void {
	choices.unreadable = null;
	choices.byConnector = { [C.wiki.id]: { ...WIKI_CHOICES } };
	saveGoes = "kept";
	failNextStatus = false;
	longRoomName = null;
	removalGoes = "refused";
	signIns.clear();
	signIns.set(C.tracker.id, "pending");
	signInEnds.clear();
	checkOverrides.clear();
	startRefusedFor = null;
	heldChecks.clear();
}

async function answer(page: Page, scene: Scene): Promise<void> {
	await page.unrouteAll({ behavior: "ignoreErrors" });
	if (scene.remote || scene.shared) await page.route("**/api/remote/client-context", (route) => route.fulfill({ json: scene.shared ? { remote: false, sharedServer: true } : { remote: true, capability: "read-only" } }));
	await page.route("**/api/mcp/status", async (route) => {
		if (failNextStatus) {
			failNextStatus = false;
			return route.abort();
		}
		// A page closed while its status was out leaves nothing to answer.
		const response = await route.fetch().catch(() => null);
		if (!response) return;
		const status = await response.json();
		const ids = new Set((scene.list ?? EVERY).map((key) => C[key].id as string));
		const servers = status.servers.filter((server: { name: string }) => ids.has(server.name)).map((server: Record<string, unknown> & { name: string; source?: object }) => {
			const shown: Record<string, unknown> = { ...server, tools: TOOLS[server.name] ?? server.tools };
			delete shown.choices;
			delete shown.choicesUnreadable;
			if (choices.unreadable) shown.choicesUnreadable = choices.unreadable;
			else shown.choices = { ...(choices.byConnector[server.name] ?? {}) };
			if (longRoomName && Array.isArray(server.usedIn) && server.usedIn.length) shown.usedIn = [{ ...(server.usedIn[0] as object), name: longRoomName }, ...server.usedIn.slice(1)];
			// As the server marks a program started by uvx and the like.
			if (server.name === C.fresh.id) shown.downloadsAtFirstStart = true;
			if (server.name === startRefusedFor) shown.startRefused = { roomId: "look-room", roomName: ROOM };
			if (server.name === C.imported.id) shown.source = { ...server.source, importKind: "claude-desktop", importFile: "/Users/synthetic/Library/Application Support/Claude/claude_desktop_config.json" };
			return shown;
		});
		return route.fulfill({ response, json: { ...status, servers } });
	});
	await page.route("**/api/mcp/servers/*/tools", async (route) => {
		const name = nameOf(route);
		if (saveGoes === "refused") return route.fulfill({ status: 500, json: { error: "stand-in: not saved" } });
		if (saveGoes === "lost") {
			failNextStatus = true;
			return route.abort();
		}
		const { tools } = route.request().postDataJSON() as { tools: Record<string, string | null> };
		const now = { ...(choices.byConnector[name] ?? {}) };
		for (const [tool, choice] of Object.entries(tools)) {
			if (choice === null) delete now[tool];
			else now[tool] = choice;
		}
		choices.byConnector[name] = now;
		return route.fulfill({ json: { name, choices: now } });
	});
	await page.route("**/api/mcp/tool-choices/reset", (route) => route.fulfill({ status: 500, json: { error: CONNECTOR_REQUEST_LINES.choicesResetFailed } }));
	await page.route(/\/api\/mcp\/servers\/[^/]+$/, (route) => {
		if (route.request().method() === "DELETE" && removalGoes === "refused") return route.fulfill({ status: 500, json: { error: "stand-in: not removed" } });
		return route.fallback();
	});
	await page.route("**/api/mcp/servers/*/login", async (route) => {
		const request = route.request();
		const name = nameOf(route);
		if (request.method() === "POST") {
			signIns.set(name, "pending");
			return route.fulfill({ json: { started: true } });
		}
		if (request.method() === "DELETE") {
			const was = signIns.has(name);
			signIns.delete(name);
			return route.fulfill({ json: { cancelled: was } });
		}
		const ends = signInEnds.get(name);
		if (ends) {
			signIns.delete(name);
			return route.fulfill({ json: { pending: false, cause: ends } });
		}
		return route.fulfill({ json: { pending: signIns.has(name) } });
	});
	await page.route("**/api/mcp/servers/*/test", async (route) => {
		const name = nameOf(route);
		const held = heldChecks.get(name);
		if (held) {
			await held.until;
			return route.fulfill({ json: held.answer }).catch(() => undefined);
		}
		const answer = checkOverrides.get(name) ?? CHECK_ANSWERS[name];
		if (answer) return route.fulfill({ json: answer });
		return route.fallback();
	});
	// An add answered as the server answers one that it refuses, so nothing is added.
	await page.route("**/api/mcp/servers", (route) => route.request().method() === "POST" && addRefused ? route.fulfill({ status: 400, json: { error: CONNECTOR_REFUSAL } }) : route.fallback());
}
let addRefused = false;
const CONNECTOR_REFUSAL = "That web address isn't one exxperts can connect to.";

/** A held check: the answer waits until `release` is called. */
function holdCheck(name: string, answer: unknown): () => void {
	let release = () => {};
	heldChecks.set(name, { until: new Promise<void>((resolve) => { release = resolve; }), answer });
	return () => { heldChecks.delete(name); release(); };
}

const visible = (page: Page, selector: string) => page.locator(selector).filter({ visible: true }).first();
const pane = (page: Page) => visible(page, ".settings-dialog-pane");
const row = (page: Page, key: Key) => page.locator(".connector-list .connector-item").filter({ has: page.locator(".connector-item-name-text", { hasText: new RegExp(`^${C[key].name}$`) }) });
const connectorPage = (page: Page) => visible(page, ".connector-page");
const addPage = (page: Page) => visible(page, ".connector-custom-form");
/** Waits until nothing that ends is still moving: a changed line's fade, a press's spinner aside. */
const still = (page: Page, what: string) => waitUntil(() => page.evaluate(() => document.getAnimations().every((one) => one.playState !== "running" || one.effect?.getComputedTiming().iterations === Infinity)), `${what}: nothing moving`);

/** Opens Settings on Connectors with the scene's answers, its requests answered and the pointer away. */
async function openConnectors(page: Page, scene: Scene = {}): Promise<Locator> {
	await answer(page, scene);
	await page.reload();
	await page.locator(".persistent-agent-card").first().waitFor({ timeout: 15000 });
	await installColourTools(page);
	requestsFromNow(page);
	await page.locator("button.sidebar-config-gear").filter({ visible: true }).first().click();
	await page.locator(".sidebar-config-menu button, .sidebar-config-menu a").filter({ hasText: /Settings/ }).first().click();
	await page.waitForSelector(".settings-overlay", { timeout: 10000 });
	await goToPage(page, "Connectors");
	const opened = pane(page);
	await opened.locator(scene.shared ? "section[aria-label='Connectors']" : ".connector-list-section").first().waitFor({ timeout: 15000 });
	await answered(page, "Settings Connectors");
	await page.mouse.move(5, 5);
	return opened;
}

/** Waits until the list's rows have settled: the checked rows read, the one signing in still signing in. */
async function listSettled(page: Page, keys: Key[], what: string): Promise<void> {
	await waitUntil(async () => {
		const lines = await page.locator(".connector-list .connector-item-status").allTextContents();
		return lines.length === keys.length && lines.every((line) => line && line !== WORDS.status.checking);
	}, `${what}: the rows settle`, 20000);
	await answered(page, what);
	await still(page, what);
}

/** Opens a connector's own page from its row, by its open target's start (on a phone its button sits mid-row). */
async function openConnector(page: Page, key: Key): Promise<Locator> {
	await row(page, key).locator(".connector-item-hit").click({ position: { x: 24, y: 24 } });
	const opened = connectorPage(page);
	await opened.waitFor();
	// Its name in the page: the base's phone look hides it, and the pictures read both builds.
	await opened.locator(".pane-head h2", { hasText: C[key].name }).waitFor({ state: "attached" });
	await answered(page, `${key}'s page`);
	await page.mouse.move(5, 5);
	await still(page, `${key}'s page`);
	return opened;
}

async function backToList(page: Page): Promise<void> {
	await visible(page, ".connector-page-back").click();
	await pane(page).locator(".connector-list").waitFor();
}

/** Opens one of the ways to add from Add connector's menu. */
async function openAdd(page: Page, kind: "web" | "program"): Promise<Locator> {
	await pane(page).locator(".connector-add-btn").click();
	await page.getByRole("menuitem", { name: kind === "web" ? WORDS.addWays.web : WORDS.addWays.program }).click();
	const opened = addPage(page);
	await opened.waitFor();
	await page.mouse.move(5, 5);
	await still(page, `${kind}'s add page`);
	return opened;
}

const toolRow = (page: Page, tool: string) => connectorPage(page).locator(`.connector-tool[data-tool="${tool}"]`);
const selectOf = (page: Page, tool: string) => toolRow(page, tool).locator(".connector-choice-btn");

// --- Measuring ------------------------------------------------------------------------------

type Box = { left: number; right: number; top: number; bottom: number; width: number; height: number };
const boxOf = (target: Locator): Promise<Box> => target.evaluate((element) => { const { left, right, top, bottom, width, height } = element.getBoundingClientRect(); return { left, right, top, bottom, width, height }; });
const near = (a: number, b: number, what: string, within = 0.5) => assert(Math.abs(a - b) <= within, `${what}: ${a.toFixed(1)} against ${b.toFixed(1)}`);
/** The open pane's content column: inside its padding, left of the room kept for its scrollbar. */
const column = (page: Page) => page.evaluate(() => {
	const scroller = [...document.querySelectorAll(".settings-dialog-pane")].find((one) => one.getClientRects().length)!;
	const style = getComputedStyle(scroller);
	const box = scroller.getBoundingClientRect();
	const left = box.left + scroller.clientLeft + parseFloat(style.paddingLeft);
	const right = box.left + scroller.clientLeft + scroller.clientWidth - parseFloat(style.paddingRight);
	return { left, right, top: box.top, scrollTop: scroller.scrollTop, scrollMax: scroller.scrollHeight - scroller.clientHeight };
});
const scrollPane = (page: Page, top: number) => page.evaluate((to) => { const scroller = [...document.querySelectorAll(".settings-dialog-pane")].find((one) => one.getClientRects().length)!; scroller.scrollTop = to; }, top);
/** A style of an element or of one of its parts (::before). */
const styleOf = (target: Locator, names: string[], part: string | null = null) => target.evaluate((element, [wanted, pseudo]) => { const style = getComputedStyle(element, pseudo as string | null); return Object.fromEntries((wanted as string[]).map((name) => [name, style.getPropertyValue(name)])); }, [names, part] as const);
const textLook = async (target: Locator) => { const s = await styleOf(target, ["font-size", "line-height", "font-weight"]); return `${s["font-size"]}/${s["line-height"]} ${s["font-weight"]}`; };

/** The colours of the theme's tokens, as a person sees them on the open page. */
const tokens = (page: Page) => page.evaluate(() => {
	const w = window as any;
	const dialog = document.querySelector(".settings-dialog")!;
	const read = (name: string) => w.__seen(dialog, getComputedStyle(dialog).getPropertyValue(name).trim());
	return { text: read("--fg"), soft: read("--fg-soft"), muted: read("--muted"), ok: read("--exx-success"), danger: read("--error"), focus: read("--exx-focus"), hairline: read("--exx-hairline") };
});
const seen = (target: Locator, property: string, part: string | null = null) => target.evaluate((element, [name, pseudo]) => (window as any).__seen(element, getComputedStyle(element, pseudo).getPropertyValue(name!)), [property, part] as const);

/** The ink-filled buttons and links on the open page, as a person sees them. */
const INK = { [LIGHT]: "#111111", [DARK]: "#f4f1ec" };
async function inkedOn(page: Page, theme: Theme): Promise<string[]> {
	return page.evaluate((ink) => {
		const w = window as any;
		const scroller = [...document.querySelectorAll(".settings-dialog-pane")].find((element) => element.getClientRects().length)!;
		return [...scroller.querySelectorAll("button, a.rs-btn")].filter((element) => element.getClientRects().length > 0 && w.__painted(getComputedStyle(element).backgroundColor) && w.__seen(element, getComputedStyle(element).backgroundColor) === ink).map((element) => element.textContent!.trim());
	}, INK[theme]);
}

/** Nothing sideways: neither the page nor the open pane scrolls across. */
async function nothingSideways(page: Page, what: string): Promise<void> {
	const wide = await page.evaluate(() => {
		const scroller = [...document.querySelectorAll(".settings-dialog-pane")].find((one) => one.getClientRects().length)!;
		return [document.documentElement.scrollWidth - window.innerWidth, scroller.scrollWidth - scroller.clientWidth];
	});
	same(wide.map((extra) => Math.max(0, extra)), [0, 0], `${what}: sideways scrolling (page, pane)`);
}

/** The spec's type scale, its colours and contrast, on the open pane: words off the scale, words in a colour, words under 4.5:1. */
const SIZES = ["24px", "18px", "14px", "13px", "12px"];
/** 600 is a section's label (44). */
const WEIGHTS = ["400", "500", "600", "700"];
const offScale = (page: Page, theme: Theme) => page.evaluate(({ sizes, weights, theme }) => {
	const w = window as any;
	const roots = [[...document.querySelectorAll(".settings-dialog-pane")].find((element) => element.getClientRects().length)!, ...document.querySelectorAll("body > .ai-profile-menu")];
	const words = roots.flatMap((root) => [...root.querySelectorAll("*")]).filter((element) => element.getClientRects().length > 0 && ([...element.childNodes].some((node) => node.nodeType === Node.TEXT_NODE && node.textContent!.trim()) || element.matches("input:not([type=checkbox], [type=radio])")));
	const at = (element: Element) => `${theme}: ${element.tagName.toLowerCase()}.${[...element.classList].join(".")} "${(element.textContent ?? "").trim().slice(0, 24)}"`;
	const rgb = (hex: string) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
	return [
		...words.map((element) => [element, getComputedStyle(element)] as const).filter(([, style]) => !sizes.includes(style.fontSize) || !weights.includes(style.fontWeight)).map(([element, style]) => `${at(element)} ${style.fontSize} ${style.fontWeight}`),
		...words.filter((element) => !element.closest("button.rs-btn-danger")).filter((element) => { const c = rgb(w.__seen(element, getComputedStyle(element).color)); return Math.max(...c) - Math.min(...c) > 40; }).map((element) => `${at(element)} coloured`),
		...words.filter((element) => !element.closest("button:disabled") && !(element as HTMLInputElement).placeholder && w.__contrast(element) < 4.5).map((element) => `${at(element)} ${w.__contrast(element).toFixed(2)}:1`),
	];
}, { sizes: SIZES, weights: WEIGHTS, theme });

// --- The page file ------------------------------------------------------------------------

async function checkRulesUnderSwitch(browser: Browser): Promise<void> {
	const page = await openPage(browser, desktop(1280), "off");
	// The tools' menu is drawn on <body>, outside the window: its rules start with the body holding a window in the look.
	const roots = [SWITCH_CLASS, `body:has(${SWITCH_CLASS}`];
	const css = fs.readFileSync(path.join(stylesDir, PAGE_FILE), "utf8");
	same(await rulesOutsideRoots(page, css, roots), [], `rules in ${PAGE_FILE} outside ${SWITCH_CLASS}`);
	// The check finds a rule outside, in a media query too; a longer class name is not the root, nor a body that holds another window.
	same(await rulesOutsideRoots(page, `.connector-page .connector-fact { color: red; } ${SWITCH_CLASS}-x .a { color: red; } body:has(.settings-dialog) > .ai-profile-menu { color: red; } .settings-dialog .connector-custom-form { color: red; } @media (max-width: 760px) { ${SWITCH_CLASS} .a, .connector-tool { color: red; } }`, roots), [".connector-page .connector-fact", `${SWITCH_CLASS}-x .a`, "body:has(.settings-dialog) > .ai-profile-menu", ".settings-dialog .connector-custom-form", ".connector-tool"], "the check's own probe");
	const imports = [...fs.readFileSync(path.join(repoRoot, "apps", "web-ui", "src", "styles.css"), "utf8").matchAll(/@import "\.\/styles\/([^"]+)";/g)].map((match) => match[1]);
	same(notLookPageFilesAfterLook(imports), [], `the style files after ${LOOK_FILE} that are not the look's page files`);
	assert(imports.indexOf(PAGE_FILE) > imports.indexOf(LOOK_FILE), `${PAGE_FILE} loads after ${LOOK_FILE}`);
	const loaded = await page.evaluate(() => [...document.styleSheets].some((sheet) => [...sheet.cssRules].some((rule) => rule instanceof CSSStyleRule && rule.selectorText.includes(".connector-status-text"))));
	assert(loaded, "the page's stylesheet carries the page file's rules");
	await page.context().close();
	console.log(`  ok  every rule of ${PAGE_FILE} sits under ${SWITCH_CLASS} (the menu's under a body holding it), and it loads after ${LOOK_FILE}`);
}

// --- What stays as it was ------------------------------------------------------------------

/** Elements' markup, with React's generated ids blanked, and every element's computed style by property name;
 * this run's folder and ports blanked, so two runs read alike. The pane, and the menu and the question drawn
 * outside it, whichever show. */
async function readAsItIs(page: Page, root: Locator | null = null) {
	const target = root ?? pane(page);
	const read = await target.evaluate((element) => {
		const blank = (text: string) => text.replace(/«[^»]*»|:r[0-9a-z]+:/g, "#id");
		const one = (top: Element) => {
			const copy = top.cloneNode(true) as Element;
			for (const fading of copy.querySelectorAll(".is-new")) fading.classList.remove("is-new");
			const styles = [top, ...top.querySelectorAll("*")].map((each) => {
				const style = getComputedStyle(each);
				return `${each.tagName.toLowerCase()}.${[...each.classList].filter((name) => name !== "is-new").join(".")} ${[...style].sort().map((name) => `${name}:${style.getPropertyValue(name)}`).join(";")}`;
			});
			return { markup: blank(copy.outerHTML), styles: styles.map(blank) };
		};
		const outside = [...document.querySelectorAll("body > .ai-profile-menu, .confirm-dialog-backdrop")];
		const parts = [one(element), ...outside.map(one)];
		return { markup: parts.map((part) => part.markup).join("\n"), styles: parts.flatMap((part) => part.styles) };
	});
	let text = JSON.stringify(read);
	for (const folder of new Set([tempRoot, fs.realpathSync(tempRoot)])) text = text.replaceAll(folder, "<temp>");
	return JSON.parse(text.replace(/127\.0\.0\.1:\d+/g, "127.0.0.1:<port>"));
}

/** Each scene the switch-off reading takes on a connector's page or an add page, in order, on one page opened at a width. */
async function offScenes(page: Page, take: (name: string, root?: Locator | null) => Promise<void>): Promise<void> {
	resetWorld();
	await openConnectors(page);
	await listSettled(page, EVERY, "switch off");
	// A web connector signed in, its tools in every source, then its menu open.
	await openConnector(page, "wiki");
	await take("a web connector signed in");
	await selectOf(page, "create_page").click();
	await page.locator(".ai-profile-menu").waitFor();
	await still(page, "the menu");
	await take("its menu open");
	await page.keyboard.press("Escape");
	await page.locator(".ai-profile-menu").waitFor({ state: "detached" });
	// A save that fails, and one whose answer is lost.
	saveGoes = "refused";
	await selectOf(page, "get_page").click();
	await page.getByRole("menuitemradio", { name: WORDS.tools.choices.blocked }).click();
	await toolRow(page, "get_page").locator(".connector-row-error").waitFor();
	await answered(page, "a failed save");
	await page.mouse.move(5, 5);
	await still(page, "a failed save");
	await take("a failed save");
	saveGoes = "lost";
	await selectOf(page, "list_spaces").click();
	await page.getByRole("menuitemradio", { name: WORDS.tools.choices.ask }).click();
	await toolRow(page, "list_spaces").getByText(WORDS.tools.unsure).waitFor();
	await answered(page, "an unsure save");
	await page.mouse.move(5, 5);
	await still(page, "an unsure save");
	await take("an unsure save");
	saveGoes = "kept";
	failNextStatus = false;
	// Try again reads the choices back, as a person would before leaving; the list then has its connectors again.
	await toolRow(page, "list_spaces").locator(".connector-choice > .connector-slot-btn").click();
	await toolRow(page, "list_spaces").getByText(WORDS.tools.unsure).waitFor({ state: "detached" });
	await answered(page, "an unsure save tried again");
	// The Remove question.
	await connectorPage(page).locator(".connector-remove-group .rs-btn-danger").click();
	await page.locator(".confirm-dialog-backdrop").waitFor();
	await still(page, "the Remove question");
	await take("the Remove question");
	await page.getByRole("button", { name: WORDS.button.keep, exact: true }).click();
	await page.locator(".confirm-dialog-backdrop").waitFor({ state: "detached" });
	await backToList(page);
	// A program that answered, and one never checked.
	for (const [key, name] of [["office", "a program connected"], ["fresh", "a program never checked"]] as const) {
		await openConnector(page, key);
		await take(name);
		await backToList(page);
	}
	// A broken connector with Technical details open, then Change address open.
	await openConnector(page, "ticket");
	await connectorPage(page).locator(".connector-tech > summary").click();
	await page.mouse.move(5, 5);
	await take("a broken connector, Technical details open");
	await connectorPage(page).getByRole("button", { name: WORDS.button.changeAddress }).first().click();
	await connectorPage(page).locator(".connector-edit").waitFor();
	await still(page, "Change address");
	await take("Change address open");
	await page.keyboard.press("Escape");
	await backToList(page);
	// Change key open.
	await openConnector(page, "keyed");
	await connectorPage(page).getByRole("button", { name: WORDS.button.changeKey }).first().click();
	await connectorPage(page).locator(".connector-edit").waitFor();
	await still(page, "Change key");
	await take("Change key open");
	await page.keyboard.press("Escape");
	await backToList(page);
	// One signing in.
	await openConnector(page, "tracker");
	await take("one signing in");
	await backToList(page);
	// By web address: empty, then its fold open with two header rows, then refused.
	let form = await openAdd(page, "web");
	await take("By web address, empty", form);
	await form.locator(".connector-oauth-toggle").click();
	await form.getByRole("button", { name: WORDS.form.addHeader }).click();
	await page.mouse.move(5, 5);
	await still(page, "the fold");
	await take("By web address, its fold open with two header rows", form);
	addRefused = true;
	await form.locator("input").nth(0).fill("Project tracker");
	await form.locator("input").nth(1).fill("https://projects.example.com/mcp");
	await form.getByRole("button", { name: WORDS.form.add, exact: true }).click();
	await form.locator(".checkpoint-proposal-error").waitFor();
	addRefused = false;
	await page.mouse.move(5, 5);
	await still(page, "a refused add");
	await take("By web address, refused", form);
	await form.getByRole("button", { name: WORDS.form.cancel, exact: true }).click();
	// Program on this computer with two setting rows.
	form = await openAdd(page, "program");
	await form.getByRole("button", { name: WORDS.form.addSetting }).click();
	await page.mouse.move(5, 5);
	await take("Program on this computer, two setting rows", form);
	await form.getByRole("button", { name: WORDS.form.cancel, exact: true }).click();
	await closeWindow(page);
	// Choices that can't be read, with the Reset question open; then choices from a newer version.
	choices.unreadable = "cannot-read";
	await openConnectors(page);
	await listSettled(page, EVERY, "choices that can't be read");
	await openConnector(page, "wiki");
	await connectorPage(page).getByRole("button", { name: WORDS.tools.reset }).click();
	await page.locator(".confirm-dialog-backdrop").waitFor();
	await still(page, "the Reset question");
	await take("choices that can't be read, the Reset question open");
	await page.getByRole("button", { name: WORDS.button.cancel, exact: true }).click();
	await page.locator(".confirm-dialog-backdrop").waitFor({ state: "detached" });
	await closeWindow(page);
	choices.unreadable = "newer";
	await openConnectors(page);
	await listSettled(page, EVERY, "choices from a newer version");
	await openConnector(page, "wiki");
	await take("choices from a newer version");
	await closeWindow(page);
	choices.unreadable = null;
	// Over remote access.
	await openConnectors(page, { remote: true });
	await openConnector(page, "wiki");
	await take("the page over remote access");
	await closeWindow(page);
}

/** The scenes read with the switch on that this task leaves as they were: Settings' list, a room's, a shared server's. */
async function onScenes(page: Page, take: (name: string, root?: Locator | null) => Promise<void>): Promise<void> {
	resetWorld();
	const release = holdCheck(C.fresh.id, { ok: true, toolCount: 0, toolNames: [] });
	await openConnectors(page);
	await listSettled(page, EVERY, "switch on, the list");
	// A program never checked, its check held until it is getting ready, so the foot holds it beside the sign-in.
	await row(page, "fresh").getByRole("button", { name: WORDS.button.checkConnection }).click();
	await page.mouse.move(5, 5);
	await page.locator(".connector-waiting-foot").filter({ hasText: C.fresh.name }).waitFor({ timeout: 15000 });
	await still(page, "switch on, the list");
	await take("switch on, Settings' Connectors in every row state with the foot");
	release();
	await closeWindow(page);
	await openWindow(page, "room");
	await goToPage(page, "Connectors");
	await pane(page).locator(".room-skills-row, .room-connectors-section .settings-empty").first().waitFor({ timeout: 15000 });
	await answered(page, "a room's Connectors");
	await page.mouse.move(5, 5);
	await still(page, "a room's Connectors");
	await take("switch on, a room's Connectors");
	await closeWindow(page);
	await openConnectors(page, { shared: true });
	await take("switch on, a shared server's Connectors");
}

async function checkOff(browser: Browser): Promise<void> {
	const reading: Record<string, unknown> = {};
	const widths = (process.env.LOOK_OFF_WIDTHS ?? "1440").split(",");
	for (const width of widths) {
		const where = `${width} light`;
		const options = width === "390" ? phone(LIGHT) : desktop(Number(width), 900, LIGHT);
		const page = await openPage(browser, options, "off");
		await offScenes(page, async (name, root = null) => {
			same(await page.locator(".settings-look-next").count(), 0, `${where}, switch off, ${name}: elements with the look's class`);
			reading[`${where}, ${name}`] = await readAsItIs(page, root);
		});
		await page.context().close();
		const on = await openPage(browser, options, "on");
		await onScenes(on, async (name) => { reading[`${where}, ${name}`] = await readAsItIs(on); });
		await on.context().close();
	}
	if (process.env.LOOK_OFF_READING) fs.writeFileSync(process.env.LOOK_OFF_READING, zlib.gzipSync(JSON.stringify(reading)));
	if (process.env.LOOK_OFF_BASE) {
		const base = JSON.parse(zlib.gunzipSync(fs.readFileSync(process.env.LOOK_OFF_BASE)).toString("utf8")) as Record<string, { markup: string; styles: string[] }>;
		same(Object.keys(reading).filter((name) => !(name in base)), [], "the scenes read that the base's reading lacks");
		const differ = Object.entries(reading).map(([name, now]) => {
			const was = base[name];
			const at = (now as typeof was).styles.findIndex((style, i) => style !== was.styles[i]);
			return (now as typeof was).markup === was.markup && at < 0 ? null : `${name} (${(now as typeof was).markup === was.markup ? "same markup" : "markup differs"}${at >= 0 ? `, first style differing: ${(now as typeof was).styles[at].slice(0, 100)}` : ""})`;
		}).filter(Boolean);
		same(differ, [], "scenes that read otherwise than on the base");
	}
	console.log(`  ok  switch off at ${widths.join(" and ")}: no look class; ${Object.keys(reading).length} readings${process.env.LOOK_OFF_BASE ? " equal to the base's" : ""}${process.env.LOOK_OFF_READING ? ` (kept in ${process.env.LOOK_OFF_READING})` : ""}`);
}

// --- With the switch on ------------------------------------------------------------------------

/** The title line of a page inside a page: the arrow, the name, the line's own band, the close and the content's edges. */
async function header(page: Page) {
	const back = visible(page, ".connector-page-back");
	const line = await back.evaluate((element) => {
		const head = element.closest(".pane-head")!;
		const name = head.querySelector("h2")!;
		const band = getComputedStyle(head);
		const type = (one: Element) => { const style = getComputedStyle(one); return `${style.fontSize}/${style.lineHeight}`; };
		const middle = (one: Element) => { const box = one.getBoundingClientRect(); return box.top + box.height / 2; };
		const windowName = [...document.querySelectorAll(".settings-dialog-title")].find((one) => one.getClientRects().length > 0);
		return {
			height: Math.round(head.getBoundingClientRect().height),
			position: band.position,
			top: band.top,
			shadow: band.boxShadow,
			fill: (window as any).__seen(element, band.backgroundColor),
			types: [type(name), windowName ? type(windowName) : null],
			nameTop: name.getBoundingClientRect().top,
			middles: [element, name, [...document.querySelectorAll(".settings-dialog-close svg")].find((one) => one.getClientRects().length > 0)!, ...(windowName ? [windowName] : [])].map(middle).map(Math.round),
		};
	});
	const [backBox, mark, close, col] = [await boxOf(back), await boxOf(back.locator("svg")), await boxOf(page.locator(".settings-dialog-close svg").first()), await column(page)];
	return { back, backBox, mark, line, close, col };
}

/** The open add form's Name field has the focus. */
const nameHasFocus = (page: Page) => addPage(page).evaluate((form, name) => {
	const label = [...form.querySelectorAll("label")].find((one) => one.firstElementChild?.textContent === name);
	return !!label && label.querySelector("input") === document.activeElement;
}, WORDS.form.name);

async function checkSubPageHeader(browser: Browser): Promise<void> {
	for (const theme of [LIGHT, DARK] as const) {
		const at = `1440 ${theme}`;
		// 700 tall, so a connector's page scrolls 400 under its title line.
		const page = await openPage(browser, desktop(1440, 700, theme), "on");
		resetWorld();
		await openConnectors(page);
		await listSettled(page, EVERY, at);
		for (const which of ["a connector's page", "By web address", "Program on this computer"] as const) {
			const what = `${at}, ${which}`;
			// Opened from a list scrolled to its end.
			await scrollPane(page, 100000);
			assert((await column(page)).scrollTop > 0, `${what}: the list scrolls`);
			if (which === "a connector's page") await openConnector(page, "wiki");
			else {
				await pane(page).locator(".connector-add-btn").click();
				await page.getByRole("menuitem", { name: which === "By web address" ? WORDS.addWays.web : WORDS.addWays.program }).click();
				await addPage(page).waitFor();
				await still(page, what);
			}
			// As it opens: at its top; a connector's page with the focus on its way back, an add page in its first field.
			same((await column(page)).scrollTop, 0, `${what}: opened at its top`);
			if (which === "a connector's page") assert(await visible(page, ".connector-page-back").evaluate((element) => element === document.activeElement), `${what}: the focus on the way back`);
			else same(await nameHasFocus(page), true, `${what}: the focus in Name`);
			if (which !== "a connector's page") {
				// Long enough to scroll: the fold open and pairs added; then back at the top for the header's reading.
				const form = addPage(page);
				if (which === "By web address") await form.locator(".connector-oauth-toggle").click();
				for (let i = 0; i < (which === "By web address" ? 6 : 13); i++) await form.getByRole("button", { name: which === "By web address" ? WORDS.form.addHeader : WORDS.form.addSetting }).click();
				await scrollPane(page, 0);
			}
			// A hairline left from the list's scroll fades out.
			await waitUntil(async () => { const { shadow } = (await header(page)).line; return !shadow.includes("1px 0px") || /rgba\(0, 0, 0, 0\)|transparent/.test(shadow); }, `${what}: no hairline at the top`).catch(() => {});
			const first = await header(page);
			same([await first.back.getAttribute("aria-label"), await first.back.innerText()], [WORDS.details.backName, ""], `${what}: the arrow alone, named for a screen reader`);
			near(first.mark.left, first.col.left, `${what}: the arrow's mark on the content's left edge`, 1);
			near(first.close.right, first.col.right, `${what}: the close's mark on the content's right edge`, 1);
			same([first.line.height, first.line.position, first.line.top], [56, "sticky", "0px"], `${what}: the title line 56 tall, staying put`);
			same(first.line.types, ["18px/24px", "18px/24px"], `${what}: the name at the window name's size and line`);
			assert(Math.max(...first.line.middles) - Math.min(...first.line.middles) <= 1, `${what}: the arrow, the name, the close and the window's name on one line (${first.line.middles.join(", ")})`);
			same(first.line.fill, await page.evaluate(() => (window as any).__fill([...document.querySelectorAll(".settings-dialog-pane")].find((one) => one.getClientRects().length))), `${what}: the line the pane's colour`);
			assert(!first.line.shadow.includes("1px 0px") || /rgba\(0, 0, 0, 0\)|transparent/.test(first.line.shadow), `${what}: no hairline at the top (${first.line.shadow})`);
			// After a 400 px scroll: unmoved, the hairline shown, a press on the line's middle reaches nothing under it.
			await scrollPane(page, 400);
			await waitUntil(async () => (await column(page)).scrollTop === 400, `${what}: scrolled 400`).catch(async (error) => { const now = await column(page); throw new Error(`${(error as Error).message} (at ${now.scrollTop} of ${now.scrollMax})`); });
			await waitUntil(async () => { const { shadow } = (await header(page)).line; return shadow.includes("1px 0px") && !/rgba\(0, 0, 0, 0\)|transparent/.test(shadow); }, `${what}: the hairline after a scroll`);
			await still(page, what);
			const after = await header(page);
			near(after.backBox.top, first.backBox.top, `${what}: the arrow unmoved after a 400 px scroll`, 0.5);
			near(after.line.nameTop, first.line.nameTop, `${what}: the name unmoved after a 400 px scroll`, 0.5);
			const middle = { x: (after.col.left + after.col.right) / 2, y: (after.backBox.top + after.backBox.bottom) / 2 };
			same(await page.evaluate(({ x, y }) => { const hit = document.elementFromPoint(x, y)!; return hit.closest(".pane-head") !== null; }, middle), true, `${what}: the line's middle is the page's own band`);
			const focusBefore = await page.evaluate(() => document.activeElement?.outerHTML.slice(0, 80));
			await page.mouse.click(middle.x, middle.y);
			same([await page.locator(".ai-profile-menu").count(), await page.evaluate(() => document.activeElement?.outerHTML.slice(0, 80)) === focusBefore || await page.evaluate(() => document.activeElement === document.body)], [0, true], `${what}: a press on the line's middle opens nothing`);
			// Back, and Cancel on an add page, return to the list.
			await after.back.click();
			await pane(page).locator(".connector-list").waitFor();
			if (which !== "a connector's page") {
				await openAdd(page, which === "By web address" ? "web" : "program");
				await addPage(page).getByRole("button", { name: WORDS.form.cancel, exact: true }).click();
				await pane(page).locator(".connector-list").waitFor();
			}
		}
		await page.context().close();
	}
	// At 390: one way back on screen, 44 to the finger, first in the body with the name on its line.
	const page = await openPage(browser, phone(LIGHT), "on");
	resetWorld();
	await openConnectors(page);
	await listSettled(page, EVERY, "390");
	for (const which of ["a connector's page", "By web address", "Program on this computer"] as const) {
		if (which === "a connector's page") await openConnector(page, "wiki");
		else await openAdd(page, which === "By web address" ? "web" : "program");
		const back = visible(page, ".connector-page-back");
		const [box, barBack, first] = [await boxOf(back), await page.locator(".settings-dialog-back").first().isVisible(), await page.evaluate(() => {
			const scroller = [...document.querySelectorAll(".settings-dialog-pane")].find((one) => one.getClientRects().length)!;
			const all = [...scroller.querySelectorAll("*")].filter((element) => element.getClientRects().length && element.getBoundingClientRect().height > 0 && (element.matches(".connector-page-back") || !element.contains(scroller.querySelector(".connector-page-back"))) && getComputedStyle(element).display !== "contents");
			return all.sort((a, b) => a.getBoundingClientRect().top - b.getBoundingClientRect().top)[0]?.className;
		})];
		const ways = await page.evaluate(() => [...document.querySelectorAll(".settings-dialog-back, .connector-page-back")].filter((element) => element.getClientRects().length && getComputedStyle(element).visibility === "visible").length);
		same([ways, barBack ? await page.locator(".settings-dialog-back").first().evaluate((element) => getComputedStyle(element).visibility) : "hidden", box.width, box.height], [1, "hidden", 44, 44], `390, ${which}: one way back on screen, the bar's own hidden, 44 to the finger`);
		near((await header(page)).line.middles[0], (await header(page)).line.middles[1], `390, ${which}: the name on the arrow's line`, 1);
		assert(String(first).includes("connector-page-back"), `390, ${which}: the way back first in the body (first: ${first})`);
		await back.click();
		await pane(page).locator(".connector-list").waitFor();
	}
	await page.context().close();
	// With the switch off, each add form opens with the focus in Name, as today.
	const off = await openPage(browser, desktop(1440, 900, LIGHT), "off");
	resetWorld();
	await openConnectors(off);
	await listSettled(off, EVERY, "switch off");
	for (const kind of ["web", "program"] as const) {
		const form = await openAdd(off, kind);
		same(await nameHasFocus(off), true, `switch off, ${kind}: the focus in Name`);
		await form.getByRole("button", { name: WORDS.form.cancel, exact: true }).click();
	}
	await off.context().close();
	console.log("  ok  a connector's page and both add pages, both themes at 1440: opened from a list scrolled to its end at their top, a connector's page with the focus on the way back, an add page with it in Name (as with the switch off); the arrow alone, named for a screen reader, its mark on the content's left edge and the close's on its right; the name 18/24 as the window's, on one line with the arrow, the close and the window's name; the line 56 tall, unmoved after a 400 px scroll, its hairline only then; a press on its middle reaches nothing; back and Cancel return to the list; at 390 one way back, 44 to the finger, first in the body with the name on its line");
}

/** The identity and its line, the Status row and the facts, measured on the open connector's page. */
const measurePage = (page: Page) => connectorPage(page).evaluate((root) => {
	const box = (element: Element | null) => { if (!element) return null; const { left, right, top, bottom, width, height } = element.getBoundingClientRect(); return { left, right, top, bottom, width, height }; };
	const facts = [...root.querySelectorAll(".connector-facts > .connector-fact")].map((fact) => ({
		label: fact.querySelector(".settings-row-label")!.textContent,
		row: box(fact)!,
		labelBox: box(fact.querySelector(".settings-row-label"))!,
		value: box(fact.querySelector(".connector-fact-value, .connector-edit")),
		// A row's last button: where a row has two (Reconnect, Disconnect), the last ends the row.
		button: box([...fact.querySelectorAll(".connector-fact-value > :is(button, a)")].at(-1) ?? null),
	}));
	const head = root.querySelector(".pane-head")!;
	const row = root.querySelector(".connector-fact-status")!;
	const words = row.querySelector(".connector-status-words")!;
	const line = document.createRange();
	line.selectNodeContents(words);
	return {
		tile: box(head.querySelector(".connector-avatar"))!,
		name: box(head.querySelector("h2"))!,
		nameWords: (() => { const range = document.createRange(); range.selectNodeContents(head.querySelector("h2")!); const { right } = range.getBoundingClientRect(); return right; })(),
		nameTip: head.querySelector("h2")!.getAttribute("title"),
		tag: box(head.querySelector(".pane-head-beside")),
		tagOffLine: (() => {
			// How far the tag's words stand off the name's own line of letters: an empty box on each baseline.
			const lines = [head.querySelector("h2"), head.querySelector(".pane-head-beside")].map((one) => {
				if (!one) return null;
				const probe = document.createElement("span");
				probe.style.cssText = "display:inline-block;width:0;height:0";
				one.prepend(probe);
				const { bottom } = probe.getBoundingClientRect();
				probe.remove();
				return bottom;
			});
			return lines[0] === null || lines[1] === null ? null : Math.round(lines[1] - lines[0]);
		})(),
		// The head holds the way back, the tile, the name and the tag, and nothing else.
		headParts: [...head.children].flatMap((one) => (one.matches(".pane-head-text") ? [...one.children] : [one])).map((one) => one.tagName.toLowerCase()),
		headLine: box(head)!,
		statusFirst: root.querySelector(".connector-facts > .connector-fact") === row,
		status: words.textContent,
		announced: words.getAttribute("role"),
		dot: [...row.querySelector(".connector-dot")!.classList].join(" ").replace("connector-dot connector-dot-", ""),
		dotBox: box(row.querySelector(".connector-dot"))!,
		wordsLine: (() => { const { left, top, bottom } = line.getClientRects()[0]; return { left, top, bottom }; })(),
		wordsBox: box(words)!,
		note: row.querySelector(".connector-status-note")?.textContent ?? null,
		statusButtons: [...row.querySelectorAll(".connector-fact-value > :is(button, a), .connector-fact-value > * > :is(button, a)")].filter((one) => one.matches(".rs-btn, .connector-slot-btn")).map((button) => ({ words: button.textContent, box: box(button)! })),
		facts,
		lead: root.querySelector(".pane-lead")?.textContent ?? null,
	};
});

/** What a connector's page says in its Status row in each state, with the row's button, and the other facts' labels.
 * `wrong` takes the state's words' place. */
type Want = { state: string; dot: string; wrong: string | null; button: string; /** The check after the words, where the button is the step they name; that step has no button on its own row. */ check?: { row: string }; note?: string; facts: string[] };
const STATES: Partial<Record<Key, Want>> = {
	wiki: { state: WORDS.status.connected, dot: "ok", wrong: null, button: WORDS.button.checkConnection, facts: [WORDS.details.address, WORDS.details.signIn, WORDS.details.usedIn] },
	office: { state: WORDS.status.connected, dot: "ok", wrong: null, button: WORDS.button.checkConnection, facts: [WORDS.details.runs, WORDS.details.usedIn] },
	fresh: { state: WORDS.status.program, dot: "ring", wrong: null, button: WORDS.button.checkConnection, facts: [WORDS.details.runs, WORDS.details.usedIn] },
	ticket: { state: WORDS.status.cantConnect, dot: "err", wrong: `${WORDS.wentWrong.addressNotFound.fact} ${WORDS.wentWrong.addressNotFound.way}`, button: WORDS.button.changeAddress, check: { row: WORDS.details.address }, facts: [WORDS.details.address, WORDS.details.key, WORDS.details.usedIn] },
	slow: { state: WORDS.status.notAnswering, dot: "err", wrong: `${WORDS.wentWrong.noAnswer.fact} ${WORDS.wentWrong.noAnswer.way}`, button: WORDS.button.tryAgain, facts: [WORDS.details.address, WORDS.details.key, WORDS.details.usedIn] },
	keyed: { state: WORDS.status.cantConnect, dot: "err", wrong: `${WORDS.wentWrong.keyRefused.fact} ${WORDS.wentWrong.keyRefused.way}`, button: WORDS.button.changeKey, check: { row: WORDS.details.key }, facts: [WORDS.details.address, WORDS.details.usedIn] },
	tracker: { state: WORDS.status.signingIn, dot: "busy", wrong: null, button: WORDS.button.cancel, note: WORDS.signingInNote, facts: [WORDS.details.address, WORDS.details.key, WORDS.details.usedIn] },
	long: { state: WORDS.status.notConnected, dot: "wait", wrong: null, button: WORDS.button.connect, facts: [WORDS.details.address, WORDS.details.key, WORDS.details.usedIn] },
	imported: { state: WORDS.status.program, dot: "ring", wrong: null, button: WORDS.button.checkConnection, facts: [WORDS.details.runs, WORDS.details.usedIn] },
};

/** A connector's page against what its state wants: its head, the Status row, its button and the other facts, with their measures. */
async function readIdentity(page: Page, opened: Locator, what: string, wanted: Want, width: 1440 | 390, colour: Awaited<ReturnType<typeof tokens>>) {
	const labelColumn = width === 390 ? 112 : 160;
	const m = await measurePage(page);
	// What went wrong is said once, in the state's place; the first row is Status in every state.
	same([m.status, m.dot, m.note, m.statusButtons.map((one) => one.words), m.facts.map((fact) => fact.label), m.lead], [wanted.wrong ?? wanted.state, wanted.dot, wanted.note ?? null, [wanted.button], [WORDS.details.status, ...wanted.facts], null], `${what}: the Status row's words, dot, note and button, and the facts`);
	if (wanted.check) await checkAfterWords(page, opened, what, wanted.button, wanted.check.row, width, colour);
	else if (wanted.button !== WORDS.button.checkConnection) same(await opened.getByRole("button", { name: WORDS.button.checkConnection, exact: true }).count(), 0, `${what}: no Check connection beside ${wanted.button}`);
	same([m.statusFirst, m.announced], [true, "status"], `${what}: Status the box's first row, its words said when they change`);
	// The head is one line: no state, no button but the way back, no second line.
	same(m.headParts, ["button", "span", "h2", ...(m.tag ? ["span"] : [])], `${what}: the head's parts: the arrow, the tile, the name and its tag`);
	same([m.tile.width, m.tile.height, await styleOf(opened.locator(".pane-head > .connector-avatar"), ["border-radius"]).then((style) => style["border-radius"])], [24, 24, "6px"], `${what}: the tile 24, radius 6`);
	same([await textLook(opened.locator(".pane-head h2")), (await styleOf(opened.locator(".pane-head h2"), ["font-family"]))["font-family"].includes("Bandeins")], ["18px/24px 700", true], `${what}: the name 18/24 in the display face`);
	if (width === 1440) same(Math.round(m.headLine.height), 56, `${what}: the head one line of 56`);
	near(m.name.left - m.tile.right, 10, `${what}: the name 10 after the tile`);
	same(m.nameTip, await opened.locator(".pane-head h2").innerText(), `${what}: the whole name in its tip`);
	// The status words are help-sized, as every row's words are (one scale, 44), in the text colour.
	same([await textLook(opened.locator(".connector-status-words")), await seen(opened.locator(".connector-status-words"), "color")], ["13px/18px 400", colour.text], `${what}: the status words 13/18 in the text colour`);
	if (m.tag) {
		same([await textLook(opened.locator(".pane-head-beside")), await seen(opened.locator(".pane-head-beside"), "color")], ["13px/18px 400", colour.muted], `${what}: the tag 13/18 muted`);
		same(m.tagOffLine, 0, `${what}: the tag on the name's baseline`);
		if (width === 1440) near(m.tag.left - m.nameWords, 10, `${what}: the tag 10 after the name`);
	}
	// The dot, then the words, in the value column; a wrapped sentence stays in it, its button on its first line and never over it, or on a phone under it.
	near(m.wordsLine.left - m.dotBox.right, 6, `${what}: the words 6 after their dot`);
	for (const button of m.statusButtons) {
		// On a phone only words of one line that leave the button room keep it beside them.
		if (width === 390 && button.box.top >= m.wordsBox.bottom) continue;
		assert(width === 1440 || m.wordsBox.bottom - m.wordsBox.top < 20, `${what}: ${button.words} under the wrapped words (${button.box.top} against ${m.wordsBox.bottom})`);
		near((button.box.top + button.box.bottom) / 2, (m.wordsLine.top + m.wordsLine.bottom) / 2, `${what}: ${button.words} on the words' first line`, 1);
		assert(m.wordsBox.right <= button.box.left, `${what}: the words end before ${button.words} (${m.wordsBox.right} against ${button.box.left})`);
	}
	// The facts: 44 or more, the values at one x 172 after the labels' start, the buttons 28 tall on one right edge.
	const col = await column(page);
	same(m.facts.filter((fact) => fact.row.height < 44).map((fact) => fact.label), [], `${what}: facts under 44 tall`);
	same([...new Set(m.facts.map((fact) => Math.round((fact.value!.left - fact.labelBox.left) * 2) / 2))], [labelColumn + 12], `${what}: every value at one x, ${labelColumn + 12} after its label`);
	const buttons = m.facts.flatMap((fact) => (fact.button ? [fact.button] : []));
	same([...new Set(buttons.map((button) => button.height))].filter((h) => h !== (width === 390 ? 44 : 28)), [], `${what}: every row button ${width === 390 ? 44 : 28} tall`);
	same([...new Set(buttons.map((button) => Math.round(button.right)))], [...new Set(buttons.map((button) => Math.round(button.right)))].slice(0, 1), `${what}: the row buttons on one right edge`);
	if (buttons.length) near(buttons[0].right, col.right - 16, `${what}: the row buttons at the card's right padding`, 1);
	// Each label on its value's first line, and one dot, the Status row's.
	same(await factLabelsOffLine(opened), [], `${what}: labels off their value's first line`);
	same(await opened.locator(".connector-facts .connector-dot").evaluateAll((all) => all.filter((one) => one.getClientRects().length).map((one) => one.closest(".connector-fact-status") !== null)), [true], `${what}: the Status row's dot the only one`);
	await statusFromEdge(opened, what, width);
	await nothingSideways(page, what);
}

/** The Status row's first line stands as far from the card's edge as a one-line row's words from their line; on a phone, with its 44 button beside it, on the button's middle. */
async function statusFromEdge(opened: Locator, what: string, width: 1440 | 390): Promise<void> {
	const read = await opened.locator(".connector-facts").evaluate((facts) => {
		const from = (row: Element) => {
			const label = row.querySelector(".settings-row-label")!.getBoundingClientRect();
			return label.top - row.getBoundingClientRect().top - parseFloat(getComputedStyle(row).borderTopWidth);
		};
		const status = facts.querySelector(".connector-fact-status")!;
		const button = status.querySelector(".connector-fact-value > :is(.rs-btn, .connector-slot-btn)")?.getBoundingClientRect();
		const words = status.querySelector(".connector-status-text > p")!.getBoundingClientRect();
		return { status: from(status), rooms: from(facts.querySelector(".connector-fact-rooms")!), beside: button ? button.top < words.bottom : false };
	});
	if (width === 390 && read.beside) near(read.status, 21, `${what}: Status on the middle of the button beside it`, 1);
	else near(read.status, read.rooms, `${what}: Status as far from the card's edge as Rooms from its line`, 1);
}

/**
 * Where the words name the step: the Status row's button is it and its own row
 * has none, and Check connection is a quiet underlined text button after the
 * words, in the look of "Check now": in the text's column, 44 to a finger,
 * its whole target its own.
 */
async function checkAfterWords(page: Page, opened: Locator, what: string, step: string, stepRow: string, width: 1440 | 390, colour: Awaited<ReturnType<typeof tokens>>): Promise<void> {
	const row = opened.locator(".connector-fact").filter({ has: page.locator(".settings-row-label", { hasText: new RegExp(`^${stepRow}$`) }) });
	same([await opened.getByRole("button", { name: step, exact: true }).count(), await row.getByRole("button").count(), await opened.getByRole("button", { name: WORDS.button.checkConnection, exact: true }).count()], [1, 0, 1], `${what}: ${step} once, in the Status row, and Check connection once`);
	const check = opened.locator(".connector-fact-status").getByRole("button", { name: WORDS.button.checkConnection, exact: true });
	const read = await check.evaluate((button) => {
		const words = button.closest(".connector-status-text")!.querySelector(".connector-status-words")!;
		const line = document.createRange();
		line.selectNodeContents(words);
		const last = [...line.getClientRects()].at(-1)!;
		const step = button.closest(".connector-fact-value")!.querySelector(":scope > .connector-slot-btn")!.getBoundingClientRect();
		const inside = document.createRange();
		inside.selectNodeContents(button);
		const own = [...inside.getClientRects()];
		const box = button.getBoundingClientRect();
		const after = getComputedStyle(button, "::after");
		const high = parseFloat(after.height) || box.height;
		const reach = { top: box.top - (high - box.height) / 2, height: high };
		const text = getComputedStyle(words);
		const style = getComputedStyle(button);
		// Each corner and the middle of what a finger can press, whole and its own.
		const spots = [[box.left + 2, reach.top + 2], [box.right - 2, reach.top + 2], [box.left + 2, reach.top + reach.height - 2], [box.right - 2, reach.top + reach.height - 2], [(box.left + box.right) / 2, box.top + box.height / 2]];
		return {
			inLive: words.contains(button),
			lines: own.length,
			follows: Math.round(last.top) === Math.round(box.top) ? Math.round(box.left - last.right) : null,
			besideStep: box.right <= step.left || box.bottom <= step.top,
			size: style.fontSize === text.fontSize && style.lineHeight === text.lineHeight,
			underlined: style.textDecorationLine,
			reach: Math.round(reach.height),
			covered: spots.flatMap(([x, y], i) => { const hit = document.elementFromPoint(x, y); return hit === button || button.contains(hit) ? [] : [`${["top left", "top right", "bottom left", "bottom right", "middle"][i]}: ${hit?.className || hit?.tagName}`]; }),
			techCovered: [...button.closest(".connector-status-text")!.querySelectorAll(".connector-tech > summary")].map((one) => one.getBoundingClientRect()).flatMap((one) => [[one.left + 2, one.top + 2], [one.right - 2, one.top + 2], [(one.left + one.right) / 2, one.bottom - 2]]).filter(([x, y]) => !document.elementFromPoint(x, y)?.closest(".connector-tech")).length,
			stepCovered: [[step.left + 2, step.top + 2], [step.right - 2, step.top + 2], [(step.left + step.right) / 2, step.bottom - 2]].filter(([x, y]) => !(document.elementFromPoint(x, y)?.closest(".connector-slot-btn"))).length,
		};
	});
	same([read.inLive, read.lines, read.size, read.underlined, read.besideStep], [false, 1, true, "underline", true], `${what}: Check connection after the words, underlined, in one piece, at their size, not over ${step}`);
	if (read.follows !== null) assert(read.follows > 0 && read.follows <= 6, `${what}: a space after the words (${read.follows})`);
	same(await seen(check, "color"), colour.muted, `${what}: Check connection quiet`);
	same([read.covered, read.stepCovered, read.techCovered], [[], 0, 0], `${what}: spots of Check connection's, ${step}'s and Technical details' targets that something else covers`);
	if (width === 390) assert(read.reach >= 44, `${what}: Check connection 44 to the finger (${read.reach})`);
	// It really checks again: put right, the page says Connected, and gone, the same words.
	const id = await opened.locator(".connector-page-head h2, .pane-head h2").first().innerText() === C.ticket.name ? C.ticket.id : C.keyed.id;
	const was = await opened.locator(".connector-status-words").innerText();
	checkOverrides.set(id, { ok: true, toolCount: 1, toolNames: ["search_pages"] });
	await check.click();
	await opened.locator(".connector-status-words", { hasText: WORDS.status.connected }).waitFor({ timeout: 15000 });
	checkOverrides.delete(id);
	await opened.getByRole("button", { name: WORDS.button.checkConnection, exact: true }).click();
	await opened.locator(".connector-status-words", { hasText: was }).waitFor({ timeout: 15000 });
	await still(page, what);
}

async function checkConnectorPage(browser: Browser): Promise<void> {
	for (const [width, theme] of [[1440, LIGHT], [1440, DARK], [390, LIGHT]] as const) {
		const at = `${width} ${theme}`;
		const page = await openPage(browser, width === 390 ? phone(theme) : desktop(1440, 900, theme), "on");
		resetWorld();
		await openConnectors(page);
		await listSettled(page, EVERY, at);
		const colour = await tokens(page);
		for (const key of EVERY) {
			const what = `${at}, ${C[key].name}`;
			const opened = await openConnector(page, key);
			await readIdentity(page, opened, what, STATES[key]!, width, colour);
			// Two words, two letters, as the list's tile has them, and inside the tile.
			if (key === "ticket") same(await opened.locator(".pane-head > .connector-avatar").evaluate((tile) => { const words = document.createRange(); words.selectNodeContents(tile); return [tile.textContent, words.getBoundingClientRect().width <= tile.clientWidth]; }), ["TD", true], `${what}: the tile's letters`);
			if (key === "wiki" && width === 1440) {
				// A name too long for the line is cut before the close, the arrow and the tag on its line.
				const cut = await opened.evaluate((root) => {
					const name = root.querySelector<HTMLElement>(".pane-head h2")!;
					const was = name.textContent;
					name.textContent = "A connector with a name far too long for the line ".repeat(4).trim();
					const close = [...document.querySelectorAll(".settings-dialog-close")].find((one) => one.getClientRects().length > 0)!.getBoundingClientRect();
					const beside = root.querySelector(".pane-head-beside")?.getBoundingClientRect().right ?? name.getBoundingClientRect().right;
					const read = [name.scrollWidth > name.clientWidth, getComputedStyle(name).textOverflow, beside <= close.left, Math.round(root.querySelector(".pane-head")!.getBoundingClientRect().height)];
					name.textContent = was;
					return read;
				});
				same(cut, [true, "ellipsis", true, 56], `${what}: a long name cut before the close, on its one line`);
			}
			if (key === "ticket" && width === 1440) {
				// The button that follows a wrapped sentence stays on its first line: the sentence made to wrap.
				const wrapped = await opened.evaluate((root) => {
					const words = root.querySelector(".connector-status-words")!;
					const was = words.textContent;
					words.textContent = `${was} `.repeat(4).trim();
					const range = document.createRange();
					range.selectNodeContents(words);
					const lines = [...range.getClientRects()];
					const button = root.querySelector(".connector-fact-status .connector-fact-value > :is(.rs-btn, .connector-slot-btn)")!.getBoundingClientRect();
					const label = root.querySelector(".connector-fact-status .settings-row-label")!.getBoundingClientRect();
					const tech = root.querySelector(".connector-fact-status .connector-tech")!.getBoundingClientRect();
					const read = { lines: new Set(lines.map((line) => Math.round(line.top))).size > 1, button: Math.abs((button.top + button.bottom) / 2 - (lines[0].top + lines[0].bottom) / 2) <= 2, label: Math.abs(label.top + label.height / 2 - (lines[0].top + lines[0].bottom) / 2) <= 1.5, clear: Math.max(...lines.map((line) => line.right)) <= button.left, tech: [Math.round(tech.left - words.getBoundingClientRect().left), tech.top >= lines.at(-1)!.bottom] };
					words.textContent = was;
					return read;
				});
				same(wrapped, { lines: true, button: true, label: true, clear: true, tech: [0, true] }, `${what}: a sentence that wraps stays in its column, "Status" and the button on its first line, Technical details under it at its left edge`);
			}
			if (key === "office" && width === 390) {
				// Its command breaks between its words, a flag whole.
				const breaks = await lineBreaks(opened.locator(".connector-facts code.connector-command"));
				assert(breaks.length > 0 && breaks.every((last) => last === " "), `${what}: the command breaks between its words (lines end with ${JSON.stringify(breaks)})`);
			}
			if (key === "wiki" && width === 390) {
				// Its address wraps after a "/", not inside a word.
				const breaks = await lineBreaks(opened.locator(".connector-facts .connector-address"));
				assert(breaks.length > 0 && breaks.every((last) => last === "/"), `${what}: the address breaks after a "/" (lines end with ${JSON.stringify(breaks)})`);
			}
			if (key === "wiki") {
				// The rooms as sentence links, underlined at 40 %.
				const link = opened.locator(".connector-rooms a").first();
				const s = await styleOf(link, ["text-decoration-line", "text-decoration-color", "text-underline-offset"]);
				same([s["text-decoration-line"], s["text-underline-offset"], (await opened.locator(".connector-rooms a").allInnerTexts()).sort()], ["underline", "3px", [OTHER_ROOM, ROOM].sort()], `${what}: the rooms as links`);
			}
			if (key === "ticket") {
				// Technical details by pointer and by keyboard.
				const fold = opened.locator(".connector-tech");
				await fold.locator("summary").click();
				assert(await fold.evaluate((element) => (element as HTMLDetailsElement).open), `${what}: Technical details opens by pointer`);
				same(await textLook(fold.locator("code")), "12px/18px 400", `${what}: its text 12/18`);
				// Its first line on Copy's middle.
				const [text, copy] = [await firstLine(fold.locator("code")), await boxOf(fold.locator(".connector-tech-body > .rs-btn"))];
				near((text.top + text.bottom) / 2, (copy.top + copy.bottom) / 2, `${what}: Technical details' first line on Copy's middle`, 1);
				assert((await styleOf(fold.locator("code"), ["font-family"]))["font-family"].toLowerCase().includes("mono"), `${what}: its text mono`);
				await fold.locator("summary").press("Enter");
				assert(!(await fold.evaluate((element) => (element as HTMLDetailsElement).open)), `${what}: and shuts by keyboard`);
				// Change address: Save ink, then Cancel quiet; Enter saves, Escape leaves.
				await opened.getByRole("button", { name: WORDS.button.changeAddress }).first().click();
				const edit = opened.locator(".connector-edit");
				await edit.waitFor();
				const foot = edit.locator(".connector-edit-foot > button");
				same(await foot.allInnerTexts(), [WORDS.button.save, WORDS.button.cancel], `${what}: Save, then Cancel`);
				same(await inkedOn(page, theme), [WORDS.button.save], `${what}: Save the one ink button`);
				same(await foot.nth(1).getAttribute("class"), "rs-btn rs-btn-quiet", `${what}: Cancel quiet`);
				const [input, save, cancel, value] = [await boxOf(edit.locator("input").first()), await boxOf(foot.nth(0)), await boxOf(foot.nth(1)), await boxOf(edit)];
				near(save.left, value.left, `${what}: Save on the value's left edge`);
				near(cancel.left - save.right, 8, `${what}: Cancel 8 after Save`);
				// A field fills the room it is given (one form rule, 44).
				near(input.width, value.width, `${what}: the field the value column's width`);
				await statusFromEdge(opened, `${what}, its address being changed`, width);
				// Save waits for a changed address, as today; changed, Tab goes from the field to Save, then to Cancel.
				await edit.locator("input").first().press("End");
				await page.keyboard.type("x");
				await edit.locator("input").first().press("Tab");
				same(await page.evaluate(() => document.activeElement?.textContent), WORDS.button.save, `${what}: Tab reaches Save after the field`);
				await page.keyboard.press("Tab");
				same(await page.evaluate(() => document.activeElement?.textContent), WORDS.button.cancel, `${what}: Tab reaches Cancel after Save`);
				await page.keyboard.press("Escape");
				await edit.waitFor({ state: "detached" });
			}
			if (key === "long") {
				await nothingSideways(page, `${what}, its long address`);
				const address = await boxOf(opened.locator(".connector-address"));
				assert(address.height > 18 && address.right <= (await column(page)).right - 16, `${what}: the 200-character address wraps inside its card`);
			}
			await backToList(page);
		}
		// A notice after a key or an address is saved: a strip with a green dot under the identity.
		if (width === 1440) {
			await openConnector(page, "ticket");
			await page.route("**/api/mcp/servers/*/address", (route) => route.fulfill({ json: { sameSite: true } }));
			await connectorPage(page).getByRole("button", { name: WORDS.button.changeAddress }).first().click();
			const input = connectorPage(page).locator(".connector-edit input").first();
			await input.fill(`${NOWHERE}/moved`);
			await input.press("Enter");
			const notice = connectorPage(page).locator(".connector-notice");
			await notice.waitFor({ timeout: 10000 });
			const s = await styleOf(notice, ["border-radius", "min-height", "display"]);
			same([s["border-radius"], s["min-height"], await seen(notice, "background-color", "::before")], ["12px", "40px", colour.ok], `${at}: the notice a strip with a green dot`);
			const [head, strip] = [await boxOf(connectorPage(page).locator(".pane-head")), await boxOf(notice)];
			near(strip.top - head.bottom, 12, `${at}: the notice 12 under the head's line`);
			await page.unroute("**/api/mcp/servers/*/address");
			await backToList(page);
		}
		// A program getting ready: its state and its note in the Status row, with Cancel.
		const releaseFresh = holdCheck(C.fresh.id, { ok: true, toolCount: 0, toolNames: [] });
		const fresh = await openConnector(page, "fresh");
		await fresh.getByRole("button", { name: WORDS.button.checkConnection }).click();
		await fresh.locator(".connector-status-words", { hasText: WORDS.status.gettingReady }).waitFor({ timeout: 15000 });
		await page.mouse.move(5, 5);
		await readIdentity(page, fresh, `${at}, getting ready`, { state: WORDS.status.gettingReady, dot: "busy", wrong: null, button: WORDS.button.cancel, note: WORDS.gettingReadyNote, facts: [WORDS.details.runs, WORDS.details.usedIn] }, width, colour);
		const note = fresh.locator(".connector-status-note");
		same([await textLook(note), await seen(note, "color")], ["13px/18px 400", colour.muted], `${at}, getting ready: the note 13/18 muted`);
		near((await boxOf(note)).left, (await boxOf(fresh.locator(".connector-status-words"))).left, `${at}, getting ready: the note under the words at their left edge`);
		const cancel = fresh.locator(".connector-fact-status").getByRole("button", { name: WORDS.button.cancel, exact: true });
		same((await cancel.getAttribute("class"))!.includes("rs-btn-sm"), true, `${at}, getting ready: Cancel small`);
		await cancel.click();
		await fresh.locator(".connector-status-words", { hasText: WORDS.status.gettingReady }).waitFor({ state: "detached" });
		releaseFresh();
		await answered(page, `${at}, getting ready cancelled`);
		await backToList(page);
		// The states a step brings, each read as the others are.
		// held: its check waits, so the page has a request out.
		const reachedBy = async (key: Key, button: string, state: string, held = false) => {
			const opened = await openConnector(page, key);
			await opened.getByRole("button", { name: button, exact: true }).first().click();
			await opened.locator(".connector-status-words", { hasText: state }).waitFor({ timeout: 15000 });
			if (!held) await answered(page, `${at}, ${state}`);
			await page.mouse.move(5, 5);
			await still(page, `${at}, ${state}`);
			return opened;
		};
		// Checking a signed-in connector: Reconnect waits for the check, whose end would otherwise end the sign-in it started.
		const releaseWiki = holdCheck(C.wiki.id, CHECK_ANSWERS[C.wiki.id]);
		let opened = await reachedBy("wiki", WORDS.button.checkConnection, WORDS.status.checking, true);
		const reconnect = opened.locator(".connector-fact").filter({ hasText: WORDS.details.signIn }).getByRole("button", { name: WORDS.button.reconnect, exact: true });
		same(await reconnect.isDisabled(), true, `${at}, checking a signed-in connector: Reconnect waits for the check`);
		releaseWiki();
		await opened.locator(".connector-status-words", { hasText: WORDS.status.checking }).waitFor({ state: "detached" });
		same(await reconnect.isDisabled(), false, `${at}, the check ended: Reconnect can be pressed`);
		await backToList(page);
		// Sign-in expired: a check that finds Team wiki's sign-in turned down; Reconnect the Status row's step.
		checkOverrides.set(C.wiki.id, { ok: false, needsAuth: true, httpStatus: 401 });
		opened = await reachedBy("wiki", WORDS.button.checkConnection, WORDS.status.needsReconnecting);
		await readIdentity(page, opened, `${at}, sign-in expired`, { state: WORDS.status.needsReconnecting, dot: "warn", wrong: null, button: WORDS.button.reconnect, facts: [WORDS.details.address, WORDS.details.usedIn] }, width, colour);
		await backToList(page);
		// A sign-in that failed: Long address's Connect, its sign-in ending with no reason the service gave; Try again the
		// Status row's step, what failed named in the Sign-in row.
		signInEnds.set(C.long.id, "other");
		opened = await reachedBy("long", WORDS.button.connect, lineText(WORDS.signInFailed.other, false));
		await readIdentity(page, opened, `${at}, a sign-in that failed`, { state: WORDS.status.signInFailed, dot: "err", wrong: lineText(WORDS.signInFailed.other, false), button: WORDS.button.tryAgain, facts: [WORDS.details.address, WORDS.details.key, WORDS.details.signIn, WORDS.details.usedIn] }, width, colour);
		same((await opened.locator(".connector-fact").filter({ hasText: WORDS.details.signIn }).locator(".connector-fact-value").allInnerTexts()).at(-1), WORDS.status.signInFailed, `${at}, a sign-in that failed: the Sign-in row says so, with no button of its own`);
		await backToList(page);
		// Checking: Slow desk's Try again, its check held; the pressed button stays, busy and disabled.
		const releaseSlow = holdCheck(C.slow.id, CHECK_ANSWERS[C.slow.id]);
		opened = await reachedBy("slow", WORDS.button.tryAgain, WORDS.status.checking, true);
		await readIdentity(page, opened, `${at}, checking`, { state: WORDS.status.checking, dot: "busy", wrong: null, button: WORDS.button.tryAgain, facts: [WORDS.details.address, WORDS.details.key, WORDS.details.usedIn] }, width, colour);
		const busy = opened.locator(".connector-fact-status .connector-slot-btn");
		same([await busy.isDisabled(), await busy.getAttribute("aria-busy")], [true, "true"], `${at}, checking: Try again busy and waiting`);
		releaseSlow();
		await opened.locator(".connector-status-words", { hasText: STATES.slow!.wrong! }).waitFor();
		await backToList(page);
		// A program that failed: Fresh files' check finds no such program; Try again, and Technical details.
		checkOverrides.set(C.fresh.id, { ok: false, error: "spawn never-started-connector ENOENT", programFailure: { cause: "not-found", program: "never-started-connector" } });
		opened = await reachedBy("fresh", WORDS.button.checkConnection, lineText(WORDS.wentWrong.programMissing("never-started-connector"), false));
		await readIdentity(page, opened, `${at}, a program that failed`, { state: WORDS.status.cantStart, dot: "err", wrong: lineText(WORDS.wentWrong.programMissing("never-started-connector"), false), button: WORDS.button.tryAgain, facts: [WORDS.details.runs, WORDS.details.usedIn] }, width, colour);
		same(await opened.locator(".connector-status-text > .connector-tech > summary").innerText(), WORDS.details.technicalDetails, `${at}, a program that failed: Technical details under its line`);
		same([await opened.getByRole("button", { name: WORDS.button.tryAgain, exact: true }).count(), await opened.getByRole("button", { name: WORDS.button.checkConnection, exact: true }).count()], [1, 0], `${at}, a program that failed: its one check is Try again`);
		await backToList(page);
		// Can't start: the status answer says a room can change Office files' files; at 390 a room with a long name too.
		await closeWindow(page);
		startRefusedFor = C.office.id;
		const longRoom = "Quarterly financial planning and reporting board";
		if (width === 390) longRoomName = longRoom;
		await openConnectors(page);
		await listSettled(page, EVERY, `${at}, can't start`);
		opened = await openConnector(page, "office");
		await readIdentity(page, opened, `${at}, can't start`, { state: WORDS.status.cantStart, dot: "err", wrong: lineText(WORDS.wentWrong.cantStart(ROOM), false), button: WORDS.button.checkConnection, facts: [WORDS.details.runs, WORDS.details.usedIn] }, width, colour);
		await backToList(page);
		startRefusedFor = null;
		if (width === 390) {
			// A room with a long name: its link wraps in the value's column, nothing sideways.
			const wiki = await openConnector(page, "wiki");
			const link = wiki.locator(".connector-rooms a", { hasText: longRoom });
			const [linkBox, value] = [await boxOf(link), await boxOf(wiki.locator(".connector-fact-rooms > .connector-fact-value"))];
			assert(linkBox.right <= value.right + 0.5 && linkBox.height > 20, `${at}: a long room name wraps in the value's column (${JSON.stringify([linkBox.right, value.right, linkBox.height])})`);
			await nothingSideways(page, `${at}, a long room name`);
			longRoomName = null;
		}
		await page.context().close();
	}
	console.log("  ok  a connector's page in every state (sign-in expired, a sign-in that failed, checking, a program that failed and can't start among them), 1440 both themes and 390: the head one line of the arrow, a tile of 24, the name 18/24 display (cut before the close when long, whole in its tip) and its quiet tag; Status the box's first row, its dot and words, or what went wrong in their place, its one step on the first line, a wrapped sentence in its column with Technical details under it (at 390 the step under them); facts 44 or more, values at one x 172 (124 at 390) after their labels, each label on its value's first line, one dot, buttons on one right edge; a sign-in's and a program's note under the words; at 390 a command breaking between its words; the rooms as links; Technical details by pointer and keyboard, its first line on Copy's middle; at 390 the address breaking after a slash; Change address with Save ink then Cancel quiet; a 200-character address wrapping; a saved address's notice a strip with a green dot; a program getting ready with its note under the words and a small Cancel; at 390 a long room name wrapping");
}

async function checkTools(browser: Browser): Promise<void> {
	for (const [width, theme] of [[1440, LIGHT], [1440, DARK], [390, LIGHT]] as const) {
		const at = `${width} ${theme}`;
		const page = await openPage(browser, width === 390 ? phone(theme) : desktop(1440, 900, theme), "on");
		resetWorld();
		await openConnectors(page);
		await listSettled(page, EVERY, at);
		const colour = await tokens(page);
		const opened = await openConnector(page, "wiki");
		const rows = () => opened.locator(".connector-tool").evaluateAll((all) => all.map((element) => {
			const { top, bottom, height, left, right } = element.getBoundingClientRect();
			const select = element.querySelector(".connector-choice-btn, .connector-choice-words, .connector-choice > .connector-slot-btn");
			const face = element.querySelector(".connector-choice-btn .connector-slot-label");
			const chevron = element.querySelector(".connector-choice-chevron");
			const box = (one: Element | null) => (one ? one.getBoundingClientRect().toJSON() as DOMRect : null);
			return { tool: element.getAttribute("data-tool"), top, bottom, height, left, right, select: box(select), selectKind: select?.className ?? "", face: box(face), chevron: box(chevron), line: element.querySelector(".settings-row-sub")?.getAttribute("title") ?? null, lineCut: (() => { const sub = element.querySelector<HTMLElement>(".settings-row-sub"); return sub ? sub.scrollWidth > sub.clientWidth : false; })(), words: element.querySelector(".connector-choice-words")?.textContent ?? null };
		}));
		// The section and group titles, a section's label 13/20 at 600 (44), 8 above their cards.
		for (const kicker of await opened.locator(".connector-tools-kicker").all()) {
			same(await textLook(kicker), "13px/20px 600", `${at}: a group's title 13/20 at 600`);
			same(await seen(kicker, "color"), colour.soft, `${at}: a group's title in soft text`);
			const [title, card] = [await boxOf(kicker), await boxOf(kicker.locator("xpath=following-sibling::*[1]"))];
			near(card.top - title.bottom, 8, `${at}: a group's title 8 above its card`);
		}
		same(await textLook(opened.locator(".connector-tools-group .settings-group-kicker")), "13px/20px 600", `${at}: Tools 13/20 at 600`);
		const help = opened.locator(".connector-tools-line");
		same([await textLook(help), await seen(help, "color"), (await boxOf(help)).right], ["13px/18px 400", colour.muted, (await column(page)).right], `${at}: the tools' help 13/18 muted, to the box's edge`);
		const check = opened.getByRole("button", { name: WORDS.button.checkConnection });
		same([await check.evaluate((button) => button.closest(".connector-fact-status") !== null), (await check.getAttribute("class"))!.includes("rs-btn-sm"), await opened.locator(".connector-tools-group .group-head :is(button, a)").count()], [true, true, 0], `${at}: Check connection small, in the Status row, and no button on the Tools heading`);
		same((await opened.locator(".connector-tool").allInnerTexts()).filter((words) => /\bDefault\b/.test(words)), [], `${at}: no tool row says Default`);
		let read = await rows();
		same(read.map((one) => one.tool), ["search_pages", "get_page", "list_spaces", "read_page_resource", "create_page", "move_page", "delete_page", "archive_page"], `${at}: the tools in their groups`);
		if (width === 1440) {
			same(read.map((one) => one.height), read.map((one) => (one.tool === "delete_page" || one.tool === "read_page_resource" ? 48 : 64)), `${at}: rows 64, 48 with no line`);
			const selects = read.filter((one) => one.selectKind.includes("connector-choice-btn"));
			same([...new Set(selects.map((one) => one.select!.width))], [148], `${at}: every select 148 wide`);
			same([...new Set(selects.map((one) => one.select!.height))], [28], `${at}: every select 28 tall`);
			same([...new Set(read.map((one) => Math.round(one.select!.left * 2) / 2))].length, 1, `${at}: every select and every choice's words at one x`);
			for (const one of selects) {
				near(one.face!.left, one.select!.left + 11, `${at}, ${one.tool}: the select's value on its left`, 1);
				same([Math.round(one.chevron!.width), Math.round(one.chevron!.height)], [12, 12], `${at}, ${one.tool}: a 12 px chevron`);
				near(one.chevron!.right, one.select!.right - 11, `${at}, ${one.tool}: the chevron on its right`, 1);
			}
			same(read.filter((one) => one.words).map((one) => [one.tool, one.words]), [["archive_page", WORDS.tools.choices.blocked]], `${at}: a tool excluded by hand, its words in the select's column`);
			// A long line cut with "…", whole in its tip.
			const long = read.find((one) => one.tool === "list_spaces")!;
			same([long.lineCut, long.line], [true, WIKI_TOOLS.descriptions.list_spaces], `${at}: a long line cut, whole in its tip`);
		} else {
			// At 390: the select under the tool's whole line, 44 tall, the line's whole width; the row grows with its line.
			for (const one of read.filter((each) => each.selectKind.includes("connector-choice-btn"))) {
				assert(one.select!.top >= one.top + 12 + 20, `${at}, ${one.tool}: the select under the tool's line`);
				same([Math.round(one.select!.height), Math.round(one.select!.left), Math.round(one.select!.right)], [44, Math.round(one.left), Math.round(one.right)], `${at}, ${one.tool}: the select the line's width and 44 tall`);
			}
			assert(!read.find((one) => one.tool === "list_spaces")!.lineCut, `${at}: a long line whole on a phone`);
			await nothingSideways(page, at);
		}
		same(read.slice(1).map((one, i) => Math.round(one.top - read[i].bottom)).filter((gap, i) => gap !== 0 && read[i].tool !== "read_page_resource"), [], `${at}: rows 0 px apart within a card`);
		// The menu: 6 under its select, right edges aligned; today's four items, the current one checked at the right; by keyboard as today.
		const select = selectOf(page, "create_page");
		same(await select.getAttribute("aria-label"), WORDS.tools.choiceLabel("Create page", WORDS.tools.choices.ask), `${at}: what a screen reader hears on a select`);
		// In the window's middle, so the menu has room to open under it.
		await select.evaluate((element) => element.scrollIntoView({ block: "center" }));
		await select.click();
		const menu = page.locator(".ai-profile-menu");
		await menu.waitFor();
		await still(page, `${at}, the menu`);
		const [menuBox, selectBox] = [await boxOf(menu), await boxOf(select)];
		if (width === 1440) {
			near(menuBox.top - selectBox.bottom, 6, `${at}: the menu 6 under its select`);
			near(menuBox.right, selectBox.right, `${at}: the menu's right edge on the select's`);
		}
		const items = menu.locator("[role=menuitemradio]");
		same(await items.allInnerTexts(), [WORDS.tools.choices.allow, WORDS.tools.choices.ask, WORDS.tools.choices.blocked, WORDS.tools.useDefault], `${at}: the menu's items`);
		same(await items.evaluateAll((all) => all.map((one) => one.getBoundingClientRect().height)), width === 390 ? [44, 44, 44, 44] : [32, 32, 32, 32], `${at}: the items' height`);
		const checked = menu.locator("[aria-checked=true]");
		same([await checked.innerText(), await textLook(checked)], [WORDS.tools.choices.ask, `13px/${width === 390 ? 44 : 32}px 500`], `${at}: the current choice at 500`);
		const mark = await checked.evaluate((element) => { const s = getComputedStyle(element, "::after"); const box = element.getBoundingClientRect(); return { width: s.width, height: s.height, right: box.right - parseFloat(s.right) }; });
		same([mark.width, mark.height], ["14px", "14px"], `${at}: a 14 px check`);
		assert(await checked.evaluate((element) => element === document.activeElement), `${at}: the focus on the current choice`);
		await page.keyboard.press("ArrowDown");
		same(await page.evaluate(() => document.activeElement?.textContent), WORDS.tools.choices.blocked, `${at}: ArrowDown moves`);
		await page.keyboard.press("Escape");
		await menu.waitFor({ state: "detached" });
		assert(await select.evaluate((element) => element === document.activeElement) && await connectorPage(page).isVisible(), `${at}: Escape closes only the menu, the focus back on the select`);
		// A choice saved by keyboard: the row keeps its height, the select its x.
		const before = (await rows()).find((one) => one.tool === "create_page")!;
		await select.press("Enter");
		await menu.waitFor();
		await waitUntil(() => menu.locator("[aria-checked=true]").evaluate((element) => element === document.activeElement), `${at}: the focus on the current choice again`);
		await page.keyboard.press("ArrowDown");
		await page.keyboard.press("Enter");
		await waitUntil(async () => (await select.getAttribute("data-choice")) === "blocked", `${at}: Blocked saved`);
		await answered(page, `${at}: Blocked saved`);
		const saved = (await rows()).find((one) => one.tool === "create_page")!;
		same([saved.height, saved.select!.left], [before.height, before.select!.left], `${at}: a saved choice moves nothing`);
		// While one saves, its select busy and every other waiting; a row keeps its height.
		const holdSave = (() => { let release = () => {}; const until = new Promise<void>((resolve) => { release = resolve; }); return { until, release: () => release() }; })();
		const hold = async (route: Route) => { await holdSave.until; await route.fallback(); };
		await page.route("**/api/mcp/servers/*/tools", hold);
		await selectOf(page, "move_page").click();
		await page.getByRole("menuitemradio", { name: WORDS.tools.choices.allow }).click();
		await waitUntil(async () => (await selectOf(page, "move_page").getAttribute("aria-busy")) === "true", `${at}: busy while saving`);
		const busy = await rows();
		same(busy.map((one) => one.height), read.map((one) => one.height), `${at}: no row changes height while one saves`);
		same(await opened.locator(".connector-choice-btn:not([aria-busy]):not(:disabled)").count(), 0, `${at}: every other select waits`);
		holdSave.release();
		await page.unroute("**/api/mcp/servers/*/tools", hold);
		await waitUntil(async () => (await selectOf(page, "move_page").getAttribute("aria-busy")) === null, `${at}: saved`);
		await answered(page, `${at}: saved`);
		// A failed save: its line in the tool line's place, a red dot, whole in its tip; then an unsure one: Try again in the select's column.
		saveGoes = "refused";
		await selectOf(page, "get_page").click();
		await page.getByRole("menuitemradio", { name: WORDS.tools.choices.blocked }).click();
		const failed = toolRow(page, "get_page").locator(".connector-row-error");
		await failed.waitFor();
		await answered(page, `${at}: a failed save`);
		same([await failed.getAttribute("title"), await toolRow(page, "get_page").locator(".settings-row-sub").isVisible(), await seen(failed, "background-color", "::before")], [CONNECTOR_REQUEST_LINES.saveFailed, false, colour.danger], `${at}: a failed save's line in the tool line's place, a red dot, whole in its tip`);
		saveGoes = "lost";
		await selectOf(page, "list_spaces").click();
		await page.getByRole("menuitemradio", { name: WORDS.tools.choices.ask }).click();
		const unsure = toolRow(page, "list_spaces");
		await unsure.getByText(WORDS.tools.unsure).waitFor();
		await answered(page, `${at}: an unsure save`);
		const tryAgain = unsure.locator(".connector-choice > .connector-slot-btn");
		same([await tryAgain.innerText(), (await tryAgain.getAttribute("class"))!.includes("rs-btn-sm")], [WORDS.button.tryAgain, true], `${at}: an unsure save's Try again, small`);
		read = await rows();
		if (width === 1440) {
			same(read.map((one) => one.height), read.map((one) => (one.tool === "delete_page" || one.tool === "read_page_resource" ? 48 : 64)), `${at}: rows keep their height with a failed and an unsure save`);
			same([...new Set(read.map((one) => Math.round(one.select!.left * 2) / 2))].length, 1, `${at}: Try again in the select's column`);
		}
		saveGoes = "kept";
		failNextStatus = false;
		await nothingSideways(page, `${at}, the tools`);
		await closeWindow(page);
		// Choices that can't be read: a strip with a red dot under Tools' title, Reset choices small, its question as today.
		choices.unreadable = "cannot-read";
		await openConnectors(page);
		await listSettled(page, EVERY, `${at}, unreadable`);
		await openConnector(page, "wiki");
		const strip = connectorPage(page).locator(".connector-tools-unreadable");
		const [title, stripBox] = [await boxOf(connectorPage(page).locator(".connector-tools-group > .group-head")), await boxOf(strip)];
		const reset = strip.getByRole("button", { name: WORDS.tools.reset });
		same([await seen(strip, "background-color", "::before"), await seen(strip.locator("p"), "color"), (await reset.getAttribute("class"))!.includes("rs-btn-sm"), stripBox.top > title.bottom], [colour.danger, colour.text, true, true], `${at}: choices that can't be read, a strip with a red dot under the title, its line in the text colour, Reset small`);
		await reset.click();
		const question = page.locator(".confirm-dialog-backdrop");
		await question.waitFor();
		same(await question.locator("button").allInnerTexts(), [WORDS.button.cancel, WORDS.tools.reset], `${at}: the Reset question as today`);
		await page.keyboard.press("Escape");
		await question.waitFor({ state: "detached" });
		await page.context().close();
	}
	console.log("  ok  the tools, 1440 both themes and 390: titles 13/20 at 600 8 above their cards, the help 13/18 muted to the box's edge, Check connection in the Status row and not on the heading; rows 64 (48 with no line), 0 apart, in every source and while one saves or is unsure; selects 148 by 28 at one x, value left and a 12 px chevron right, no row saying Default; an excluded tool's words in the select's column; the menu 6 under, right edges aligned, today's four items, the current at 500 with a 14 px check, by keyboard; a failed save's red-dot line whole in its tip, an unsure one's small Try again; choices that can't be read a red-dot strip with Reset small and its question; at 390 the select under the whole line, 44 tall, the line's whole width, nothing sideways");
}

async function checkRemove(browser: Browser): Promise<void> {
	for (const [width, theme] of [[1440, LIGHT], [1440, DARK], [390, LIGHT]] as const) {
		const at = `${width} ${theme}`;
		const page = await openPage(browser, width === 390 ? phone(theme) : desktop(1440, 900, theme), "on");
		resetWorld();
		await openConnectors(page);
		await listSettled(page, EVERY, at);
		const colour = await tokens(page);
		const opened = await openConnector(page, "wiki");
		const card = opened.locator(".connector-remove-group > .settings-rows");
		const remove = card.getByRole("button", { name: WORDS.button.remove });
		const groups = await opened.locator(":scope > .settings-group").evaluateAll((all) => all.map((one) => one.className));
		assert(groups.at(-1)!.includes("connector-remove-group"), `${at}: Remove's card is the last`);
		same([await remove.getAttribute("class"), (await boxOf(remove)).height, await seen(remove, "color")], ["rs-btn rs-btn-danger rs-btn-danger-soft", width === 390 ? 44 : 32, colour.danger], `${at}: Remove soft red, ${width === 390 ? 44 : 32} tall`);
		same([await textLook(card.locator(".settings-row-label")), await textLook(card.locator(".settings-row-sub")), await seen(card.locator(".settings-row-sub"), "color")], ["14px/20px 500", "13px/18px 400", colour.muted], `${at}: Remove's name and line`);
		await remove.click();
		const question = page.locator(".confirm-dialog-backdrop");
		await question.waitFor();
		same([await question.locator("h2, h3, .maintain-confirm-title, [id]").first().innerText().catch(() => ""), await question.locator("button").allInnerTexts()], [WORDS.removeQuestion(C.wiki.name), [WORDS.button.keep, WORDS.button.remove]], `${at}: the Remove question with today's words`);
		await waitUntil(() => question.getByRole("button", { name: WORDS.button.keep, exact: true }).evaluate((element) => element === document.activeElement), `${at}: Keep focused`);
		// Removing fails: a strip with a red dot 12 under the card, Try again small, the page's bottom padding under it.
		await question.getByRole("button", { name: WORDS.button.remove, exact: true }).click();
		const strip = opened.locator(":scope > .connector-page-error");
		await strip.waitFor({ timeout: 10000 });
		await answered(page, `${at}: a removal that failed`);
		const again = strip.getByRole("button", { name: WORDS.button.tryAgain });
		same([await strip.locator("span").first().innerText(), (await again.getAttribute("class"))!.includes("rs-btn-sm"), await seen(strip, "background-color", "::before")], [WORDS.remove.failed, true, colour.danger], `${at}: a removal's failure a red-dot strip with a small Try again`);
		const [cardBox, stripBox] = [await boxOf(card), await boxOf(strip)];
		near(stripBox.top - cardBox.bottom, 12, `${at}: the strip 12 under the card`);
		await scrollPane(page, 100000);
		await still(page, `${at}: the page's end`);
		const [end, paneBox] = [await boxOf(strip), await boxOf(pane(page))];
		near(paneBox.bottom - end.bottom, width === 390 ? 24 : 40, `${at}: the page's bottom padding under the strip`, 1);
		await backToList(page);
		// One brought in from another app: today's note, muted, and no card.
		const imported = await openConnector(page, "imported");
		same([await imported.locator(".connector-remove-group > .settings-rows").count(), await imported.locator(".connector-remove-group > .connector-note").first().innerText(), await seen(imported.locator(".connector-remove-group > .connector-note").first(), "color")], [0, WORDS.importedNote("Claude Desktop"), colour.muted], `${at}: an imported connector's note, muted, no card`);
		await page.context().close();
	}
	console.log("  ok  Remove, 1440 both themes and 390: its own card, last; soft red, 32 tall (44 at 390); its question with today's words, Keep focused; a removal's failure a red-dot strip 12 under the card with a small Try again and the page's bottom padding under it; an imported connector's note, muted, no card");
}

async function checkAddPages(browser: Browser): Promise<void> {
	for (const [width, theme] of [[1440, LIGHT], [1440, DARK], [390, LIGHT]] as const) {
		const at = `${width} ${theme}`;
		const page = await openPage(browser, width === 390 ? phone(theme) : desktop(1440, 900, theme), "on");
		resetWorld();
		await openConnectors(page, { list: ["wiki"] });
		await listSettled(page, ["wiki"], at);
		const colour = await tokens(page);
		for (const kind of ["web", "program"] as const) {
			const what = `${at}, ${kind === "web" ? "By web address" : "Program on this computer"}`;
			const form = await openAdd(page, kind);
			const col = await column(page);
			same(await pane(page).locator(".connector-list").count(), 0, `${what}: the page in the list's place`);
			const title = form.locator(".pane-head h2");
			same([await title.innerText(), await textLook(title)], [kind === "web" ? WORDS.form.webTitle : WORDS.form.programTitle, "18px/24px 700"], `${what}: the page's name`);
			same(await page.getByRole("heading", { level: 2, name: kind === "web" ? WORDS.form.webTitle : WORDS.form.programTitle }).filter({ visible: true }).count(), 1, `${what}: its name the page's heading`);
			if (kind === "web") {
				// The fold by pointer, then by keyboard.
				const toggle = form.locator(".connector-oauth-toggle");
				same(await toggle.getAttribute("aria-expanded"), "false", `${what}: the fold shut`);
				await toggle.click();
				same(await toggle.getAttribute("aria-expanded"), "true", `${what}: the fold opens by pointer`);
				await toggle.press("Enter");
				same(await toggle.getAttribute("aria-expanded"), "false", `${what}: and shuts by keyboard`);
				await toggle.press("Space");
				same(await toggle.getAttribute("aria-expanded"), "true", `${what}: and opens by keyboard`);
				same([await textLook(toggle), (await styleOf(toggle.locator(".disclosure-chevron"), ["width"])).width], ["13px/20px 500", "16px"], `${what}: the fold's line 13/20 at 500, its chevron 16`);
			}
			// Fields: label, field and help 6 apart, fields 20 apart, one-line fields the column's width, 44 tall with 16 px text on a phone.
			const fields = await form.locator(".connector-form > label.connector-form-field, .connector-oauth-fields > label.connector-form-field").evaluateAll((all) => all.map((field) => {
				const [label, input] = [field.querySelector(":scope > span")!, field.querySelector("input")!];
				const hint = field.querySelector(".connector-form-hint");
				const box = (one: Element) => one.getBoundingClientRect().toJSON() as DOMRect;
				return { label: box(label), input: box(input), hint: hint ? box(hint) : null, field: box(field), size: getComputedStyle(input).fontSize };
			}));
			// Read again: the fold open or the pairs added may have brought the pane its scrollbar.
			const fieldsCol = await column(page);
			for (const field of fields) {
				near(field.input.top - field.label.bottom, 6, `${what}: label to field 6`);
				if (field.hint) near(field.hint.top - field.input.bottom, 6, `${what}: field to help 6`);
				// A field fills the page's column (one form rule, 44).
				if (width === 1440) same([field.input.width, field.input.height], [718, 32], `${what}: a one-line field the column's 718 by 32`);
				else same([Math.round(field.input.width), field.input.height, field.size], [Math.round(fieldsCol.right - fieldsCol.left), 44, "16px"], `${what}: a field the column's width, 44 tall, 16 px text`);
			}
			if (kind === "web") {
				const [line, first] = [await boxOf(form.locator(".connector-oauth-toggle")), await boxOf(form.locator(".connector-oauth-fields > label.connector-form-field").first())];
				near(first.top - line.bottom, 20, `${what}: the fold's first field as far under its line as any field under another`);
			}
			const named = fields.slice(0, kind === "web" ? 2 : 2);
			near(named[1].field.top - named[0].field.bottom, 20, `${what}: fields 20 apart`);
			// Pairs share the form's column (44): name and value 2 to 3 (the value reaching 4 into the gap), 12 apart, the
			// remove button 8 after them ending on the column's edge; adding and removing a pair as today.
			const pairs = form.locator(".connector-header-row");
			const adder = form.getByRole("button", { name: kind === "web" ? WORDS.form.addHeader : WORDS.form.addSetting });
			await adder.click();
			same(await pairs.count(), 2, `${what}: a pair added`);
			const pair = await pairs.first().evaluate((element) => [...element.children].map((one) => one.getBoundingClientRect().toJSON() as DOMRect));
			if (width === 1440) {
				near(pair[0].width / (pair[1].width - 4), 2 / 3, `${what}: a pair's name and value 2 to 3`, 0.01);
				near(pair[1].left - pair[0].right, 12, `${what}: a pair's fields 12 apart`);
				near(pair[2].left - pair[1].right, 8, `${what}: the remove button 8 after them`);
				near(pair[2].right - pair[0].left, 718, `${what}: a pair and its remove button the column's 718`);
			} else {
				assert(pair[2].left > pair[0].right && pair[0].left === pair[1].left, `${what}: on a phone a pair's two fields stacked beside its remove button`);
			}
			if (width === 390) {
				// The fold's line and Add another: a press 11 above or under their words still reaches them.
				for (const control of kind === "web" ? [form.locator(".connector-oauth-toggle"), adder] : [adder]) {
					await control.evaluate((element) => element.scrollIntoView({ block: "center" }));
					const box = await boxOf(control);
					const hits = await page.evaluate(([x, ys]) => ys.map((y) => document.elementFromPoint(x, y)?.closest("button")?.textContent ?? null), [box.left + box.width / 2, [box.top - 11, box.bottom + 11]] as const);
					same(hits, [await control.innerText(), await control.innerText()], `${what}: "${await control.innerText()}" a 44 px target`);
					// and it takes nothing from the field over it: 12 px or more between them, as far as the target reaches.
					const gap = await control.evaluate((element) => { let one = element.previousElementSibling; while (one && !one.querySelector("input")) one = one.previousElementSibling; const inputs = one ? [...one.querySelectorAll("input")] : []; const field = inputs[inputs.length - 1]; return field ? element.getBoundingClientRect().top - field.getBoundingClientRect().bottom : 99; });
					assert(gap >= 11.5, `${what}: "${await control.innerText()}"'s target leaves the field over it whole (${gap} px between them)`);
				}
			}
			const [one, two] = [await boxOf(pairs.nth(0)), await boxOf(pairs.nth(1))];
			near(two.top - one.bottom, width === 1440 ? 8 : 16, `${what}: pairs ${width === 1440 ? 8 : 16} apart`);
			await pairs.nth(1).locator(".connector-header-remove").click();
			same(await pairs.count(), 1, `${what}: a pair removed`);
			// The trust sentence in soft text, 24 above the buttons; Add ink then Cancel quiet, 8 apart, on the content's left edge, in that Tab order; Add disabled until filled.
			const trust = form.locator(".connector-form-warning");
			// Running text at 13/18, in the page's column (one scale, 44).
			same([await textLook(trust), await seen(trust, "color")], ["13px/18px 400", colour.soft], `${what}: the trust sentence 13/18 soft`);
			near((await boxOf(trust)).width, fieldsCol.right - fieldsCol.left, `${what}: the trust sentence the column's width`);
			const foot = form.locator(".connector-form > .settings-form-foot > button");
			same(await foot.allInnerTexts(), [WORDS.form.add, WORDS.form.cancel], `${what}: Add, then Cancel`);
			same(await inkedOn(page, theme), [WORDS.form.add], `${what}: Add the one ink button`);
			same(await foot.nth(1).getAttribute("class"), "rs-btn rs-btn-quiet", `${what}: Cancel quiet`);
			const [add, cancel, lastLine] = [await boxOf(foot.nth(0)), await boxOf(foot.nth(1)), await boxOf(form.locator(".connector-form > .cli-note, .connector-form > .connector-form-warning").last())];
			near(add.left, col.left, `${what}: Add on the content's left edge`);
			near(cancel.left - add.right, 8, `${what}: Cancel 8 after Add`);
			near(add.top - lastLine.bottom, 24, `${what}: the sentences 24 above the buttons`);
			// Add is never greyed for an empty field (44's form rule); it stays in the Tab order before Cancel.
			assert(!(await foot.nth(0).isDisabled()), `${what}: Add not greyed before it is filled`);
			await foot.nth(1).focus();
			await page.keyboard.press("Shift+Tab");
			same(await page.evaluate(() => document.activeElement?.textContent), WORDS.form.add, `${what}: Shift+Tab from Cancel reaches Add`);
			await nothingSideways(page, what);
			await form.getByRole("button", { name: WORDS.form.cancel, exact: true }).click();
			await pane(page).locator(".connector-list").waitFor();
		}
		if (width === 1440) {
			// A refusal: a strip with a red dot above the buttons. Then added: the list with today's notice.
			let form = await openAdd(page, "web");
			const inputs = form.locator(".connector-form > label input");
			await inputs.nth(0).fill("Look tracker");
			await inputs.nth(1).fill(standInAt("/wiki/mcp"));
			const add = form.getByRole("button", { name: WORDS.form.add, exact: true });
			assert(await add.isEnabled(), `${at}: Add once filled`);
			// By keyboard: from the fold's line, Tab reaches Add, then Cancel.
			await form.locator(".connector-oauth-toggle").focus();
			await page.keyboard.press("Tab");
			same(await page.evaluate(() => document.activeElement?.textContent), WORDS.form.add, `${at}: Tab reaches Add after the fold`);
			await page.keyboard.press("Tab");
			same(await page.evaluate(() => document.activeElement?.textContent), WORDS.form.cancel, `${at}: Tab reaches Cancel after Add`);
			addRefused = true;
			await add.click();
			const refusal = form.locator(".checkpoint-proposal-error");
			await refusal.waitFor();
			addRefused = false;
			same([await refusal.getAttribute("role"), await refusal.innerText(), await seen(refusal, "background-color", "::before")], ["alert", CONNECTOR_REFUSAL, colour.danger], `${at}: a refusal a red-dot strip, its alert`);
			const [strip, buttons] = [await boxOf(refusal), await boxOf(form.locator(".connector-form > .settings-form-foot"))];
			near(buttons.top - strip.bottom, 12, `${at}: the refusal above the buttons`);
			// The list shows what is added here too, the program as one that downloads at its first start (as uvx does).
			await page.route("**/api/mcp/status", async (route) => { const response = await route.fetch().catch(() => null); if (!response) return; const status = await response.json(); return route.fulfill({ response, json: { ...status, servers: status.servers.filter((one: { name: string }) => [C.wiki.id, "look-tracker", "look-program"].includes(one.name)).map((one: { name: string }) => (one.name === "look-program" ? { ...one, downloadsAtFirstStart: true } : one)) } }); });
			// While Add saves, neither way out leaves: its answer would close a page opened since.
			const addHeld = (() => { let release = () => {}; const until = new Promise<void>((resolve) => { release = resolve; }); return { until, release: () => release() }; })();
			const holdAdd = async (route: Route) => { if (route.request().method() === "POST") await addHeld.until; await route.fallback(); };
			await page.route("**/api/mcp/servers", holdAdd);
			await add.click();
			await form.getByRole("button", { name: WORDS.form.adding, exact: true }).waitFor();
			same([await form.locator(".connector-page-back").isDisabled(), await form.getByRole("button", { name: WORDS.form.cancel, exact: true }).isDisabled()], [true, true], `${at}: the way back and Cancel wait while Add saves`);
			addHeld.release();
			await pane(page).locator(".connector-list").waitFor();
			await page.unroute("**/api/mcp/servers", holdAdd);
			await pane(page).locator(".connector-notice").filter({ hasText: WORDS.addedCustom("Look tracker") }).waitFor({ timeout: 15000 });
			assert((await authedFetch(`${baseUrl}/api/mcp/servers/look-tracker`, { method: "DELETE" })).ok, "removing look-tracker after the add");
			// A program: the list, its row checking and the foot holding it.
			const release = holdCheck("look-program", { ok: true, toolCount: 0, toolNames: [] });
			form = await openAdd(page, "program");
			const fields = form.locator(".connector-form > label input");
			await fields.nth(0).fill("Look program");
			await fields.nth(1).fill("never-started-connector --look");
			await form.getByRole("button", { name: WORDS.form.add, exact: true }).click();
			await pane(page).locator(".connector-list").waitFor();
			await row(page, "wiki").waitFor();
			await page.locator(".connector-waiting-foot").filter({ hasText: "Look program" }).waitFor({ timeout: 15000 });
			release();
			assert((await authedFetch(`${baseUrl}/api/mcp/servers/look-program`, { method: "DELETE" })).ok, "removing look-program after the add");
		}
		await page.context().close();
	}
	console.log("  ok  both add pages, 1440 both themes and 390: in the list's place, the title the identity's name; label, field and help 6 apart, fields 20 apart and 718 wide (the column's width, 44 tall and 16 px at 390); the fold by pointer and keyboard; pairs 2 to 3, 12 apart, remove 8 after, 8 between (16 at 390), added and removed; at 390 the fold and Add another 44 px targets; the trust sentence soft, 24 above Add (ink) then Cancel (quiet) 8 apart on the content's left edge; Add disabled until filled; a refusal a red-dot strip above the buttons; the way back and Cancel waiting while Add saves; after Add the list with the notice (web) or the row and the foot (program)");
}

/** Both add pages in the narrowest desktop window: the pairs fit the column, nothing sideways. */
async function checkAddPagesAt761(browser: Browser): Promise<void> {
	const page = await openPage(browser, desktop(761, 900, LIGHT), "on");
	resetWorld();
	await openConnectors(page);
	await listSettled(page, EVERY, "761");
	for (const kind of ["web", "program"] as const) {
		const what = `761, ${kind === "web" ? "By web address" : "Program on this computer"}`;
		const form = await openAdd(page, kind);
		if (kind === "web") await form.locator(".connector-oauth-toggle").click();
		await form.getByRole("button", { name: kind === "web" ? WORDS.form.addHeader : WORDS.form.addSetting }).click();
		const col = await column(page);
		const rights = await form.locator(".connector-header-row").evaluateAll((all) => all.map((one) => Math.max(...[...one.children].map((child) => child.getBoundingClientRect().right))));
		same(rights.filter((right) => right > col.right + 0.5), [], `${what}: every pair inside the column (${col.right})`);
		await nothingSideways(page, what);
		await form.getByRole("button", { name: WORDS.form.cancel, exact: true }).click();
		await pane(page).locator(".connector-list").waitFor();
	}
	await page.context().close();
	console.log("  ok  both add pages at 761: the fold open and a pair added, every pair inside the column, nothing sideways");
}

async function checkReadOnly(browser: Browser): Promise<void> {
	const page = await openPage(browser, phone(LIGHT), "on");
	resetWorld();
	await openConnectors(page, { remote: true });
	await answered(page, "remote access");
	const opened = await openConnector(page, "wiki");
	same(await opened.locator("button, a.rs-btn").evaluateAll((all) => all.filter((one) => one.getClientRects().length).map((one) => one.getAttribute("aria-label") ?? one.textContent)), [WORDS.details.backName], "remote access at 390: no button but the way back");
	const words = await opened.locator(".connector-choice-words").allInnerTexts();
	same(words.length, 8, "remote access at 390: every tool's choice as words");
	same(await opened.locator(".connector-choice-btn").count(), 0, "remote access at 390: no select");
	same(await opened.locator(".connector-fact").filter({ hasText: WORDS.details.runsHereRemote }).count() + await opened.locator(".connector-fact").filter({ hasText: WORDS.details.address }).count(), 1, "remote access at 390: the facts");
	await nothingSideways(page, "remote access at 390");
	await page.context().close();
	console.log("  ok  remote access at 390: no button but the way back, every tool's choice as words, nothing sideways (a shared server's Connectors reads as on the base: checkOff)");
}

async function checkShared(browser: Browser): Promise<void> {
	const off: string[] = [];
	for (const theme of [LIGHT, DARK] as const) {
		const page = await openPage(browser, desktop(1440, 900, theme), "on");
		resetWorld();
		await openConnectors(page);
		await listSettled(page, EVERY, theme);
		for (const key of ["wiki", "slow", "tracker"] as const) {
			await openConnector(page, key);
			if (key === "slow") await connectorPage(page).locator(".connector-tech > summary").click();
			same((await inkedOn(page, theme)).length, 0, `1440 ${theme}, ${C[key].name}: no ink button`);
			off.push(...await offScale(page, theme));
			if (key === "wiki") {
				await selectOf(page, "create_page").click();
				await page.locator(".ai-profile-menu").waitFor();
				off.push(...await offScale(page, theme));
				await page.keyboard.press("Escape");
			}
			await backToList(page);
		}
		for (const kind of ["web", "program"] as const) {
			const form = await openAdd(page, kind);
			if (kind === "web") await form.locator(".connector-oauth-toggle").click();
			same((await inkedOn(page, theme)).length <= 1, true, `1440 ${theme}, ${kind}: at most one ink button`);
			off.push(...await offScale(page, theme));
			await form.getByRole("button", { name: WORDS.form.cancel, exact: true }).click();
		}
		await page.context().close();
	}
	for (const one of new Set(off)) console.log(`  ..  ${one}`);
	same([...new Set(off)].length, 0, "words off the scale, coloured or under 4.5:1 (listed above)");
	for (const [width, height] of [[390, 844], [800, 700], [1024, 768], [1440, 900]] as const) {
		const page = await openPage(browser, width === 390 ? phone(LIGHT) : desktop(width, height, LIGHT), "on");
		resetWorld();
		await openConnectors(page);
		await listSettled(page, EVERY, `${width}`);
		for (const key of ["wiki", "long", "ticket"] as const) {
			await openConnector(page, key);
			await nothingSideways(page, `${width}, ${C[key].name}`);
			await backToList(page);
		}
		for (const kind of ["web", "program"] as const) {
			const form = await openAdd(page, kind);
			if (kind === "web") await form.locator(".connector-oauth-toggle").click();
			await nothingSideways(page, `${width}, ${kind}`);
			await form.getByRole("button", { name: WORDS.form.cancel, exact: true }).click();
		}
		await page.context().close();
	}
	console.log("  ok  a connector's page (with its menu) and both add pages, both themes: words on the scale, none coloured, each at 4.5:1 or more, at most one ink button; nothing sideways at 390, 800, 1024 and 1440");
}

/**
 * The colour a control takes while pressed: held down, then the pointer moved off it to the title line's empty
 * middle, so no hover adds to it; let go there, the press does nothing.
 */
async function pressedColour(page: Page, target: Locator, rest: string): Promise<string> {
	const [box, back, col] = [await boxOf(target), await boxOf(visible(page, ".connector-page-back")), await column(page)];
	await page.mouse.move(box.left + box.width / 2, box.top + box.height / 2);
	await page.mouse.down();
	await page.mouse.move((col.left + col.right) / 2, (back.top + back.bottom) / 2);
	await waitUntil(async () => (await seen(target, "color")) !== rest, "the press colours it", 2000).catch(() => {});
	await still(page, "the press");
	const pressed = await seen(target, "color");
	await page.mouse.up();
	await page.mouse.move(5, 5);
	await waitUntil(async () => (await seen(target, "color")) === rest, "at rest again after the press");
	return pressed;
}

/** Hover, pressed, focus and disabled of each control this page adds, read in both themes: a select, the way back, Technical details, the fold, and Add, Cancel and the way back while Add waits or saves. */
async function checkStates(browser: Browser): Promise<void> {
	for (const theme of [LIGHT, DARK] as const) {
		const page = await openPage(browser, desktop(1440, 900, theme), "on");
		resetWorld();
		await openConnectors(page);
		await listSettled(page, EVERY, theme);
		await openConnector(page, "ticket");
		const colour = await tokens(page);
		// The pointer, the press and the keyboard on a disclosure line or the way back.
		const lineStates = async (name: string, target: Locator, rest: string) => {
			same(await seen(target, "color"), rest, `${theme}, ${name} at rest`);
			await target.hover();
			await waitUntil(async () => (await seen(target, "color")) === colour.text, `${theme}, ${name}: the text colour under the pointer`);
			await page.mouse.move(5, 5);
			await waitUntil(async () => (await seen(target, "color")) === rest, `${theme}, ${name}: at rest again`);
			same(await pressedColour(page, target, rest), colour.text, `${theme}, ${name}: the text colour while pressed`);
			await target.focus();
			await page.keyboard.press("Shift+Tab");
			await page.keyboard.press("Tab");
			same((await styleOf(target, ["outline-style", "outline-width"]))["outline-width"], "2px", `${theme}, ${name}: a 2 px ring for the keyboard`);
			await target.blur();
		};
		await lineStates("the way back", visible(page, ".connector-page-back"), colour.muted);
		await lineStates("Technical details", connectorPage(page).locator(".connector-tech > summary"), colour.soft);
		same(await connectorPage(page).locator(".connector-tech").evaluate((element) => (element as HTMLDetailsElement).open), false, `${theme}: a press let go off Technical details leaves it shut`);
		await backToList(page);
		await openConnector(page, "wiki");
		const select = selectOf(page, "create_page");
		const rest = await seen(select, "background-color");
		await select.hover();
		await waitUntil(async () => (await seen(select, "background-color")) !== rest, `${theme}, a select under the pointer`);
		await page.mouse.move(5, 5);
		await waitUntil(async () => (await seen(select, "background-color")) === rest, `${theme}, a select at rest again`);
		await backToList(page);
		// The fold on an add page.
		const form = await openAdd(page, "web");
		const fold = form.locator(".connector-oauth-toggle");
		await lineStates("the fold", fold, colour.soft);
		same(await fold.getAttribute("aria-expanded"), "false", `${theme}: a press let go off the fold leaves it shut`);
		// Disabled: while it saves Add, Cancel and the way back; each faded, its pointer the plain one, a pointer over it changing nothing.
		const foot = form.locator(".connector-form > .settings-form-foot > button");
		const [add, cancel, back] = [foot.nth(0), foot.nth(1), form.locator(".connector-page-back")];
		const disabledLook = async (name: string, target: Locator) => {
			assert(await target.isDisabled(), `${theme}, ${name}: disabled`);
			// A button pressed with the pointer on it fades out of its hover fill as it turns disabled: read it once that has ended.
			await still(page, `${theme}, ${name} at rest`);
			const atRest = [await seen(target, "color"), await seen(target, "background-color")];
			same(Object.values(await styleOf(target, ["opacity", "cursor"])), ["0.45", "default"], `${theme}, ${name} disabled: faded, the plain pointer`);
			await target.hover({ force: true });
			await still(page, `${theme}, ${name} under the pointer`);
			same([await seen(target, "color"), await seen(target, "background-color")], atRest, `${theme}, ${name} disabled: a pointer over it changes nothing`);
			await page.mouse.move(5, 5);
		};
		// Add before it is filled is never greyed (one form rule, 44): a press marks both empty fields and puts the caret in the first;
		// filled, the marks go.
		assert(!(await add.isDisabled()), `${theme}, Add before it is filled: not greyed`);
		await add.click();
		const marks = () => form.locator("input").evaluateAll((inputs) => [inputs[0].getAttribute("aria-invalid"), inputs[1].getAttribute("aria-invalid"), inputs[0] === document.activeElement]);
		same(await marks(), ["true", "true", true], `${theme}, Add pressed empty: both fields marked, the caret in the first`);
		await form.locator("input").nth(0).fill("Project tracker");
		await form.locator("input").nth(1).fill("https://projects.example.com/mcp");
		same((await marks()).slice(0, 2), [null, null], `${theme}, both fields filled: the marks gone`);
		addRefused = true;
		const addHeld = (() => { let release = () => {}; const until = new Promise<void>((resolve) => { release = resolve; }); return { until, release: () => release() }; })();
		const holdAdd = async (route: Route) => { if (route.request().method() === "POST") await addHeld.until; await route.fallback(); };
		await page.route("**/api/mcp/servers", holdAdd);
		await add.click();
		await form.getByRole("button", { name: WORDS.form.adding, exact: true }).waitFor();
		await disabledLook("Add while it saves", add);
		await disabledLook("Cancel while Add saves", cancel);
		await disabledLook("the way back while Add saves", back);
		addHeld.release();
		await form.locator(".checkpoint-proposal-error").waitFor();
		addRefused = false;
		await page.unroute("**/api/mcp/servers", holdAdd);
		await page.context().close();
	}
	console.log("  ok  both themes: the way back, Technical details and the fold turn the text colour under the pointer and while pressed, and take a 2 px ring for the keyboard; a select takes its hover fill; Add until filled, and Add, Cancel and the way back while Add saves, faded with the plain pointer, a pointer over them changing nothing");
}

// --- Pictures of each scene, for the eye --------------------------------------------------

async function shoot(page: Page, name: string): Promise<void> {
	// LOOK_SHOTS_ONLY: a pattern the shots' names must match, for a run that retakes a few.
	if (!process.env.LOOK_SHOTS || (process.env.LOOK_SHOTS_ONLY && !new RegExp(process.env.LOOK_SHOTS_ONLY).test(name))) return;
	fs.mkdirSync(process.env.LOOK_SHOTS, { recursive: true });
	await page.screenshot({ path: path.join(process.env.LOOK_SHOTS, `${name}.png`) });
}

/** A control held down under the pointer; then let go off it, on the title line's empty middle, so the press does nothing. */
async function shootPressed(page: Page, target: Locator, name: string): Promise<void> {
	const [box, back, col] = [await boxOf(target), await boxOf(visible(page, ".connector-page-back")), await column(page)];
	await page.mouse.move(box.left + box.width / 2, box.top + box.height / 2);
	await page.mouse.down();
	await still(page, name);
	await shoot(page, name);
	await page.mouse.move((col.left + col.right) / 2, (back.top + back.bottom) / 2);
	await page.mouse.up();
}

/** The facts whose label stands off its value's first line of words: label and the two tops. */
const factLabelsOffLine = (opened: Locator) => opened.locator(".connector-facts > .connector-fact").evaluateAll((all) => all.flatMap((fact) => {
	const label = fact.querySelector(".settings-row-label")!;
	const value = fact.querySelector(".connector-fact-value");
	const words = value && document.createTreeWalker(value, NodeFilter.SHOW_TEXT, { acceptNode: (node) => (node.textContent!.trim() && !node.parentElement!.closest("button") ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_SKIP) }).nextNode();
	if (!words) return [];
	const range = document.createRange();
	range.selectNodeContents(words);
	const [labelTop, valueTop] = [label.getClientRects()[0].top, range.getClientRects()[0].top];
	return Math.abs(labelTop - valueTop) > 1 ? [[label.textContent, labelTop, valueTop]] : [];
}));

/** The last character on each line but the last of an element's words. */
const lineBreaks = (where: Locator) => where.evaluate((element) => {
	const marks: { char: string; top: number }[] = [];
	const walk = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
	for (let node = walk.nextNode(); node; node = walk.nextNode()) {
		for (let i = 0; i < node.textContent!.length; i++) {
			const range = document.createRange();
			range.setStart(node, i);
			range.setEnd(node, i + 1);
			marks.push({ char: node.textContent![i], top: range.getBoundingClientRect().top });
		}
	}
	return marks.flatMap((mark, i) => (i + 1 < marks.length && marks[i + 1].top > mark.top + 4 ? [mark.char] : []));
});

/** The box of an element's first line of words. */
const firstLine = (where: Locator) => where.evaluate((element) => {
	const range = document.createRange();
	range.selectNodeContents(element);
	return range.getClientRects()[0].toJSON() as DOMRect;
});

/** Scrolls the pane until this element's top stands under the title line. */
const scrollTo = (page: Page, selector: string) => page.evaluate((wanted) => { const scroller = [...document.querySelectorAll(".settings-dialog-pane")].find((one) => one.getClientRects().length)!; const target = scroller.querySelector(wanted)!; scroller.scrollTop += target.getBoundingClientRect().top - scroller.getBoundingClientRect().top - 72; }, selector);

/** As scrollTo, and waits for the hairline the scroll brings, which lands a frame after it. */
const scrolledTo = async (page: Page, selector: string) => {
	await scrollTo(page, selector);
	await page.locator(".settings-dialog.is-scrolled").waitFor();
};

/**
 * A picture of each scene the look is judged on, taken the same way from a page built from the base and from
 * the head, so they can sit side by side; every wait reads words both builds share. LOOK_INIT_SCRIPT names a
 * script file the page runs before its own, such as one that gives it the Mac app's look.
 */
async function checkPictures(browser: Browser): Promise<void> {
	if (!process.env.LOOK_SHOTS) return;
	const open = async (options: ReturnType<typeof desktop>) => {
		const page = await openPage(browser, options, "on");
		if (process.env.LOOK_INIT_SCRIPT) await page.context().addInitScript({ path: process.env.LOOK_INIT_SCRIPT });
		return page;
	};
	for (const [width, theme] of [[1440, LIGHT], [1440, DARK], [390, LIGHT], [390, DARK]] as const) {
		const at = `${width}-${theme}`;
		const page = await open(width === 390 ? phone(theme) : desktop(1440, 900, theme));
		resetWorld();
		await openConnectors(page);
		await listSettled(page, EVERY, at);
		await openConnector(page, "wiki");
		await shoot(page, `${at}-01-web-connector-top`);
		await scrolledTo(page, ".connector-tools-group");
		await still(page, at);
		await shoot(page, `${at}-02-web-connector-tools`);
		await selectOf(page, "create_page").click();
		await page.locator(".ai-profile-menu").waitFor();
		await still(page, at);
		await shoot(page, `${at}-03-tools-menu`);
		await page.keyboard.press("Escape");
		await backToList(page);
		await openConnector(page, "office");
		await shoot(page, `${at}-04-program`);
		await backToList(page);
		await openConnector(page, "ticket");
		await connectorPage(page).locator(".connector-tech > summary").click();
		await page.mouse.move(5, 5);
		await still(page, at);
		await shoot(page, `${at}-05-broken-connector`);
		await backToList(page);
		let form = await openAdd(page, "web");
		if (theme === LIGHT) await shoot(page, `${at}-06a-by-web-address-opened`);
		await form.locator(".connector-oauth-toggle").click();
		await page.mouse.move(5, 5);
		await still(page, at);
		await shoot(page, `${at}-06-by-web-address-fold-open`);
		await scrollPane(page, 10_000);
		await page.locator(".settings-dialog.is-scrolled").waitFor();
		await still(page, at);
		await shoot(page, `${at}-06b-by-web-address-fold-open-end`);
		await form.getByRole("button", { name: WORDS.form.cancel, exact: true }).click();
		form = await openAdd(page, "program");
		if (theme === LIGHT) await shoot(page, `${at}-07a-program-opened`);
		await form.getByRole("button", { name: WORDS.form.addSetting }).click();
		const inputs = form.locator("input");
		await inputs.nth(0).fill("Office files");
		await inputs.nth(1).fill("npx -y office-files-mcp");
		await inputs.nth(2).fill("OFFICE_FOLDER");
		await inputs.nth(3).fill("~/Documents");
		await inputs.nth(4).fill("LOG_LEVEL");
		await inputs.nth(5).fill("warn");
		await page.mouse.move(5, 5);
		await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
		await still(page, at);
		await shoot(page, `${at}-07-program-two-settings`);
		await form.getByRole("button", { name: WORDS.form.cancel, exact: true }).click();
		if (width === 1440) {
			await openConnector(page, "tracker");
			await shoot(page, `${at}-08-signing-in`);
			await backToList(page);
			await openConnector(page, "wiki");
			saveGoes = "refused";
			await selectOf(page, "get_page").click();
			await page.getByRole("menuitemradio", { name: WORDS.tools.choices.blocked }).click();
			await toolRow(page, "get_page").locator(".connector-row-error").waitFor();
			saveGoes = "kept";
			await scrolledTo(page, ".connector-tools-group");
			await page.mouse.move(5, 5);
			await answered(page, at);
			await still(page, at);
			await shoot(page, `${at}-09-failed-save`);
			await connectorPage(page).locator(".connector-remove-group .rs-btn-danger").click();
			await page.locator(".confirm-dialog-backdrop").waitFor();
			await still(page, at);
			await shoot(page, `${at}-10-remove-question`);
			await page.locator(".confirm-dialog-backdrop").getByRole("button", { name: WORDS.button.remove, exact: true }).click();
			await connectorPage(page).locator(".connector-page-error").waitFor();
			await scrollPane(page, 100000);
			await page.locator(".settings-dialog.is-scrolled").waitFor();
			await page.mouse.move(5, 5);
			await answered(page, at);
			await still(page, at);
			await shoot(page, `${at}-11-removal-failed`);
			await backToList(page);
			form = await openAdd(page, "web");
			const fields = form.locator("input");
			await fields.nth(0).fill("Project tracker");
			await fields.nth(1).fill("https://projects.example.com/mcp");
			addRefused = true;
			await form.getByRole("button", { name: WORDS.form.add, exact: true }).click();
			await form.locator(".checkpoint-proposal-error").waitFor();
			addRefused = false;
			await page.mouse.move(5, 5);
			await still(page, at);
			await shoot(page, `${at}-12-refused-add`);
			await form.getByRole("button", { name: WORDS.form.cancel, exact: true }).click();
			// Hover, pressed and focus of a select, the way back and the fold.
			await openConnector(page, "wiki");
			await scrolledTo(page, ".connector-tools-group");
			await selectOf(page, "create_page").hover();
			await still(page, at);
			await shoot(page, `${at}-13-select-hover`);
			await page.mouse.down();
			await shoot(page, `${at}-14-select-pressed`);
			// Let go on the select (outside the window a release closes it), then shut the menu that opened.
			await page.mouse.up();
			await page.locator(".ai-profile-menu").waitFor();
			await page.keyboard.press("Escape");
			await page.locator(".ai-profile-menu").waitFor({ state: "detached" });
			await page.mouse.move(5, 5);
			await selectOf(page, "get_page").focus();
			await page.keyboard.press("Shift+Tab");
			await page.keyboard.press("Tab");
			await still(page, at);
			await shoot(page, `${at}-15-select-focus`);
			await scrollPane(page, 0);
			await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
			const back = visible(page, ".connector-page-back");
			await back.hover();
			await still(page, at);
			await shoot(page, `${at}-16-back-hover`);
			if (theme === LIGHT) await shootPressed(page, back, `${at}-16b-back-pressed`);
			await page.mouse.move(5, 5);
			await back.focus();
			await page.keyboard.press("Tab");
			await page.keyboard.press("Shift+Tab");
			await still(page, at);
			await shoot(page, `${at}-17-back-focus`);
			await backToList(page);
			form = await openAdd(page, "web");
			const toggle = form.locator(".connector-oauth-toggle");
			await toggle.hover();
			await still(page, at);
			await shoot(page, `${at}-18-fold-hover`);
			if (theme === LIGHT) await shootPressed(page, toggle, `${at}-18b-fold-pressed`);
			await page.mouse.move(5, 5);
			await toggle.focus();
			await page.keyboard.press("Shift+Tab");
			await page.keyboard.press("Tab");
			await still(page, at);
			await shoot(page, `${at}-19-fold-focus`);
			await form.getByRole("button", { name: WORDS.form.cancel, exact: true }).click();
			await closeWindow(page);
			choices.unreadable = "cannot-read";
			await openConnectors(page);
			await listSettled(page, EVERY, at);
			await openConnector(page, "wiki");
			await scrolledTo(page, ".connector-tools-group");
			await still(page, at);
			await shoot(page, `${at}-20-choices-unreadable`);
			choices.unreadable = null;
		}
		await page.context().close();
	}
	const page = await open(phone(LIGHT));
	resetWorld();
	await openConnectors(page, { remote: true });
	await answered(page, "remote access");
	await openConnector(page, "wiki");
	await shoot(page, "390-light-21-remote-access");
	await scrolledTo(page, ".connector-tools-group");
	await still(page, "remote access");
	await shoot(page, "390-light-22-remote-access-tools");
	await page.context().close();
}

let model: http.Server | undefined;
let server: ChildProcessWithoutNullStreams | null = null;
try {
	const agents = await import("../src/persistent-agents.js");
	const lookRoom = agents.createPersistentAgentFromScaffoldInput({ displayName: ROOM, userName: "Synthetic User", preferredUserAddress: "Synthetic User" }).agent.agentId;
	const otherRoom = agents.createPersistentAgentFromScaffoldInput({ displayName: OTHER_ROOM, userName: "Synthetic User", preferredUserAddress: "Synthetic User" }).agent.agentId;
	fs.writeFileSync(path.join(agentDir, "mcp.json"), JSON.stringify({ mcpServers: {
		[C.wiki.id]: { displayName: C.wiki.name, url: standInAt("/wiki/mcp") },
		[C.office.id]: { displayName: C.office.name, command: "never-started-connector", args: ["--stdio"] },
		[C.fresh.id]: { displayName: C.fresh.name, command: "never-started-connector", args: ["--fresh"] },
		[C.ticket.id]: { displayName: C.ticket.name, url: NOWHERE },
		[C.slow.id]: { displayName: C.slow.name, url: NOWHERE },
		[C.keyed.id]: { displayName: C.keyed.name, url: NOWHERE, bearerToken: "synthetic-key" },
		[C.tracker.id]: { displayName: C.tracker.name, url: standInAt("/tracker/mcp") },
		[C.long.id]: { displayName: C.long.name, url: LONG_ADDRESS },
		[C.imported.id]: { displayName: C.imported.name, command: "never-started-connector", args: ["--files"] },
	} }));
	const now = Date.now();
	fs.writeFileSync(path.join(agentDir, "mcp-connector-checks.json"), JSON.stringify({ schemaVersion: 1, checks: {
		[C.ticket.id]: { at: now, ok: false, httpStatus: 404, error: "HTTP 404" },
		[C.slow.id]: { at: now, ok: false, error: "fetch failed" },
		[C.keyed.id]: { at: now, ok: false, httpStatus: 401, error: "HTTP 401" },
		[C.tracker.id]: { at: now, ok: false, needsAuth: true, httpStatus: 401 },
		[C.long.id]: { at: now, ok: false, needsAuth: true, httpStatus: 401 },
	} }));
	// Team wiki signed in, its sign-in good for a day.
	authStore.updateTokens(C.wiki.id, { accessToken: "synthetic-token", refreshToken: "synthetic-refresh", expiresAt: Math.floor(now / 1000) + 86400 }, standInAt("/wiki/mcp"));

	// A model server is never asked here; the app wants one set up to show its rooms.
	const modelPort = await freePort();
	model = http.createServer((_req, res) => { res.writeHead(500); res.end(); }).listen(modelPort, "127.0.0.1");
	fs.writeFileSync(path.join(agentDir, "models.json"), JSON.stringify({ providers: { synthetic: { name: "Synthetic", baseUrl: `http://127.0.0.1:${modelPort}/v1`, api: "openai-completions", models: [{ id: "room-model", name: "Room Model", input: ["text"], contextWindow: 128000, maxTokens: 16384 }] } } }));
	server = spawn("npx", ["tsx", "src/index.ts"], {
		shell: process.platform === "win32",
		...SMOKE_SERVER_SPAWN_TREE_OPTIONS,
		cwd: webServerDir,
		env: smokeHomeEnv(tempHome, { PORT: String(port), ...SMOKE_SERVER_AUTH_ENV, EXXETA_HOME: repoRoot, EXXPERTS_CODING_AGENT_DIR: agentDir, PI_CODING_AGENT_DIR: agentDir, EXXETA_PERSISTENT_AGENTS_ROOT: agentsRoot }) as NodeJS.ProcessEnv,
		stdio: ["ignore", "pipe", "pipe"],
	}) as unknown as ChildProcessWithoutNullStreams;
	await waitForServer(server, baseUrl, { tries: 100 });
	const key = await authedFetch(`${baseUrl}/api/auth/api-key`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ provider: "synthetic", key: "synthetic-test-key" }) });
	assert(key.ok, `saving the synthetic key: ${key.status}`);
	// Team wiki is on in two rooms.
	for (const room of [lookRoom, otherRoom]) {
		const granted = await authedFetch(`${baseUrl}/api/persistent-agents/${room}/mcp-connectors`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "grant", name: C.wiki.id }) });
		assert(granted.ok, `Team wiki on in ${room}: ${granted.status}`);
	}
	const browser = await chromium.launch({ ignoreDefaultArgs: ["--hide-scrollbars"] });
	try {
		const failed: string[] = [];
		const only = process.env.LOOK_ROWS?.split(",");
		for (const check of [checkRulesUnderSwitch, checkOff, checkSubPageHeader, checkConnectorPage, checkTools, checkRemove, checkAddPages, checkAddPagesAt761, checkReadOnly, checkShared, checkStates, checkPictures]) {
			if (only && !only.includes(check.name)) continue;
			try {
				await check(browser);
			} catch (error) {
				failed.push(`${check.name}: ${(error as Error).message.split("\n").filter((line, i) => i === 0 || /waiting for/.test(line)).slice(0, 2).join(" ").replace(/\u001b\[\d+m/g, "")} (lines ${[...((error as Error).stack ?? "").matchAll(/ui-smoke\.ts:(\d+)/g)].map((match) => match[1]).join(", ") || "?"})`);
				console.log(`  FAIL ${failed.at(-1)}`);
				for (const context of browser.contexts()) { if (process.env.LOOK_SHOTS) for (const open of context.pages()) await open.screenshot({ path: path.join(process.env.LOOK_SHOTS, `fail-${check.name}.png`) }).catch(() => {}); await context.close(); }
			}
		}
		assert(failed.length === 0, `${failed.length} rows failed:\n${failed.join("\n")}`);
	} finally {
		await browser.close();
	}
	console.log("settings look connector pages ui smoke passed");
} finally {
	await stopSmokeServer(server);
	model?.close();
	standIn.close();
	fs.rmSync(tempRoot, { recursive: true, force: true });
}
