// The settings windows' new look on a room's Connectors
// (52-settings-look-room-connectors.css). With the switch off, the page
// renders as before: its markup and every element's computed style, read with
// connectors on in every state, old answers and one that no longer exists;
// the picker open with a name rooms can't take, and its search with no match;
// a room with none on; nothing added yet; a failed read; an archived room;
// over remote access and on a shared server. With the switch on, Settings'
// Connectors list, a connector's own page, an add form and a room's Skills
// read as before too. Every rule of the page file sits under the switch's
// class. With the switch on, in both themes: two groups with a switch on each
// row, 64 tall with their columns at one x; each state's second line and what
// it offers; the old answers in their own section; the empty, loading, failed
// and archived pages; over remote access the computer's own refusal, and a
// shared server's one-line rows.
//
// The world is real: a server on a scratch home, connectors in its own file,
// their last checks kept as the server keeps them, stand-in connectors on this
// computer that answer with their tools, rooms granted through the room's
// route and old answers in a room's own settings file. Nothing signs in
// anywhere and nothing is downloaded. Answered in the page: the client
// context (remote access, a shared server), a read that fails, nothing added
// yet, a refused save, and the list's sign-in and checks, as
// settings-look-connectors-ui-smoke.ts answers them. Set LOOK_OFF_READING to a
// file to keep the switch-off reading for comparing two builds, and
// LOOK_OFF_BASE to compare with one; LOOK_OFF_WIDTHS=both to read 390 as well
// as 1440; LOOK_ROWS to run some rows; LOOK_SHOTS to a folder for a picture of
// each scene.
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import { fileURLToPath } from "node:url";
import { chromium, type Browser, type Locator, type Page, type Route } from "playwright";
import { authedFetch, SMOKE_SERVER_AUTH_ENV, SMOKE_SERVER_SPAWN_TREE_OPTIONS, smokeHomeEnv, stopSmokeServer, freePort, waitForServer } from "./smoke-server-process.js";
import { waitEvery } from "./smoke-wait.js";
import { answered, assert, closeWindow, DARK, desktop, goToPage, installColourTools, LIGHT, LOOK_FILE, lookPages, notLookPageFilesAfterLook, phone, requestsFromNow, rulesOutsideRoots, same, SWITCH_CLASS, type Theme } from "./settings-look-smoke-parts.js";

{
	const p = typeof chromium?.executablePath === "function" ? chromium.executablePath() : "";
	if (!p || !fs.existsSync(p)) {
		console.log("settings look room connectors ui smoke skipped (Chromium not installed)");
		process.exit(0);
	}
}

const waitUntil = waitEvery(100);
const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const webServerDir = path.resolve(scriptDir, "..");
const repoRoot = path.resolve(webServerDir, "..", "..");
const stylesDir = path.join(repoRoot, "apps", "web-ui", "src", "styles");
const PAGE_FILE = "52-settings-look-room-connectors.css";
const port = await freePort();
const baseUrl = `http://127.0.0.1:${port}`;

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "exxperts-settings-look-room-connectors-"));
const tempHome = path.join(tempRoot, "home");
const agentsRoot = path.join(tempHome, ".exxperts", "app", "personalized-agents");
const agentDir = path.join(tempHome, ".exxperts", "agent");
for (const dir of [agentsRoot, agentDir]) fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
process.env.HOME = tempHome;
process.env.USERPROFILE = tempHome;
process.env.EXXPERTS_CODING_AGENT_DIR = agentDir;
process.env.PI_CODING_AGENT_DIR = agentDir;
process.env.EXXETA_PERSISTENT_AGENTS_ROOT = agentsRoot;

const { CONNECTOR_WORDS: WORDS } = await import("../../web-ui/src/connector-rows.js");
const { roomListOnCount } = await import("../../web-ui/src/skill-source-copy.js");
/** The one list's heading: how many of the room's connectors are on. */
const onHeading = (on: number) => roomListOnCount(on, ON.length + OFF.length);
const { CONNECTORS_EACH_TOOL_LINE } = await import("../src/room-box/card-text.js");
const { CONNECTOR_REQUEST_LINES } = await import("../src/connector-form.js");
const { SHARED_SERVER_ADMIN_LINE } = await import("../../web-ui/src/remote-client-context.js");
const settingsStore = await import("../src/persistent-room-mcp-settings.js");
const authStore = await import("pi-mcp-adapter/mcp-auth.ts" as string);

const ROOM = "Look Room";
const QUIET_ROOM = "Quiet Room";
const GONE_ROOM = "Packed Room";
/** A room whose own folder holds a program's file, so that program can't start. */
const LOCKING_ROOM = "Board papers";

// --- The stand-in connectors on this computer --------------------------------------

const TOOLS: Record<string, string[]> = { "/wiki/mcp": ["search_pages", "get_page", "create_page", "move_page"], "/board/mcp": ["list_papers", "file_paper"], "/empty/mcp": [] };
const standIns = http.createServer((req, res) => {
	let raw = "";
	req.on("data", (chunk) => { raw += chunk; });
	req.on("end", () => {
		const tools = TOOLS[new URL(req.url ?? "/", "http://x").pathname];
		if (!tools) return void res.writeHead(401, { "content-type": "text/plain" }).end("sign in first");
		if (req.method !== "POST") return void res.writeHead(405).end();
		const message = JSON.parse(raw || "{}");
		if (message.id === undefined) return void res.writeHead(202).end();
		const result = message.method === "initialize" ? { protocolVersion: message.params?.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: "stand-in", version: "1.0.0" } }
			: message.method === "tools/list" ? { tools: tools.map((name) => ({ name, description: `${name}.`, inputSchema: { type: "object" } })) } : {};
		res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ jsonrpc: "2.0", id: message.id, result }));
	});
});
await new Promise<void>((resolve) => standIns.listen(0, "127.0.0.1", resolve));
const at = (where: string) => `http://127.0.0.1:${(standIns.address() as AddressInfo).port}${where}`;
/** Nothing listens on port 9: the kept checks say what a check found there. */
const NOWHERE = "http://127.0.0.1:9/mcp";

// --- The connectors, as the server keeps them ----------------------------------------

const C = {
	wiki: { id: "team-wiki", name: "Team wiki" },
	board: { id: "board-files", name: "Board files" },
	empty: { id: "empty-desk", name: "Empty desk" },
	ticket: { id: "ticket-desk", name: "Ticket desk" },
	slow: { id: "slow-desk", name: "Slow desk" },
	calendar: { id: "shared-calendar", name: "Shared calendar" },
	chat: { id: "team-chat", name: "Team chat" },
	office: { id: "office-files", name: "Office files" },
	node: { id: "node-tools", name: "Node tools" },
	locked: { id: "room-notes", name: "Room notes" },
	/** Brought in from another app under a name rooms can't take. */
	bad: { id: "Desk.files", name: "Desk files" },
	/** On in the room, and since removed from the app. */
	gone: { id: "old-desk", name: "old-desk" },
} as const;
type Key = keyof typeof C;
/** On in the look room, and off: in the order the room lists them, by their fixed names, then the one removed. */
const ON: Key[] = ["empty", "node", "chat", "wiki", "ticket", "gone"];
const OFF: Key[] = ["board", "bad", "office", "locked", "calendar", "slow"];
/** The old answers: tools allowed without asking in the look room, before the choice per tool existed. */
const OLD_ANSWERS: Partial<Record<Key, string[]>> = { wiki: ["create_page", "move_page"], chat: ["post_message"] };

// --- The page's own requests, answered here ---------------------------------------------

type Scene = {
	/** Over remote access, where the computer refuses every change here. */
	remote?: boolean;
	/** A shared server's page. */
	shared?: boolean;
	/** The room's connectors can't be read. */
	failed?: boolean;
	/** No connector added anywhere yet. */
	none?: boolean;
	/** The room's save refused, as an unexpected failure. */
	refuse?: boolean;
	/** The room's connectors read as an archived room's are. */
	archived?: boolean;
};
/** The changes the page asked of a room, in order. */
const changes: string[] = [];
/** Each connector's sign-in on Settings' list, as the browser left it. */
const signIns = new Map<string, "pending">();
/** The server's sentence when a remote device asks for a change only the computer makes (remote-routes.ts). */
const REMOTE_REFUSAL = "This action is only available on the computer running Exxperts.";
const nameOf = (route: Route) => decodeURIComponent(new URL(route.request().url()).pathname.split("/").at(-2)!);
const roomIds: Record<string, string> = {};

async function answer(page: Page, scene: Scene): Promise<void> {
	await page.unrouteAll({ behavior: "ignoreErrors" });
	if (scene.remote || scene.shared) await page.route("**/api/remote/client-context", (route) => route.fulfill({ json: scene.shared ? { remote: false, sharedServer: true } : { remote: true, capability: "full" } }));
	await page.route("**/api/mcp/status", async (route) => {
		const response = await route.fetch();
		const status = await response.json();
		// The one under a name rooms can't take reads as the server shows one it read from another app's own file.
		const servers = scene.none ? [] : status.servers.map((server: { name: string; source?: object }) => (server.name === C.bad.id ? { ...server, source: { ...server.source, importKind: "claude-desktop", importFile: "/Users/synthetic/Library/Application Support/Claude/claude_desktop_config.json" } } : server));
		return route.fulfill({ response, json: { ...status, servers } });
	});
	await page.route("**/api/persistent-agents/*/mcp-connectors", async (route) => {
		const request = route.request();
		if (request.method() === "PUT") {
			const body = JSON.parse(request.postData() ?? "{}");
			changes.push(`${body.action} ${body.name}${body.tool ? ` ${body.tool}` : ""}`);
			if (scene.remote) return route.fulfill({ status: 403, json: { error: REMOTE_REFUSAL, code: "remote_local_only" } });
			if (scene.refuse) return route.fulfill({ status: 500, json: { error: "stand-in: the save failed" } });
			return route.fallback();
		}
		if (scene.failed) return route.fulfill({ status: 500, json: { error: "stand-in: the room's connectors can't be read" } });
		// An archived room's own answer, read from the server.
		if (scene.archived) return route.fulfill({ response: await route.fetch({ url: `${baseUrl}/api/persistent-agents/${roomIds[GONE_ROOM]}/mcp-connectors` }) });
		if (scene.none) {
			const response = await route.fetch();
			return route.fulfill({ response, json: { ...(await response.json()), configuredConnectors: [], granted: [], displayNames: {}, allowedTools: {} } });
		}
		return route.fallback();
	});
	// Settings' list: a sign-in waits in the browser; its checks run on the server.
	await page.route("**/api/mcp/servers/*/login", async (route) => {
		const name = nameOf(route);
		if (route.request().method() === "DELETE") { signIns.delete(name); return route.fulfill({ json: { cancelled: true } }); }
		return route.fulfill({ json: signIns.get(name) === "pending" ? { pending: true } : { pending: false } });
	});
}

/** Closes a page's context once its routes have stood down, so none answers for a page that has gone. */
async function closePage(page: Page): Promise<void> {
	await page.unrouteAll({ behavior: "ignoreErrors" });
	await page.context().close();
}

const visible = (page: Page, selector: string) => page.locator(selector).filter({ visible: true }).first();
const pane = (page: Page) => visible(page, ".settings-dialog-pane");
const section = (page: Page) => visible(page, ".room-connectors-section");
const row = (page: Page, key: Key) => section(page).locator(".room-skills-row").filter({ has: page.locator(".room-skills-name", { hasText: new RegExp(`^${C[key].name.replace(".", "\\.")}$`) }) });
const switchOf = (page: Page, key: Key) => row(page, key).getByRole("switch");

/** Opens the room's window on Connectors with the scene's answers, its requests answered and the pointer away. */
async function openRoomConnectors(page: Page, scene: Scene = {}, room = ROOM): Promise<Locator> {
	await answer(page, scene);
	await page.reload();
	await page.locator(".persistent-agent-card").first().waitFor({ timeout: 15000 });
	await installColourTools(page);
	requestsFromNow(page);
	await page.locator(".persistent-agent-card").filter({ hasText: room }).locator(".card-gear-btn").click();
	await page.waitForSelector(".rs-shell", { timeout: 10000 });
	await goToPage(page, "Connectors");
	await section(page).locator(".room-skills-row, .settings-empty, .room-skills-empty, .checkpoint-proposal-error").first().waitFor({ timeout: 15000 });
	await answered(page, `${room}'s Connectors`);
	await page.mouse.move(5, 5);
	return pane(page);
}

/** Opens Settings on Connectors with the scene's answers. */
async function openSettingsConnectors(page: Page, scene: Scene = {}): Promise<Locator> {
	await answer(page, scene);
	await page.reload();
	await page.locator(".persistent-agent-card").first().waitFor({ timeout: 15000 });
	await installColourTools(page);
	requestsFromNow(page);
	await page.locator("button.sidebar-config-gear").filter({ visible: true }).first().click();
	await page.locator(".sidebar-config-menu button, .sidebar-config-menu a").filter({ hasText: /Settings/ }).first().click();
	await page.waitForSelector(".settings-overlay", { timeout: 10000 });
	await goToPage(page, "Connectors");
	await pane(page).locator(".connector-list-section").first().waitFor({ timeout: 15000 });
	await answered(page, "Settings Connectors");
	await page.mouse.move(5, 5);
	return pane(page);
}

/** The last checks as the seed keeps them: Settings' list checks again in the background when it opens, which rewrites them. */
function seedChecks(): void {
	const now = Date.now();
	fs.writeFileSync(path.join(agentDir, "mcp-connector-checks.json"), JSON.stringify({ schemaVersion: 1, checks: {
		[C.ticket.id]: { at: now, ok: false, httpStatus: 404, error: "HTTP 404" },
		[C.slow.id]: { at: now, ok: false, error: "fetch failed" },
		[C.calendar.id]: { at: now, ok: false, needsAuth: true, httpStatus: 401 },
		[C.node.id]: { at: now, ok: false, error: "npx was not found", programFailure: { cause: "node-missing" } },
	} }));
}

/** The room's connectors, old answers and last checks as the seed left them. */
function seedRooms(): void {
	seedChecks();
	settingsStore.writePersistentRoomMcpSettings(roomIds[ROOM], ON.map((key) => C[key].id), { persistentAgentsRoot: agentsRoot }, new Date(), Object.fromEntries(Object.entries(OLD_ANSWERS).map(([key, tools]) => [C[key as Key].id, tools!.map((tool) => ({ tool, addressPin: settingsStore.connectorAddressPin(key === "wiki" ? at("/wiki/mcp") : at("/chat/mcp")) }))])));
	settingsStore.writePersistentRoomMcpSettings(roomIds[QUIET_ROOM], [], { persistentAgentsRoot: agentsRoot });
}

// --- Measuring ------------------------------------------------------------------------------

type Box = { left: number; right: number; top: number; bottom: number; width: number; height: number };
const near = (a: number, b: number, what: string, within = 0.5) => assert(Math.abs(a - b) <= within, `${what}: ${a.toFixed(1)} against ${b.toFixed(1)}`);
const middle = (box: Box) => box.top + box.height / 2;

/** Waits until nothing that ends is still moving. */
const still = (page: Page, what: string) => waitUntil(() => page.evaluate(() => document.getAnimations().every((one) => one.playState !== "running" || one.effect?.getComputedTiming().iterations === Infinity)), `${what}: nothing moving`);

/** The ink-filled buttons on the open page, as a person sees them. */
const INK = { [LIGHT]: "#111111", [DARK]: "#f4f1ec" };
async function inkedOn(page: Page, theme: Theme): Promise<string[]> {
	return page.evaluate((ink) => {
		const w = window as any;
		const open = [...document.querySelectorAll(".settings-dialog-pane")].find((element) => element.getClientRects().length)!;
		return [...open.querySelectorAll("button, a.rs-btn")].filter((element) => element.getClientRects().length > 0 && w.__painted(getComputedStyle(element).backgroundColor) && w.__seen(element, getComputedStyle(element).backgroundColor) === ink).map((element) => element.textContent!.trim());
	}, INK[theme]);
}

/** Nothing sideways: neither the page nor the open pane scrolls across. */
async function nothingSideways(page: Page, what: string): Promise<void> {
	const wide = await page.evaluate(() => {
		const open = [...document.querySelectorAll(".settings-dialog-pane")].find((one) => one.getClientRects().length)!;
		return [document.documentElement.scrollWidth - window.innerWidth, open.scrollWidth - open.clientWidth];
	});
	same(wide.map((extra) => Math.max(0, extra)), [0, 0], `${what}: sideways scrolling (page, pane)`);
}

/** Words in colour on the open page that are not a status dot: every text's colour has no hue. */
async function colouredWords(page: Page): Promise<string[]> {
	return section(page).evaluate((root) => {
		const w = window as any;
		const hue = (hex: string) => { const rgb = [1, 3, 5].map((at) => parseInt(hex.slice(at, at + 2), 16)); return Math.max(...rgb) - Math.min(...rgb); };
		return [...root.querySelectorAll("*")].filter((element) => element.getClientRects().length && [...element.childNodes].some((node) => node.nodeType === 3 && node.textContent!.trim()))
			.filter((element) => hue(w.__seen(element, getComputedStyle(element).color)) > 24).map((element) => `${element.className}: ${element.textContent!.trim().slice(0, 30)}`);
	});
}

/** Tab walks every switch and button of the page in reading order, each with a whole 2 px ring that nothing clips. */
async function focusInReadingOrder(page: Page, where: string): Promise<void> {
	const expected = await section(page).evaluate((root) => [...root.querySelectorAll("button, input")].filter((element) => element.getClientRects().length && !(element as HTMLButtonElement).disabled).map((element) => `${element.getAttribute("aria-label") ?? element.textContent!.trim()}@${element.closest("[data-connector]")?.getAttribute("data-connector") ?? ""}`));
	// Into the first by the keyboard, so each ring is the keyboard's.
	await section(page).locator("button, input").first().focus();
	await page.keyboard.press("Shift+Tab");
	await page.keyboard.press("Tab");
	const seen: string[] = [];
	const rings: string[] = [];
	for (let i = 0; i < expected.length; i++) {
		if (i > 0) await page.keyboard.press("Tab");
		const now = await page.evaluate(() => {
			const element = document.activeElement as HTMLElement;
			// Where the pane has scrolled is the browser's; what is asked is whether a card cuts the ring.
			element.scrollIntoView({ block: "center" });
			const style = getComputedStyle(element);
			const width = parseFloat(style.outlineWidth);
			const offset = parseFloat(style.outlineOffset);
			const box = element.getBoundingClientRect();
			const ring = { left: box.left - offset - width, right: box.right + offset + width, top: box.top - offset - width, bottom: box.bottom + offset + width };
			// Every ancestor that clips holds the ring whole.
			let clipped = false;
			for (let at = element.parentElement; at; at = at.parentElement) {
				const clip = getComputedStyle(at);
				if (clip.overflowX === "visible" && clip.overflowY === "visible") continue;
				const edge = at.getBoundingClientRect();
				if (ring.left < edge.left - 0.5 || ring.right > edge.right + 0.5 || ring.top < edge.top - 0.5 || ring.bottom > edge.bottom + 0.5) clipped = true;
			}
			return { name: `${element.getAttribute("aria-label") ?? element.textContent!.trim()}@${element.closest("[data-connector]")?.getAttribute("data-connector") ?? ""}`, ring: `${style.outlineStyle} ${width}${clipped ? " clipped" : ""}` };
		});
		seen.push(now.name);
		if (now.ring !== "solid 2") rings.push(`${now.name}: ${now.ring}`);
	}
	same(seen, expected, `${where}: Tab in reading order`);
	same(rings, [], `${where}: focus rings`);
}

/** How many are on, as it is shown and where: beside the title, or on a phone as a quiet line over the list. One copy shows, and one is read. */
async function shownCount(page: Page): Promise<unknown[]> {
	return section(page).evaluate((root) => [...root.querySelectorAll(".pane-head-beside, .room-list-count")].filter((one) => one.getClientRects().length > 0).map((one) => [one.className, one.textContent]));
}

/** A switch flipped moves nothing and leaves no count untrue: every row keeps its place and the title counts the ones on. */
async function switchesStayPut(page: Page, where: string): Promise<void> {
	// Each row's place in the list, whatever the pane's scroll.
	const places = () => section(page).evaluate((root) => { const list = root.querySelector(".room-skills-rows")!.getBoundingClientRect().top; return [...root.querySelectorAll(".room-skills-row")].map((row) => `${row.querySelector(".room-skills-name")!.textContent} ${Math.round(row.getBoundingClientRect().top - list)}`); });
	const counted = async () => ((await shownCount(page))[0] as string[])[1];
	const order = async () => (await readRows(page)).map((one) => one.name);
	const flip = async (key: Key, want: boolean) => {
		await switchOf(page, key).click();
		await waitUntil(async () => !(await switchOf(page, key).isDisabled()) && (await switchOf(page, key).isChecked()) === want, `${where}: ${C[key].name} switched ${want ? "on" : "off"}`);
		await answered(page, `${where}: ${C[key].name} saved`);
	};
	changes.length = 0;
	const before = await places();
	same(await counted(), onHeading(ON.length), `${where}: the count before a switch is flipped`);
	await flip("board", true);
	same([changes, await places(), await counted()], [[`grant ${C.board.id}`], before, onHeading(ON.length + 1)], `${where}: Board files switched on, every row in its place, the count`);
	await flip("ticket", false);
	same([changes.slice(1), await places(), await counted()], [[`revoke ${C.ticket.id}`], before, onHeading(ON.length)], `${where}: Ticket desk switched off, every row in its place, the count`);
	await shoot(page, `${where.replace(" ", "-")}-3-switched-in-place`);
	// Opened again, the ones on first: Board files among them, Ticket desk after them.
	await closeWindow(page);
	await openRoomConnectors(page);
	const again = await order();
	const onNow = [...ON.filter((key) => key !== "ticket"), "board"].map((key) => C[key as Key].name);
	same([again.slice(0, onNow.length).sort(), again.slice(onNow.length).includes(C.ticket.name)], [[...onNow].sort(), true], `${where}: opened again, the ones on first`);
	await closeWindow(page);
	seedRooms();
}

// --- Pictures ---------------------------------------------------------------------------------

const shots = process.env.LOOK_SHOTS;
async function shoot(page: Page, name: string): Promise<void> {
	if (!shots) return;
	fs.mkdirSync(shots, { recursive: true });
	await page.screenshot({ path: path.join(shots, `${name}.png`) });
}

// --- The page file ------------------------------------------------------------------------

async function checkRulesUnderSwitch(browser: Browser): Promise<void> {
	const page = await lookPages({ baseUrl, room: ROOM }).openPage(browser, desktop(1280), "off");
	const roots = [SWITCH_CLASS];
	const css = fs.readFileSync(path.join(stylesDir, PAGE_FILE), "utf8");
	same(await rulesOutsideRoots(page, css, roots), [], `rules in ${PAGE_FILE} outside ${SWITCH_CLASS}`);
	// The check finds a rule outside, in a media query too, and a longer class name is not the root.
	same(await rulesOutsideRoots(page, `.room-connectors-section .room-skills-row { color: red; } ${SWITCH_CLASS}-x .a { color: red; } .settings-dialog .room-connector-line { color: red; } @media (max-width: 760px) { ${SWITCH_CLASS} .a, .room-connector-open { color: red; } }`, roots), [".room-connectors-section .room-skills-row", `${SWITCH_CLASS}-x .a`, ".settings-dialog .room-connector-line", ".room-connector-open"], "the check's own probe");
	const imports = [...fs.readFileSync(path.join(repoRoot, "apps", "web-ui", "src", "styles.css"), "utf8").matchAll(/@import "\.\/styles\/([^"]+)";/g)].map((match) => match[1]);
	same(notLookPageFilesAfterLook(imports), [], `the style files after ${LOOK_FILE} that are not the look's page files`);
	assert(imports.indexOf(PAGE_FILE) > imports.indexOf(LOOK_FILE), `${PAGE_FILE} loads after ${LOOK_FILE}`);
	const loaded = await page.evaluate(() => [...document.styleSheets].some((sheet) => [...sheet.cssRules].some((rule) => rule instanceof CSSStyleRule && rule.selectorText.includes(".room-connector-line"))));
	assert(loaded, "the page's stylesheet carries the page file's rules");
	await closePage(page);
	console.log(`  ok  every rule of ${PAGE_FILE} sits under ${SWITCH_CLASS}, and it loads after ${LOOK_FILE}`);
}

// --- What stays as it was ------------------------------------------------------------------

/** An element's markup, with React's generated ids blanked, and every element's computed style by property name; this run's folder and ports blanked, so two runs read alike. */
async function readAsItIs(root: Locator) {
	const read = await root.evaluate((element) => {
		const blank = (text: string) => text.replace(/«[^»]*»|:r[0-9a-z]+:/g, "#id");
		const copy = element.cloneNode(true) as Element;
		for (const fading of copy.querySelectorAll(".is-new")) fading.classList.remove("is-new");
		const styles = [element, ...element.querySelectorAll("*")].map((one) => {
			const style = getComputedStyle(one);
			return `${one.tagName.toLowerCase()}.${[...one.classList].filter((name) => name !== "is-new").join(".")} ${[...style].sort().map((name) => `${name}:${style.getPropertyValue(name)}`).join(";")}`;
		});
		return { markup: blank(copy.outerHTML), styles: styles.map(blank) };
	});
	let text = JSON.stringify(read);
	for (const folder of new Set([tempRoot, fs.realpathSync(tempRoot)])) text = text.replaceAll(folder, "<temp>");
	return JSON.parse(text.replace(/127\.0\.0\.1:\d+/g, "127.0.0.1:<port>"));
}

/** Each scene of a room's Connectors with the switch off, in both builds. */
const OFF_SCENES: Array<[string, Scene, string?]> = [
	["a room with none on", {}, QUIET_ROOM],
	["nothing added yet", { none: true }],
	["a failed read", { failed: true }],
	["an archived room", { archived: true }],
	["over remote access", { remote: true }],
	["a shared server", { shared: true }],
];

async function checkOff(browser: Browser): Promise<void> {
	const reading: Record<string, unknown> = {};
	const widths = process.env.LOOK_OFF_WIDTHS === "both" ? [["1440 light", desktop(1440, 900, LIGHT)], ["390 light", phone(LIGHT)]] as const : [["1440 light", desktop(1440, 900, LIGHT)]] as const;
	for (const [where, options] of widths) {
		const look = lookPages({ baseUrl, room: ROOM });
		const page = await look.openPage(browser, options, "off");
		seedRooms();
		let opened = await openRoomConnectors(page);
		same(await page.locator(".settings-look-next").count(), 0, `${where}, switch off: elements with the look's class`);
		same(await section(page).getByRole("switch").count(), 0, `${where}, switch off: switches`);
		reading[`${where}, every state`] = await readAsItIs(opened);
		// The picker, with a name rooms can't take, then its search with no match.
		await opened.getByRole("button", { name: "Enable connectors", exact: true }).click();
		await opened.locator(".room-skills-picker").waitFor();
		await page.mouse.move(5, 5);
		reading[`${where}, the picker`] = await readAsItIs(opened);
		await opened.locator(".room-skills-picker-search").fill("no such connector anywhere");
		await opened.getByText("No connectors match.").waitFor();
		reading[`${where}, the picker with no match`] = await readAsItIs(opened);
		await closeWindow(page);
		for (const [name, scene, room] of OFF_SCENES) {
			opened = await openRoomConnectors(page, scene, room);
			reading[`${where}, ${name}`] = await readAsItIs(opened);
			await closeWindow(page);
		}
		await closePage(page);

		// With the switch on, the pages this one shares its parts with.
		const on = await look.openPage(browser, options, "on");
		signIns.clear();
		signIns.set(C.calendar.id, "pending");
		opened = await openSettingsConnectors(on);
		await opened.locator(".connector-waiting-foot").waitFor({ timeout: 15000 });
		await waitUntil(async () => (await opened.locator(".connector-item-state .connector-dot-busy").count()) === 1 && (await opened.locator(".connector-slot-btn.is-busy").count()) === 0, `${where}, switch on: the list settles`, 20000);
		await answered(on, `${where}, switch on, Settings' Connectors`);
		await still(on, `${where}, Settings' Connectors`);
		reading[`${where}, switch on, Settings' Connectors`] = await readAsItIs(opened);
		await opened.locator(".connector-item").filter({ hasText: C.ticket.name }).locator(".connector-item-hit").click({ position: { x: 32, y: 32 } });
		await opened.locator(".connector-page").waitFor();
		await answered(on, `${where}, a connector's page`);
		await on.mouse.move(5, 5);
		await still(on, `${where}, a connector's page`);
		reading[`${where}, switch on, a connector's page`] = await readAsItIs(opened);
		await opened.locator(".connector-page-back").click();
		await opened.locator(".connector-add-btn").click();
		await on.getByRole("menuitem", { name: WORDS.addWays.web }).click();
		await still(on, `${where}, an add form`);
		reading[`${where}, switch on, an add form`] = await readAsItIs(opened.locator(".connector-custom-form"));
		await closeWindow(on);
		signIns.clear();
		await openRoomConnectors(on);
		await goToPage(on, "Skills");
		// Room settings holds every page at once: the Skills page alone.
		const skills = visible(on, ".room-skills-section:not(.room-connectors-section)");
		await skills.waitFor();
		await answered(on, `${where}, a room's Skills`);
		await on.mouse.move(5, 5);
		reading[`${where}, switch on, a room's Skills`] = await readAsItIs(skills);
		await closePage(on);
	}
	if (process.env.LOOK_OFF_READING) fs.writeFileSync(process.env.LOOK_OFF_READING, JSON.stringify(reading, null, 1));
	// Against a reading from a page built from the base: the same, page by page.
	if (process.env.LOOK_OFF_BASE) {
		const base = JSON.parse(fs.readFileSync(process.env.LOOK_OFF_BASE, "utf8")) as Record<string, { markup: string; styles: string[] }>;
		same(Object.keys(reading), Object.keys(base), "the pages read against the base's");
		const differ = Object.entries(reading).filter(([name, now]) => JSON.stringify(now) !== JSON.stringify(base[name])).map(([name, now]) => {
			const was = base[name];
			const at = (now as typeof was).styles.findIndex((style, i) => style !== was.styles[i]);
			return `${name} (${(now as typeof was).markup === was.markup ? "same markup" : "markup differs"}${at >= 0 ? `, first style differing: ${(now as typeof was).styles[at].slice(0, 80)}` : ""})`;
		});
		same(differ, [], "pages that read otherwise than on the base");
	}
	console.log(`  ok  switch off: no look class and no switch on a room's Connectors; ${Object.keys(reading).length} readings${process.env.LOOK_OFF_BASE ? " equal to the base's" : ""}${process.env.LOOK_OFF_READING ? ` (kept in ${process.env.LOOK_OFF_READING})` : ""}`);
}

// --- With the switch on ------------------------------------------------------------------------

/** Each row's second line with the switch on, and whether "Open connectors" follows it: the same with the switch off,
 * so a switch flipped moves nothing. */
const LINES: Record<Key, { text: string; dot: string | null; opens: boolean }> = {
	wiki: { text: `${at("/wiki/mcp")} · ${WORDS.toolCount(4)}`, dot: null, opens: false },
	empty: { text: `${at("/empty/mcp")} · ${WORDS.toolCount(0)}`, dot: null, opens: false },
	ticket: { text: WORDS.wentWrong.addressNotFound.fact, dot: "err", opens: true },
	chat: { text: WORDS.status.needsReconnecting, dot: "warn", opens: true },
	node: { text: WORDS.wentWrong.nodeMissing.fact, dot: "err", opens: true },
	gone: { text: `${CONNECTOR_REQUEST_LINES.noLongerExists} ${WORDS.room.gone.way}`, dot: "err", opens: false },
	board: { text: `${at("/board/mcp")} · ${WORDS.toolCount(2)}`, dot: null, opens: false },
	slow: { text: WORDS.wentWrong.noAnswer.fact, dot: "err", opens: true },
	calendar: { text: WORDS.status.notConnected, dot: "wait", opens: true },
	office: { text: WORDS.status.program, dot: null, opens: false },
	locked: { text: WORDS.wentWrong.cantStart(LOCKING_ROOM).fact, dot: "err", opens: true },
	bad: { text: WORDS.room.badName("Claude Desktop"), dot: "err", opens: false },
};

/** What each row shows, read from the page: its group, second line, dot, way on and control. */
async function readRows(page: Page) {
	return section(page).evaluate((root) => [...root.querySelectorAll(".room-connector-group")].flatMap((group) => {
		const title = group.querySelector(".room-connector-group-title")?.textContent ?? null;
		return [...group.querySelectorAll(".room-skills-row")].map((element) => {
			const line = element.querySelector(".room-connector-line");
			const control = element.querySelector(".room-skills-row-actions input, .room-skills-row-actions button");
			return {
				group: title,
				name: element.querySelector(".room-skills-name")!.textContent,
				text: line?.querySelector(".room-connector-fact")?.textContent ?? null,
				tip: line?.querySelector(".room-connector-fact")?.getAttribute("title") ?? null,
				dot: line?.querySelector(".connector-dot")?.className.replace("connector-dot connector-dot-", "") ?? null,
				opens: line?.querySelector(".room-connector-open")?.textContent ?? null,
				control: control ? (control.getAttribute("role") === "switch" ? `switch ${(control as HTMLInputElement).checked ? "on" : "off"}` : control.textContent) : null,
			};
		});
	}));
}

async function checkRoomConnectors(browser: Browser): Promise<void> {
	for (const [where, options] of [["1440 light", desktop(1440, 900, LIGHT)], ["1440 dark", desktop(1440, 900, DARK)], ["390 light", phone(LIGHT)], ["390 dark", phone(DARK)]] as const) {
		const theme = where.endsWith("dark") ? DARK : LIGHT;
		const narrow = where.startsWith("390");
		const page = await lookPages({ baseUrl, room: ROOM }).openPage(browser, options, "on");
		seedRooms();
		const opened = await openRoomConnectors(page);
		await shoot(page, `${where.replace(" ", "-")}-1-every-state`);
		// How many are on beside the title, one list with the ones on first, then the old answers; no Enable connectors and no picker.
		same(await shownCount(page), [[narrow ? "room-list-count" : "pane-head-beside", onHeading(ON.length)]], `${where}: how many are on, ${narrow ? "a quiet line over the list" : "beside the title"}, one copy`);
		same(await opened.locator(".room-connector-group-title").allTextContents(), [WORDS.room.allowedHereTitle], `${where}: the section titles`);
		same((await readRows(page)).map((one) => [one.group, one.name]), [...ON, ...OFF].map((key) => [null, C[key].name]), `${where}: the rows in one list, the ones on first`);
		same([await opened.getByRole("button", { name: "Enable connectors" }).count(), await opened.locator(".room-skills-picker").count()], [0, 0], `${where}: Enable connectors and its picker`);
		// The page's one way to Settings, Connectors ends the lead.
		same(await section(page).locator(".pane-lead").textContent(), `${WORDS.room.lead} ${CONNECTORS_EACH_TOOL_LINE} ${WORDS.room.manage}`, `${where}: the lead, the tool line and its link`);
		same(await inkedOn(page, theme), [], `${where}: ink buttons`);
		await nothingSideways(page, where);
		// Every row 64 tall but the name rooms can't take and the one removed, whose reasons wrap; on a phone, with no tip, every
		// broken row's words wrap, and a row with "Open connectors" grows a line for it.
		const geometry = await section(page).evaluate((root) => [...root.querySelectorAll(".room-connector-group .room-skills-row")].map((element) => {
			const box = (one: Element | null) => { if (!one) return null; const r = one.getBoundingClientRect(); return { left: r.left, right: r.right, top: r.top, bottom: r.bottom, width: r.width, height: r.height }; };
			const card = element.closest(".room-skills-rows")!;
			const line = element.querySelector(".room-connector-line");
			const fact = element.querySelector(".room-connector-fact") as HTMLElement | null;
			return {
				name: element.querySelector(".room-skills-name")!.textContent!,
				row: box(element)!,
				card: box(card)!,
				cardPadding: parseFloat(getComputedStyle(card).paddingRight),
				tile: box(element.querySelector(".connector-avatar"))!,
				nameBox: box(element.querySelector(".room-skills-name"))!,
				nameStyle: (() => { const style = getComputedStyle(element.querySelector(".room-skills-name")!); return `${style.fontSize}/${style.lineHeight}/${style.fontWeight}`; })(),
				switchBox: box(element.querySelector("[role=switch]")),
				control: box(element.querySelector(".room-skills-row-actions input, .room-skills-row-actions button")),
				line: box(line),
				lineStyle: line ? (() => { const style = getComputedStyle(line); return `${style.fontSize}/${style.lineHeight}`; })() : null,
				factCut: fact ? fact.scrollWidth > fact.clientWidth + 0.5 : false,
				broken: line?.classList.contains("is-broken") ?? false,
				open: box(element.querySelector(".room-connector-open")),
				// The button's own height, and whether a tap 1 px inside its top and bottom edges lands on it.
				button: (() => { const button = element.querySelector(".room-skills-row-actions > button"); if (!button) return null; const r = button.getBoundingClientRect(); const hits = (y: number) => button.contains(document.elementFromPoint(r.left + r.width / 2, y)); return [Math.round(r.height), hits(r.top + 1), hits(r.bottom - 1)]; })(),
			};
		}));
		for (const one of geometry) {
			const wraps = one.name === C.bad.name || one.name === C.gone.name || (narrow && one.broken);
			if (wraps) same(one.factCut, false, `${where}, ${one.name}: its words whole`);
			const grows = narrow && one.open !== null;
			if (!wraps && !grows) near(one.row.height, 64, `${where}, ${one.name}: the row's height`);
			if (wraps && !grows) assert(one.row.height >= 64, `${where}, ${one.name}: the row grows for its reason (${one.row.height})`);
			if (grows) assert(one.row.height > 64 + 17, `${where}, ${one.name}: the row grows a line for Open connectors (${one.row.height})`);
			same(one.nameStyle, "14px/20px/500", `${where}, ${one.name}: the name`);
			if (one.line) same(one.lineStyle, "13px/18px", `${where}, ${one.name}: the second line`);
			same([one.tile.width, one.tile.height], [32, 32], `${where}, ${one.name}: the tile`);
			// The tile centred on the row.
			near(middle(one.tile), middle(one.row), `${where}, ${one.name}: the tile on the row's middle`, 1);
			if (one.switchBox) {
				// The look's switch: 44 by 24 on a phone.
				same([one.switchBox.width, one.switchBox.height], narrow ? [44, 24] : [36, 20], `${where}, ${one.name}: the switch`);
				near(one.switchBox.right, one.card.right - 1 - one.cardPadding, `${where}, ${one.name}: the switch at the right padding`);
				// Centred on the row; at 390 on the name's line.
				near(middle(one.switchBox), narrow ? middle(one.nameBox) : middle(one.row), `${where}, ${one.name}: the switch's middle`, 1);
			} else if (one.control) near(one.control.right, one.card.right - 1 - one.cardPadding, `${where}, ${one.name}: its button at the right padding`);
			if (narrow && one.line) near(one.line.right, one.card.right - 1 - one.cardPadding, `${where}, ${one.name}: line 2 to the card's right padding, under the control`);
			if (narrow && one.button) same(one.button, [44, true, true], `${where}, ${one.name}: its button the family's 44 on a phone, a tap at either edge landing on it`);
			if (narrow && one.control && one.line) assert(one.control.bottom <= one.line.top + 0.5, `${where}, ${one.name}: the control above line 2 (${(one.control.bottom - one.line.top).toFixed(1)} into it)`);
			if (narrow && one.control) assert(one.control.top >= one.row.top + 4, `${where}, ${one.name}: the control clear of the row's top line (${(one.control.top - one.row.top).toFixed(1)})`);
			// Line 2 one line, but the reason that wraps; at 390 under the name.
			if (one.line && !wraps) near(one.line.top, one.nameBox.bottom + 2, `${where}, ${one.name}: line 2 under the name`, 1);
		}
		// The tile, the name and the control each at one x on every row.
		for (const [part, of] of [["tile", (one: typeof geometry[number]) => one.tile.left], ["name", (one: typeof geometry[number]) => one.nameBox.left], ["control", (one: typeof geometry[number]) => one.control?.right ?? null]] as const) {
			const xs = [...new Set(geometry.map(of).filter((x): x is number => x !== null).map((x) => Math.round(x * 2) / 2))];
			same(xs.length, 1, `${where}: the ${part} at one x (${xs.join(", ")})`);
		}
		// A cut line is whole in its tip.
		for (const one of await readRows(page)) if (one.text !== null) same(one.tip, one.text, `${where}, ${one.name}: the line's tip`);
		// Section titles a section's label, 13/20 at 600 (44), 8 above their card; sections 32 apart.
		const titles = await section(page).evaluate((root) => [...root.querySelectorAll(".room-connector-group")].map((group) => {
			const title = [...group.querySelectorAll(".room-connector-group-title, .room-list-count")].find((one) => one.getClientRects().length > 0);
			const style = title ? getComputedStyle(title) : null;
			return { style: style && `${style.fontSize}/${style.lineHeight}/${style.fontWeight}`, gap: title ? Math.round(group.querySelector(".room-skills-rows")!.getBoundingClientRect().top - title.getBoundingClientRect().bottom) : null, top: group.getBoundingClientRect().top, bottom: group.getBoundingClientRect().bottom };
		}));
		// The list has no title of its own; on a phone the count is its quiet line.
		same(titles.map((one) => [one.style, one.gap]), [narrow ? ["13px/18px/400", 8] : [null, null], ["13px/20px/600", 8]], `${where}: section titles and their gap to the card`);
		same(titles.slice(1).map((one, i) => Math.round(one.top - titles[i].bottom)), titles.slice(1).map(() => 32), `${where}: sections apart`);
		await focusInReadingOrder(page, where);
		if (theme === LIGHT) await switchesStayPut(page, where);
		await closePage(page);
	}
	// A refused save: a strip with a red dot 12 above the list, the switch back where it was.
	const page = await lookPages({ baseUrl, room: ROOM }).openPage(browser, desktop(1440, 900, LIGHT), "on");
	seedRooms();
	await openRoomConnectors(page, { refuse: true });
	await switchOf(page, "board").click();
	const strip = section(page).locator("> .checkpoint-proposal-error");
	await strip.waitFor();
	same(await strip.textContent(), CONNECTOR_REQUEST_LINES.saveFailed, "a refused save: its line");
	same(await strip.getAttribute("role"), "alert", "a refused save: said at once");
	await waitUntil(async () => !(await switchOf(page, "board").isDisabled()), "a refused save: the switch is free");
	same(await switchOf(page, "board").isChecked(), false, "a refused save: the switch back where it was");
	const stripLook = await strip.evaluate((element) => {
		const w = window as any;
		const dialog = document.querySelector(".settings-dialog")!;
		return { dot: w.__seen(element, getComputedStyle(element, "::before").backgroundColor), danger: w.__seen(dialog, getComputedStyle(dialog).getPropertyValue("--error").trim()), gap: Math.round(document.querySelector(".room-connectors-section .room-connector-groups")!.getBoundingClientRect().top - element.getBoundingClientRect().bottom) };
	});
	same([stripLook.dot, stripLook.gap], [stripLook.danger, 12], "a refused save: a red dot, 12 above the list");
	await shoot(page, "1440-light-2-refused-save");
	await closePage(page);
	console.log("  ok  one list with \"n of m on\" beside the title (on a phone a quiet line over it), the ones on first, a switch flipped moving nothing and the count true after it, then the old answers; the lead ending with its link to Settings; rows 64 tall with tile, name and control at one x, the switch 36 by 20 at the right padding, line 2 one line under the name, titles 13/20 at 600 8 above their cards, 32 between sections; at 390 the switch on the name's line and Open connectors on a line of its own; both themes");
}

/** Each row's control as the Approach gives it: Remove for the one removed, none for a name rooms can't take, else its switch. */
const controlOf = (key: Key) => (key === "gone" ? WORDS.button.remove : key === "bad" ? null : `switch ${ON.includes(key) ? "on" : "off"}`);

async function checkStates(browser: Browser): Promise<void> {
	for (const [where, options] of [["1440 light", desktop(1440, 900, LIGHT)], ["1440 dark", desktop(1440, 900, DARK)], ["390 light", phone(LIGHT)]] as const) {
		const page = await lookPages({ baseUrl, room: ROOM }).openPage(browser, options, "on");
		seedRooms();
		await openRoomConnectors(page);
		const read = await readRows(page);
		same(read.map((one) => [one.name, one.text, one.dot, one.opens, one.control]), [...ON, ...OFF].map((key) => [C[key].name, LINES[key].text, LINES[key].dot, LINES[key].opens ? "Open connectors" : null, controlOf(key)]), `${where}: each state's line, dot, way on and control`);
		same(await colouredWords(page), [], `${where}: words in colour`);
		// What a screen reader hears on each control: the connector's name, and the line's words as its description.
		const heard = await section(page).locator(".room-connector-group .room-skills-row-actions :is(input, button)").evaluateAll((controls) => controls.map((control) => {
			const text = (ids: string | null) => (ids ?? "").split(" ").filter(Boolean).map((id) => document.getElementById(id)?.textContent ?? "").join(" ");
			return [control.getAttribute("aria-labelledby") ? text(control.getAttribute("aria-labelledby")) : control.textContent, text(control.getAttribute("aria-describedby"))];
		}));
		same(heard, [...ON, ...OFF].filter((key) => key !== "bad").map((key) => [key === "gone" ? WORDS.button.remove : C[key].name, LINES[key].text]), `${where}: what a screen reader hears on each control`);
		// Every dot as its state's colour: amber for a sign-in expired, red broken, a hollow ring for not connected.
		const dots = await section(page).evaluate((root) => {
			const w = window as any;
			const dialog = document.querySelector(".settings-dialog")!;
			const token = (name: string) => w.__seen(dialog, getComputedStyle(dialog).getPropertyValue(name).trim());
			return { want: { warn: token("--exx-warning"), err: token("--error"), wait: "ring" }, got: Object.fromEntries([...root.querySelectorAll(".connector-dot")].map((dot) => { const before = getComputedStyle(dot, "::before"); return [dot.className.split("connector-dot-")[1], parseFloat(before.borderTopWidth) > 0 && !w.__painted(before.backgroundColor) ? "ring" : w.__seen(dot, before.backgroundColor)]; })) };
		});
		same(Object.entries(dots.got).sort(), Object.entries(dots.want).sort(), `${where}: the dots' colours`);
		await shoot(page, `${where.replace(" ", "-")}-4-states`);
		// "Open connectors" on a row opens Settings, Connectors.
		await row(page, "ticket").locator(".room-connector-open").click();
		await page.locator(".settings-overlay").waitFor({ timeout: 10000 });
		await waitUntil(async () => (await page.locator(".settings-dialog-nav-item.active").first().innerText()).trim() === "Connectors", `${where}: Settings opens on Connectors`);
		await visible(page, ".connector-list-section").waitFor({ timeout: 10000 });
		await closePage(page);
	}
	console.log("  ok  each state: a sign-in's state, a broken one what went wrong, on or off, each with Open connectors; the one removed its line and Remove; a name rooms can't take its reason and no control; colour only on dots; Open connectors opens Settings, Connectors; both themes and at 390");
}

/** The old answers as the room's own answer names them. */
async function oldAnswerNames(): Promise<string[]> {
	const room = await (await authedFetch(`${baseUrl}/api/persistent-agents/${roomIds[ROOM]}/mcp-connectors`)).json() as { allowedTools: Record<string, Array<{ shown: string }>> };
	return [C.chat.id, C.wiki.id].flatMap((id) => room.allowedTools[id].map(({ shown }) => shown));
}

async function checkOldAnswers(browser: Browser): Promise<void> {
	for (const [where, options] of [["1440 light", desktop(1440, 900, LIGHT)], ["1440 dark", desktop(1440, 900, DARK)]] as const) {
		const page = await lookPages({ baseUrl, room: ROOM }).openPage(browser, options, "on");
		seedRooms();
		const names = await oldAnswerNames();
		await openRoomConnectors(page);
		const answers = section(page).locator(".room-connector-answers");
		same(await section(page).locator(".room-connector-group-title").last().textContent(), WORDS.room.allowedHereTitle, `${where}: the old answers' title`);
		same(await answers.locator(".room-connector-answer").evaluateAll((rows) => rows.map((one) => [one.querySelector(".room-connector-tool")!.textContent, one.querySelector(".room-connector-of")!.textContent, Math.round(one.getBoundingClientRect().height), one.querySelector("button")?.textContent])), names.map((name, i) => [name, i === 0 ? C.chat.name : C.wiki.name, 48, WORDS.button.remove]), `${where}: the old answers' rows`);
		// After the groups.
		same(await section(page).locator(".room-connector-group").last().locator(".room-connector-answers").count(), 1, `${where}: the old answers after the groups`);
		await shoot(page, `${where.replace(" ", "-")}-5-old-answers`);
		// Remove by keyboard: one request, the focus on the next Remove, else that connector's switch; the section goes when empty.
		changes.length = 0;
		const removes = answers.getByRole("button");
		await removes.nth(1).focus();
		await page.keyboard.press("Enter");
		await waitUntil(async () => (await answers.locator(".room-connector-answer").count()) === 2, `${where}: the old answer goes`);
		same(changes, [`forget-tool ${C.wiki.id} create_page`], `${where}: the Remove's one request`);
		await waitUntil(async () => (await page.evaluate(() => document.activeElement?.getAttribute("aria-label"))) === `Remove ${names[2]}`, `${where}: the focus on the next Remove`);
		await page.keyboard.press("Enter");
		await waitUntil(async () => (await answers.locator(".room-connector-answer").count()) === 1, `${where}: the next old answer goes`);
		await waitUntil(async () => (await page.evaluate(() => document.activeElement?.getAttribute("aria-labelledby") ? document.activeElement.closest("[data-connector]")?.getAttribute("data-connector") : null)) === C.wiki.id, `${where}: the focus on its connector's switch`);
		await removes.first().click();
		await waitUntil(async () => (await section(page).locator(".room-connector-answers").count()) === 0, `${where}: the section goes when empty`);
		same(changes.length, 3, `${where}: one request a Remove`);
		await closePage(page);
	}
	console.log("  ok  the old answers in their own section after the groups, rows 48 with Remove; a Remove sends one request and the focus moves to the next Remove, else that connector's switch; the section goes when empty; both themes");
}

async function checkEmptyAndFailed(browser: Browser): Promise<void> {
	for (const [where, options] of [["1440 light", desktop(1440, 900, LIGHT)], ["1440 dark", desktop(1440, 900, DARK)], ["390 light", phone(LIGHT)]] as const) {
		const page = await lookPages({ baseUrl, room: ROOM }).openPage(browser, options, "on");
		seedRooms();
		const look = (selector: string) => section(page).locator(selector).first().evaluate((element) => {
			const w = window as any;
			const dialog = document.querySelector(".settings-dialog")!;
			const style = getComputedStyle(element);
			const token = (name: string) => w.__seen(dialog, getComputedStyle(dialog).getPropertyValue(name).trim());
			const words = element.querySelector("span") ?? element;
			return { text: element.textContent, colour: w.__seen(element, style.color), muted: token("--muted"), fg: token("--fg"), danger: token("--error"), card: parseFloat(style.borderTopWidth) > 0 || w.__painted(style.backgroundColor) && w.__seen(element, style.backgroundColor) !== w.__fill(element.parentElement), dot: w.__seen(element, getComputedStyle(element, "::before").backgroundColor), contrast: w.__contrast(words) };
		});
		// Nothing added yet: its line, and no card.
		await openRoomConnectors(page, { none: true });
		const none = await look(".settings-empty");
		// The way to add one is the lead's link, so the line says only that there are none.
		same([none.text, none.colour === none.muted, none.card, await section(page).locator(".room-skills-rows").count()], [WORDS.noneYet, true, false, 0], `${where}: nothing added yet`);
		await nothingSideways(page, `${where}, nothing added yet`);
		await shoot(page, `${where.replace(" ", "-")}-6-nothing-yet`);
		await closeWindow(page);
		// None on: no line, every connector in one card, "0 of n on" beside the title.
		await openRoomConnectors(page, {}, QUIET_ROOM);
		same([((await shownCount(page)) as string[][]).map(([, words]) => words), await section(page).locator(".room-connector-group-title").count(), await section(page).locator(".room-skills-rows").count(), await section(page).locator(".room-skills-row").count(), await section(page).locator(".room-skills-empty").count()], [[roomListOnCount(0, OFF.length + ON.length - 1)], 0, 1, OFF.length + ON.length - 1, 0], `${where}: none on`);
		await nothingSideways(page, `${where}, none on`);
		await shoot(page, `${where.replace(" ", "-")}-7-none-on`);
		await closeWindow(page);
		// Loading: a muted line.
		let release = () => {};
		const held = new Promise<void>((resolve) => { release = resolve; });
		await answer(page, {});
		await page.route("**/api/persistent-agents/*/mcp-connectors", async (route) => { await held; await route.fallback(); });
		await page.reload();
		await page.locator(".persistent-agent-card").first().waitFor({ timeout: 15000 });
		await installColourTools(page);
		await page.locator(".persistent-agent-card").filter({ hasText: ROOM }).locator(".card-gear-btn").click();
		await goToPage(page, "Connectors");
		await section(page).locator(".ai-setup-copy").waitFor();
		const loading = await look(".ai-setup-copy");
		same([loading.text, loading.colour === loading.muted, loading.card], ["Loading connectors…", true, false], `${where}: loading`);
		release();
		await section(page).locator(".room-skills-row").first().waitFor();
		await closeWindow(page);
		// A failed read: a red-dot strip, its line in the text colour at 4.5:1 or more, and Try again, which reads again.
		await openRoomConnectors(page, { failed: true });
		const failed = await look(".connector-load-error");
		same([failed.text, failed.colour === failed.fg, failed.dot === failed.danger, failed.contrast >= 4.5], [`${WORDS.room.loadFailed}${WORDS.loadAgain}`, true, true, true], `${where}: a failed read (${failed.contrast.toFixed(2)}:1)`);
		await nothingSideways(page, `${where}, a failed read`);
		await shoot(page, `${where.replace(" ", "-")}-8-failed`);
		await answer(page, {});
		await section(page).getByRole("button", { name: WORDS.loadAgain }).click();
		await section(page).locator(".room-skills-row").first().waitFor({ timeout: 10000 });
		same(await section(page).locator(".connector-load-error").count(), 0, `${where}: Try again reads again`);
		await closeWindow(page);
		// An archived room: an ink-dot strip and no switch.
		await openRoomConnectors(page, { archived: true });
		const archived = await look(".checkpoint-proposal-error");
		same([archived.text, archived.colour === archived.fg, archived.dot === archived.fg, await section(page).getByRole("switch").count()], [WORDS.room.archived, true, true, 0], `${where}: an archived room`);
		// No lead telling a person to switch one on where nothing can be switched.
		same(await section(page).locator(".pane-lead").count(), 0, `${where}: an archived room's lead`);
		await nothingSideways(page, `${where}, an archived room`);
		await shoot(page, `${where.replace(" ", "-")}-9-archived`);
		await closePage(page);
	}
	console.log("  ok  nothing added yet its line and no card; none on one card with \"0 of n on\" beside the title (a quiet line over it on a phone); loading a muted line; a failed read a red-dot strip in the text colour at 4.5:1 or more with Try again, which reads again; an archived room an ink-dot strip and no switch; both themes; nothing sideways at 390");
}

async function checkReadOnly(browser: Browser): Promise<void> {
	// Over remote access at 390: the switches and the Remove offered, a press refused in the computer's own words, no Open connectors.
	let page = await lookPages({ baseUrl, room: ROOM }).openPage(browser, phone(LIGHT), "on");
	seedRooms();
	await openRoomConnectors(page, { remote: true });
	same([await section(page).getByRole("switch").count(), await row(page, "gone").getByRole("button", { name: WORDS.button.remove }).count(), await section(page).locator(".room-connector-answer button").count(), await section(page).getByRole("button", { name: "Open connectors" }).count()], [ON.length + OFF.length - 2, 1, 0, 0], `remote access: switches, the removed one's Remove, the old answers' Remove and Open connectors`);
	same(await section(page).locator(".room-connector-answer").count(), Object.values(OLD_ANSWERS).flat().length, "remote access: the old answers listed");
	changes.length = 0;
	// The last switch, far down the page: the refusal comes into view, clear of the header.
	await switchOf(page, "slow").click();
	const strip = section(page).locator("> .checkpoint-proposal-error");
	await strip.waitFor();
	same([await strip.textContent(), changes], [REMOTE_REFUSAL, [`grant ${C.slow.id}`]], "remote access: a press refused in the computer's own words");
	await waitUntil(() => strip.evaluate((element) => { const box = element.getBoundingClientRect(); const hit = document.elementFromPoint(box.left + 24, box.top + box.height / 2); return hit !== null && element.contains(hit); }), "remote access: the refusal in view");
	await nothingSideways(page, "remote access");
	await shoot(page, "390-light-10-remote-refused");
	await closePage(page);
	// A shared server: no state line, rows one line and 48 tall, its own tool line and words.
	page = await lookPages({ baseUrl, room: ROOM }).openPage(browser, desktop(1440, 900, LIGHT), "on");
	await openRoomConnectors(page, { shared: true });
	const rows = await section(page).locator(".room-connector-group .room-skills-row").evaluateAll((all) => all.map((one) => [one.querySelector(".room-skills-name")!.textContent, one.querySelector(".room-connector-line") !== null, Math.round(one.getBoundingClientRect().height)]));
	// The name rooms can't take keeps its reason, which the name alone gives.
	same(rows.filter(([name]) => name !== C.gone.name && name !== C.bad.name), [...ON, ...OFF].filter((key) => key !== "gone" && key !== "bad").map((key) => [C[key].name, false, 48]), "a shared server: rows with no state line, 48 tall");
	same(await section(page).locator(".pane-lead").textContent(), `${WORDS.room.lead} Reading runs freely. Anything else asks you first. This goes by what each connector says about its own tools.`, "a shared server: its tool line");
	same(await section(page).getByRole("button", { name: "Open connectors" }).count(), 0, "a shared server: Open connectors");
	await shoot(page, "1440-light-11-shared-server");
	await closeWindow(page);
	await openRoomConnectors(page, { shared: true, none: true });
	same(await section(page).locator(".settings-empty").textContent(), `${WORDS.noneYet} ${SHARED_SERVER_ADMIN_LINE}`, "a shared server with none: its line");
	await closePage(page);
	console.log("  ok  over remote access at 390 the switches and Remove offered, a press refused in the computer's own words, no Open connectors; a shared server's rows one line and 48 tall with its own tool line and words");
}

async function checkShared(browser: Browser): Promise<void> {
	for (const theme of [LIGHT, DARK] as const) {
		const page = await lookPages({ baseUrl, room: ROOM }).openPage(browser, desktop(1440, 900, theme), "on");
		seedRooms();
		await openRoomConnectors(page);
		// Only the scale's sizes and weights; every word at 4.5:1 or more, every dot at 3:1 or more.
		const measured = await section(page).evaluate((root) => {
			const w = window as any;
			const texts = [...root.querySelectorAll("*")].filter((element) => element.getClientRects().length && [...element.childNodes].some((node) => node.nodeType === 3 && node.textContent!.trim()));
			const dots = [...root.querySelectorAll(".connector-dot")].map((dot) => { const before = getComputedStyle(dot, "::before"); return [dot.className, w.__colourContrast(dot, w.__painted(before.backgroundColor) ? before.backgroundColor : before.borderTopColor)]; });
			return {
				type: [...new Set(texts.map((element) => { const style = getComputedStyle(element); return `${style.fontSize}/${style.fontWeight}`; }))].sort(),
				low: texts.map((element) => [element.textContent!.trim().slice(0, 30), w.__contrast(element)] as const).filter(([, ratio]) => ratio < 4.5),
				lowest: Math.min(...texts.map((element) => w.__contrast(element))),
				dots: dots.filter(([, ratio]) => ratio < 3),
				lowestDot: Math.min(...dots.map(([, ratio]) => ratio as number)),
			};
		});
		// 600 is a section's label (44).
		const scale = /^(24|18|14|13|12)px\/(400|500|600|700)$/;
		same(measured.type.filter((kind) => !scale.test(kind)), [], `${theme}: sizes and weights off the scale`);
		same(measured.low, [], `${theme}: words under 4.5:1`);
		same(measured.dots, [], `${theme}: dots under 3:1`);
		console.log(`  ..  ${theme}: the lowest word ${measured.lowest.toFixed(2)}:1, the lowest dot ${measured.lowestDot.toFixed(2)}:1`);
		// "Open connectors" on a line: underlined under the pointer, dimmed pressed, a ring and an underline focused.
		const open = row(page, "ticket").locator(".room-connector-open");
		const decoration = () => open.evaluate((element) => `${getComputedStyle(element).textDecorationLine} ${getComputedStyle(element).opacity}`);
		same(await decoration(), "none 1", `${theme}: Open connectors at rest`);
		await open.hover();
		same(await decoration(), "underline 1", `${theme}: Open connectors under the pointer`);
		await page.mouse.down();
		same(await decoration(), "underline 0.7", `${theme}: Open connectors pressed`);
		await shoot(page, `1440-${theme}-12-open-pressed`);
		// Let go over the row's name, so the press opens nothing.
		await row(page, "ticket").locator(".room-skills-name").hover();
		await page.mouse.up();
		// A switch busy saving is disabled, at 45 %.
		let release = () => {};
		const held = new Promise<void>((resolve) => { release = resolve; });
		await page.route("**/api/persistent-agents/*/mcp-connectors", async (route) => { if (route.request().method() === "PUT") await held; await route.fallback(); });
		await switchOf(page, "board").click();
		await waitUntil(() => switchOf(page, "board").isDisabled(), `${theme}: the switch busy`);
		same(await switchOf(page, "board").evaluate((element) => getComputedStyle(element).opacity), "0.45", `${theme}: a busy switch disabled`);
		release();
		await waitUntil(async () => !(await switchOf(page, "board").isDisabled()), `${theme}: the switch free`);
		await closePage(page);
	}
	// Nothing sideways from 390 to 1440.
	for (const width of [390, 800, 1024, 1440]) {
		const page = await lookPages({ baseUrl, room: ROOM }).openPage(browser, width === 390 ? phone(LIGHT) : desktop(width, 900, LIGHT), "on");
		seedRooms();
		await openRoomConnectors(page);
		await nothingSideways(page, `${width}`);
		await closePage(page);
	}
	seedRooms();
	console.log("  ok  the scale's sizes and weights only, every word at 4.5:1 or more and every dot at 3:1 or more in both themes; Open connectors underlined under the pointer, dimmed pressed; a busy switch at 45 %; nothing sideways at 390, 800, 1024 and 1440");
}

/** Two frames on, so a scroll or a pointer's change is painted. */
const painted = (page: Page) => page.evaluate(() => new Promise<void>((done) => requestAnimationFrame(() => requestAnimationFrame(() => done()))));
/** Brings a connector's name to the pane's middle, in either build. */
async function toName(page: Page, name: string): Promise<void> {
	await section(page).getByText(name, { exact: true }).first().evaluate((element) => element.scrollIntoView({ block: "center" }));
	await painted(page);
}

/**
 * A picture of each scene the look is judged on, taken the same way from a page built from the base and from the
 * head, so they can sit side by side: every wait reads what both builds show. Where the base has no switch, its
 * own control on a row stands in: the first row's Remove. LOOK_INIT_SCRIPT names a script file the page runs
 * before its own, such as one that gives it the Mac app's look.
 */
async function checkPictures(browser: Browser): Promise<void> {
	if (!shots) return;
	const open = async (options: ReturnType<typeof desktop>) => {
		const page = await lookPages({ baseUrl, room: ROOM }).openPage(browser, options, "on");
		if (process.env.LOOK_INIT_SCRIPT) await page.context().addInitScript({ path: process.env.LOOK_INIT_SCRIPT });
		return page;
	};
	const scene = async (page: Page, name: string, setting: Scene = {}, room = ROOM) => {
		seedRooms();
		await openRoomConnectors(page, setting, room);
		await still(page, name);
	};
	const hasLook = async (page: Page) => (await section(page).getByRole("switch").count()) > 0;
	const pressedRow = async (page: Page) => ((await hasLook(page)) ? row(page, "board") : section(page).locator(".room-skills-rows > .room-skills-row").first());
	const control = async (page: Page) => (await pressedRow(page)).locator(".room-skills-row-actions").getByRole((await hasLook(page)) ? "switch" : "button");
	const letGo = async (page: Page) => { await section(page).locator(".pane-lead").hover(); await page.mouse.up(); };
	const toEnd = async (page: Page) => { await pane(page).evaluate((element) => { element.scrollTop = element.scrollHeight; }); await painted(page); };
	signIns.clear();
	for (const [where, options] of [["1440-light", desktop(1440, 900, LIGHT)], ["1440-dark", desktop(1440, 900, DARK)], ["390-light", phone(LIGHT)], ["390-dark", phone(DARK)]] as const) {
		const page = await open(options);
		// Every state, then the rest of the page and its end, where the old answers are.
		await scene(page, `${where}: every state`);
		await shoot(page, `${where}-01-every-state`);
		// Part way down, short of the end where 02 is taken.
		await pane(page).evaluate((element) => { element.scrollTop = Math.min(element.clientHeight - 120, (element.scrollHeight - element.clientHeight) / 2); });
		await painted(page);
		await shoot(page, `${where}-01b-every-state-rest`);
		await toEnd(page);
		await shoot(page, `${where}-02-every-state-end`);
		await scene(page, `${where}: none on`, {}, QUIET_ROOM);
		await shoot(page, `${where}-03-none-on`);
		await closePage(page);
	}
	for (const [where, options] of [["1440-light", desktop(1440, 900, LIGHT)], ["1440-dark", desktop(1440, 900, DARK)]] as const) {
		const page = await open(options);
		for (const [name, setting] of [["04-nothing-yet", { none: true }], ["05-failed-read", { failed: true }], ["06-archived", { archived: true }]] as Array<[string, Scene]>) {
			await scene(page, `${where}: ${name}`, setting);
			await shoot(page, `${where}-${name}`);
		}
		// A refused save: the base's own control pressed where it has no switch.
		await scene(page, `${where}: a refused save`, { refuse: true });
		await (await control(page)).click();
		await section(page).locator("> .checkpoint-proposal-error, .checkpoint-proposal-error").first().waitFor();
		await page.mouse.move(5, 5);
		await still(page, `${where}: a refused save`);
		await shoot(page, `${where}-07-refused-save`);
		// The one removed, then a name rooms can't take: on the base, in its picker.
		await scene(page, `${where}: the one removed`);
		await toName(page, C.gone.name);
		await shoot(page, `${where}-08-removed`);
		if (!(await hasLook(page))) {
			await section(page).getByRole("button", { name: "Enable connectors", exact: true }).click();
			await section(page).locator(".room-skills-picker").waitFor();
		}
		await toName(page, C.bad.name);
		await shoot(page, `${where}-09-name-rooms-cant-take`);
		// A switch (on the base, Remove) under the pointer, pressed, and focused from the keyboard.
		await scene(page, `${where}: a switch`);
		const pressed = await control(page);
		await pressed.evaluate((element) => element.scrollIntoView({ block: "center" }));
		await pressed.hover();
		await painted(page);
		await shoot(page, `${where}-10-switch-hover`);
		await page.mouse.down();
		await painted(page);
		await shoot(page, `${where}-11-switch-pressed`);
		// Let go over the page's lead, so the press changes nothing and the window stays.
		await letGo(page);
		await pressed.evaluate((element) => (element as HTMLElement).blur());
		await (await pressedRow(page)).locator(".room-skills-name").click();
		await page.keyboard.press("Tab");
		await page.mouse.move(5, 5);
		await painted(page);
		await shoot(page, `${where}-12-switch-focus`);
		// "Open connectors" on a row: the base has none on this page.
		if (await hasLook(page)) {
			const way = row(page, "ticket").locator(".room-connector-open");
			// No focus ring left from the switch's scene.
			await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
			await way.hover();
			await painted(page);
			await shoot(page, `${where}-13-open-hover`);
			await page.mouse.down();
			await painted(page);
			await shoot(page, `${where}-14-open-pressed`);
			await letGo(page);
			await row(page, "ticket").locator(".room-skills-name").click();
			await page.keyboard.press("Tab");
			await painted(page);
			await shoot(page, `${where}-15-open-focus`);
		}
		await closePage(page);
	}
	// Over remote access at 390, then a press refused.
	let page = await open(phone(LIGHT));
	await scene(page, "remote access", { remote: true });
	await shoot(page, "390-light-16-remote");
	const pressedRemote = await control(page);
	if (await pressedRemote.count()) {
		await pressedRemote.click();
		await section(page).locator(".checkpoint-proposal-error").first().waitFor();
		await still(page, "remote access: refused");
		await toEnd(page);
		await pane(page).evaluate((element) => { element.scrollTop = 0; });
		await painted(page);
		await shoot(page, "390-light-17-remote-refused");
	}
	await closePage(page);
	// A shared server.
	page = await open(desktop(1440, 900, LIGHT));
	await scene(page, "a shared server", { shared: true });
	await shoot(page, "1440-light-18-shared-server");
	await closePage(page);
	seedRooms();
}

let model: http.Server | undefined;
let server: ChildProcessWithoutNullStreams | null = null;
try {
	const agents = await import("../src/persistent-agents.js");
	for (const name of [ROOM, QUIET_ROOM, GONE_ROOM, LOCKING_ROOM]) roomIds[name] = agents.createPersistentAgentFromScaffoldInput({ displayName: name, userName: "Synthetic User", preferredUserAddress: "Synthetic User" }).agent.agentId;
	// A program whose file lies in that room's own folder: the room could change it, so it can't start.
	const box = path.join(agentsRoot, roomIds[LOCKING_ROOM], "runtime", "box");
	fs.mkdirSync(box, { recursive: true });
	fs.writeFileSync(path.join(box, "notes-tool"), "#!/bin/sh\nexit 1\n", { mode: 0o755 }); // portability-ok: never run, the room's folder holding it is what refuses its start
	fs.writeFileSync(path.join(agentDir, "mcp.json"), JSON.stringify({ mcpServers: {
		[C.wiki.id]: { displayName: C.wiki.name, url: at("/wiki/mcp") },
		[C.empty.id]: { displayName: C.empty.name, url: at("/empty/mcp") },
		[C.ticket.id]: { displayName: C.ticket.name, url: NOWHERE },
		[C.chat.id]: { displayName: C.chat.name, url: at("/chat/mcp") },
		[C.node.id]: { displayName: C.node.name, command: "npx", args: ["-y", "never-downloaded-connector"] },
		[C.board.id]: { displayName: C.board.name, url: at("/board/mcp") },
		[C.slow.id]: { displayName: C.slow.name, url: NOWHERE },
		[C.calendar.id]: { displayName: C.calendar.name, url: at("/calendar/mcp") },
		[C.office.id]: { displayName: C.office.name, command: "never-started-connector", args: ["--stdio"] },
		[C.locked.id]: { displayName: C.locked.name, command: path.join(box, "notes-tool") },
		[C.bad.id]: { displayName: C.bad.name, command: "never-started-connector", args: ["--files"] },
	} }));
	seedChecks();
	const now = Date.now();
	authStore.updateTokens(C.chat.id, { accessToken: "synthetic-expired", expiresAt: Math.floor(now / 1000) - 3600 }, at("/chat/mcp"));

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
	const put = async (route: string, body: unknown, method = "PUT") => {
		const answerOf = await authedFetch(`${baseUrl}${route}`, { method, headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
		assert(answerOf.ok, `${method} ${route}: ${answerOf.status} ${await answerOf.text()}`);
	};
	await put("/api/auth/api-key", { provider: "synthetic", key: "synthetic-test-key" }, "POST");
	// The tools of the connectors that answer, kept as a check keeps them.
	for (const key of ["wiki", "board", "empty"] as const) await put(`/api/mcp/servers/${C[key].id}/test`, {}, "POST");
	// The packed room had one on before it was archived.
	await put(`/api/persistent-agents/${roomIds[GONE_ROOM]}/mcp-connectors`, { action: "grant", name: C.wiki.id });
	await put(`/api/persistent-agents/${roomIds[GONE_ROOM]}/archive`, { confirmation: `DELETE ${roomIds[GONE_ROOM]}` }, "POST");
	const browser = await chromium.launch({ ignoreDefaultArgs: ["--hide-scrollbars"] });
	try {
		const failed: string[] = [];
		const only = process.env.LOOK_ROWS?.split(",");
		for (const check of [checkRulesUnderSwitch, checkOff, checkRoomConnectors, checkStates, checkOldAnswers, checkEmptyAndFailed, checkReadOnly, checkShared, checkPictures]) {
			if (only && !only.includes(check.name)) continue;
			try {
				await check(browser);
			} catch (error) {
				failed.push(`${check.name}: ${(error as Error).message.split("\n").filter((line, i) => i === 0 || /waiting for/.test(line)).slice(0, 2).join(" ").replace(/\u001b\[\d+m/g, "")}`);
				console.log(`  FAIL ${failed.at(-1)}`);
				for (const context of browser.contexts()) { if (shots) for (const open of context.pages()) await open.screenshot({ path: path.join(shots, `fail-${check.name}.png`) }).catch(() => {}); await context.close(); }
			}
		}
		assert(failed.length === 0, `${failed.length} rows failed:\n${failed.join("\n")}`);
	} finally {
		await browser.close();
	}
	console.log("settings look room connectors ui smoke passed");
} finally {
	await stopSmokeServer(server);
	model?.close();
	standIns.close();
	fs.rmSync(tempRoot, { recursive: true, force: true });
}
