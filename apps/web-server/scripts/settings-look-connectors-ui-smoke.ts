// The settings windows' new look on Settings, Connectors
// (50-settings-look-connectors.css). With the switch off, the page renders as
// before: its markup and every element's computed style, read in every row
// state, a failed list, no connectors, the Directory with a key row open and a
// search with no match, and the line after an add. With the switch on, a
// room's Connectors, a connector's own page, an add form and a shared server's
// Connectors read as before too. Every rule of the page file sits under the
// switch's class. With the switch on, in both themes: Add connector the one
// ink button with its caret and its menu; rows 64 tall with their columns at
// one x in every state, a broken row's reason in its status's place and the
// button outside the row's open target; the foot while a connector signs in
// or a program gets ready; the Directory with its search on its title's line
// and its Add for each kind; the empty and the failed list; and over remote
// access a list with no way to change it. At 390: three lines a row, the
// search on its own line and nothing sideways.
//
// The world is real: a server on a scratch home, connectors in its own file,
// their last checks kept as the server keeps them, a stand-in connector on
// this computer that answers with its tools, and a room whose own folder
// holds a program's file. Nothing signs in anywhere and nothing is
// downloaded: the sign-in routes and the checks the page asks for are
// answered in the page, as connector-page-ui-smoke.ts answers them. Set
// LOOK_OFF_READING to a file to keep the switch-off reading for comparing two
// builds; LOOK_ROWS to run some rows; LOOK_SHOTS to a folder for a picture of
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
		console.log("settings look connectors ui smoke skipped (Chromium not installed)");
		process.exit(0);
	}
}

const waitUntil = waitEvery(100);
const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const webServerDir = path.resolve(scriptDir, "..");
const repoRoot = path.resolve(webServerDir, "..", "..");
const stylesDir = path.join(repoRoot, "apps", "web-ui", "src", "styles");
const PAGE_FILE = "50-settings-look-connectors.css";
const port = await freePort();
const baseUrl = `http://127.0.0.1:${port}`;

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "exxperts-settings-look-connectors-"));
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
const authStore = await import("pi-mcp-adapter/mcp-auth.ts" as string);

const ROOM = "Look Room";
/** A room whose own folder holds a program's file, so that program can't start; its name runs long, as the reason names it. */
const LOCKING_ROOM = "Board papers and the monthly reporting for the finance team";
const look = lookPages({ baseUrl, room: ROOM });
const { openPage, openWindow } = look;

// --- The stand-in connectors on this computer --------------------------------------

const TOOLS: Record<string, string[]> = { "/wiki/mcp": ["search_pages", "get_page", "create_page", "move_page"], "/board/mcp": ["list_papers", "file_paper"] };
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

/** Each connector: its fixed name, the name a person reads, and what the row then says. */
const C = {
	wiki: { id: "team-wiki", name: "Team wiki" },
	board: { id: "board-files", name: "Board files" },
	ticket: { id: "ticket-desk", name: "Ticket desk" },
	slow: { id: "slow-desk", name: "Slow desk" },
	calendar: { id: "shared-calendar", name: "Shared calendar" },
	chat: { id: "team-chat", name: "Team chat" },
	tracker: { id: "project-tracker", name: "Project tracker" },
	notes: { id: "notes-desk", name: "Notes desk" },
	/** A program that downloads at its first start: a check held past a few seconds gets it ready. */
	office: { id: "office-files", name: "Office files" },
	node: { id: "node-tools", name: "Node tools" },
	locked: { id: "room-notes", name: "Room notes" },
	long: { id: "long-name", name: "Quarterly board papers, monthly reporting and the yearly plan" },
	/** A program brought in from another app: the longest tag beside the widest button. */
	imported: { id: "desktop-files", name: "Desktop files" },
} as const;
type Key = keyof typeof C;
const EVERY_STATE: Key[] = ["wiki", "board", "ticket", "slow", "calendar", "chat", "tracker", "notes", "office", "node", "locked", "long"];
const ALL_CONNECTED: Key[] = ["wiki", "board"];

// --- The page's own requests, answered here ---------------------------------------------

type Scene = {
	/** The connectors the list shows, by key; "failed" when the list can't be read. */
	list?: Key[] | "failed";
	/** Over remote access, read-only. */
	remote?: boolean;
	/** A shared server's short page. */
	shared?: boolean;
};
/** What the page asked of the routes answered here, in order. */
const asked: string[] = [];
/** Each connector's sign-in, as the browser left it: waiting, or failed because its service was busy. */
const signIns = new Map<string, "pending" | "then-busy" | "busy">();
/** A check held until its promise settles: checking, or a program getting ready. */
const heldChecks = new Map<string, { until: Promise<void>; answer: unknown }>();
/** The checks of the connectors nothing answers on this computer, as the server kept them. */
const CHECK_ANSWERS: Record<string, unknown> = {
	[C.ticket.id]: { ok: false, httpStatus: 404, error: "HTTP 404" },
	[C.slow.id]: { ok: false, error: "fetch failed" },
	// The directory's own addresses are on the internet: answered as an open one answers.
	context7: { ok: true, toolCount: 0, toolNames: [] },
	notion: { ok: true, toolCount: 0, toolNames: [] },
	github: { ok: true, toolCount: 0, toolNames: [] },
};
const nameOf = (route: Route) => decodeURIComponent(new URL(route.request().url()).pathname.split("/").at(-2)!);

async function answer(page: Page, scene: Scene): Promise<void> {
	await page.unrouteAll({ behavior: "ignoreErrors" });
	if (scene.remote || scene.shared) await page.route("**/api/remote/client-context", (route) => route.fulfill({ json: scene.shared ? { remote: false, sharedServer: true } : { remote: true, capability: "read-only" } }));
	await page.route("**/api/mcp/status", async (route) => {
		if (scene.list === "failed") return route.fulfill({ status: 500, contentType: "text/plain", body: "stand-in: the list can't be read" });
		const response = await route.fetch();
		const status = await response.json();
		const shown = scene.list ?? EVERY_STATE;
		// A connector added from the Directory here shows too.
		const ids = new Set([...shown.map((key) => C[key].id as string), "context7", "notion", "github"]);
		// The program from another app reads as the server shows one it read from that app's own file; Office files as it
		// marks a program started by uvx and the like.
		const servers = status.servers.filter((server: { name: string }) => ids.has(server.name)).map((server: { name: string; source?: object }) => (server.name === C.imported.id ? { ...server, source: { ...server.source, importKind: "claude-desktop", importFile: "/Users/synthetic/Library/Application Support/Claude/claude_desktop_config.json" } } : server.name === C.office.id ? { ...server, downloadsAtFirstStart: true } : server));
		return route.fulfill({ response, json: { ...status, servers } });
	});
	await page.route("**/api/mcp/servers/*/login", async (route) => {
		const request = route.request();
		const name = nameOf(route);
		asked.push(`${request.method()} login ${name}`);
		if (request.method() === "POST") {
			signIns.set(name, "pending");
			return route.fulfill({ json: { started: true } });
		}
		if (request.method() === "DELETE") {
			const was = signIns.has(name);
			signIns.delete(name);
			return route.fulfill({ json: { cancelled: was } });
		}
		const now = signIns.get(name);
		// The first read finds it waiting; the next, that the service was busy.
		if (now === "then-busy") signIns.set(name, "busy");
		return route.fulfill({ json: now === "pending" || now === "then-busy" ? { pending: true } : now === "busy" ? { pending: false, cause: "busy", detail: "stand-in: the service was busy" } : { pending: false } });
	});
	await page.route("**/api/mcp/servers/*/test", async (route) => {
		const name = nameOf(route);
		asked.push(`test ${name}`);
		const held = heldChecks.get(name);
		if (held) {
			await held.until;
			return route.fulfill({ json: held.answer }).catch(() => undefined);
		}
		if (CHECK_ANSWERS[name]) return route.fulfill({ json: CHECK_ANSWERS[name] });
		return route.fallback();
	});
}

const visible = (page: Page, selector: string) => page.locator(selector).filter({ visible: true }).first();
const row = (page: Page, key: Key) => page.locator(".connector-list .connector-item").filter({ has: page.locator(".connector-item-name-text", { hasText: new RegExp(`^${C[key].name}$`) }) });
const lineOfRow = (page: Page, key: Key) => row(page, key).locator(".connector-item-status");

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
	const pane = visible(page, ".settings-dialog-pane");
	await pane.locator(scene.shared ? "section[aria-label='Connectors']" : scene.list === "failed" ? ".connector-load-error" : ".connector-list-section").first().waitFor({ timeout: 15000 });
	await answered(page, "Settings Connectors");
	await page.mouse.move(5, 5);
	return pane;
}

/** A row's status line in the new look, which ends with how many rooms have it on: "Connected · 4 tools · on in 2 rooms". */
const inLine = (status: string, rooms: number) => `${status.replace(/\.$/, "")} · ${WORDS.roomsInLine(rooms)}`;
/** The line reads as the status wanted: alone (the old look, or a row whose rooms aren't known), or ending with its rooms
 * (the new look; which count is the list's own rows' check). */
const readsAs = (line: string | null, status: string) => line === status || [0, 1, 2, 3].some((rooms) => line === inLine(status, rooms));

/** Waits until each row's second line reads as given. */
async function rowsRead(page: Page, want: Partial<Record<Key, string>>, what: string): Promise<void> {
	let last: Record<string, string | null> = {};
	await waitUntil(async () => {
		last = Object.fromEntries(await Promise.all(Object.keys(want).map(async (key) => [key, await lineOfRow(page, key as Key).textContent({ timeout: 2000 }).catch(() => null)])));
		return Object.entries(want).every(([key, text]) => readsAs(last[key], text!));
	}, what, 20000).catch((error) => { throw new Error(`${(error as Error).message}: ${JSON.stringify(last)}`); });
}

/** A held check: the answer waits until `release` is called. */
function holdCheck(name: string, answer: unknown): () => void {
	let release = () => {};
	heldChecks.set(name, { until: new Promise<void>((resolve) => { release = resolve; }), answer });
	return () => { heldChecks.delete(name); release(); };
}

// --- Measuring ------------------------------------------------------------------------------

type Box = { left: number; right: number; top: number; bottom: number; width: number; height: number };
const boxOf = (target: Locator): Promise<Box> => target.evaluate((element) => { const { left, right, top, bottom, width, height } = element.getBoundingClientRect(); return { left, right, top, bottom, width, height }; });
const near = (a: number, b: number, what: string, within = 0.5) => assert(Math.abs(a - b) <= within, `${what}: ${a.toFixed(1)} against ${b.toFixed(1)}`);
const middle = (box: Box) => box.top + box.height / 2;
const chroma = (hex: string) => { const rgb = [1, 3, 5].map((at) => parseInt(hex.slice(at, at + 2), 16)); return Math.max(...rgb) - Math.min(...rgb); };

/** Waits until nothing that ends is still moving: a changed line's fade, a press's spinner aside. */
const still = (page: Page, what: string) => waitUntil(() => page.evaluate(() => document.getAnimations().every((one) => one.playState !== "running" || one.effect?.getComputedTiming().iterations === Infinity)), `${what}: nothing moving`);
/** Waits until the pane has stopped scrolling. */
async function scrolled(page: Page, what: string): Promise<void> {
	let last = -1;
	let same = 0;
	await waitUntil(async () => {
		const top = await page.evaluate(() => [...document.querySelectorAll(".settings-dialog-pane")].find((one) => one.getClientRects().length)!.scrollTop);
		same = top === last ? same + 1 : 0;
		last = top;
		return same >= 3;
	}, `${what}: the pane stops scrolling`);
}

/** The colours of the theme's tokens, as a person sees them on the open page. */
const tokens = (page: Page) => page.evaluate(() => {
	const w = window as any;
	const dialog = document.querySelector(".settings-dialog")!;
	const read = (name: string) => w.__seen(dialog, getComputedStyle(dialog).getPropertyValue(name).trim());
	return { text: read("--fg"), soft: read("--fg-soft"), muted: read("--muted"), ok: read("--exx-success"), warn: read("--exx-warning"), danger: read("--error"), grey: read("--exx-icon-quiet"), focus: read("--exx-focus") };
});

/** The ink-filled buttons and links on the open page, as a person sees them. */
const INK = { [LIGHT]: "#111111", [DARK]: "#f4f1ec" };
async function inkedOn(page: Page, theme: Theme): Promise<string[]> {
	return page.evaluate((ink) => {
		const w = window as any;
		const pane = [...document.querySelectorAll(".settings-dialog-pane")].find((element) => element.getClientRects().length)!;
		return [...pane.querySelectorAll("button, a.rs-btn")].filter((element) => element.getClientRects().length > 0 && w.__painted(getComputedStyle(element).backgroundColor) && w.__seen(element, getComputedStyle(element).backgroundColor) === ink).map((element) => element.textContent!.trim());
	}, INK[theme]);
}

/** Nothing sideways: neither the page nor the open pane scrolls across. */
async function nothingSideways(page: Page, what: string): Promise<void> {
	const wide = await page.evaluate(() => {
		const pane = [...document.querySelectorAll(".settings-dialog-pane")].find((one) => one.getClientRects().length)!;
		return [document.documentElement.scrollWidth - window.innerWidth, pane.scrollWidth - pane.clientWidth];
	});
	same(wide.map((extra) => Math.max(0, extra)), [0, 0], `${what}: sideways scrolling (page, pane)`);
}

const pane = (page: Page) => visible(page, ".settings-dialog-pane");
const footOf = (page: Page) => visible(page, ".connector-waiting-foot");
const buttonOf = (page: Page, key: Key) => row(page, key).locator(".connector-item-side button, .connector-item-side a");

/** Each row's second line with the switch on, every state but a press's. */
const LINES: Record<Key, string> = {
	wiki: `${WORDS.status.connected} · ${WORDS.toolCount(4)}`,
	board: `${WORDS.status.connected} · ${WORDS.toolCount(2)}`,
	ticket: WORDS.wentWrong.addressNotFound.fact,
	slow: WORDS.wentWrong.noAnswer.fact,
	calendar: WORDS.status.notConnected,
	chat: WORDS.status.needsReconnecting,
	tracker: WORDS.status.signingIn,
	notes: WORDS.wentWrong.busy.fact,
	office: WORDS.status.program,
	node: WORDS.wentWrong.nodeMissing.fact,
	locked: WORDS.wentWrong.cantStart(LOCKING_ROOM).fact,
	long: `${WORDS.status.connected} · ${WORDS.toolCount(4)}`,
	imported: WORDS.status.program,
};
/** Opens the list with every state and one signing in, and waits until each row has settled. */
async function openEveryState(page: Page, scene: Scene = {}): Promise<Locator> {
	signIns.clear();
	signIns.set(C.tracker.id, "pending");
	signIns.set(C.notes.id, "then-busy");
	const opened = await openConnectors(page, scene);
	if (scene.remote) return opened;
	const shown = Array.isArray(scene.list) ? scene.list : EVERY_STATE;
	await rowsRead(page, Object.fromEntries(shown.map((key) => [key, LINES[key]])), "every state");
	await answered(page, "every state");
	await still(page, "every state");
	return opened;
}

/** Adds the Directory's entries back out: what a row added from it stays in the connectors' file. */
async function removeDirectoryAdds(): Promise<void> {
	for (const name of ["context7", "notion", "github"]) {
		const removed = await authedFetch(`${baseUrl}/api/mcp/servers/${name}`, { method: "DELETE" });
		assert(removed.ok || removed.status === 404, `removing ${name}: ${removed.status}`);
		signIns.delete(name);
	}
}

// --- The page file ------------------------------------------------------------------------

async function checkRulesUnderSwitch(browser: Browser): Promise<void> {
	const page = await openPage(browser, desktop(1280), "off");
	const roots = [SWITCH_CLASS];
	const css = fs.readFileSync(path.join(stylesDir, PAGE_FILE), "utf8");
	same(await rulesOutsideRoots(page, css, roots), [], `rules in ${PAGE_FILE} outside ${SWITCH_CLASS}`);
	// The check finds a rule outside, in a media query too, and a longer class name is not the root.
	same(await rulesOutsideRoots(page, `.connector-list .connector-item { color: red; } ${SWITCH_CLASS}-x .a { color: red; } .settings-dialog .connector-waiting-foot { color: red; } @media (max-width: 760px) { ${SWITCH_CLASS} .a, .connector-dir-row { color: red; } }`, roots), [".connector-list .connector-item", `${SWITCH_CLASS}-x .a`, ".settings-dialog .connector-waiting-foot", ".connector-dir-row"], "the check's own probe");
	const imports = [...fs.readFileSync(path.join(repoRoot, "apps", "web-ui", "src", "styles.css"), "utf8").matchAll(/@import "\.\/styles\/([^"]+)";/g)].map((match) => match[1]);
	same(notLookPageFilesAfterLook(imports), [], `the style files after ${LOOK_FILE} that are not the look's page files`);
	assert(imports.indexOf(PAGE_FILE) > imports.indexOf(LOOK_FILE), `${PAGE_FILE} loads after ${LOOK_FILE}`);
	const loaded = await page.evaluate(() => [...document.styleSheets].some((sheet) => [...sheet.cssRules].some((rule) => rule instanceof CSSStyleRule && rule.selectorText.includes(".connector-waiting-foot"))));
	assert(loaded, "the page's stylesheet carries the page file's rules");
	await page.context().close();
	console.log(`  ok  every rule of ${PAGE_FILE} sits under ${SWITCH_CLASS}, and it loads after ${LOOK_FILE}`);
}

// --- What stays as it was ------------------------------------------------------------------

/** An element's markup, with React's generated ids blanked and a changed line's fade left out, and every element's
 * computed style by property name; this run's folder and ports blanked, so two runs read alike. */
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

/** Waits until the rows have settled in words both builds share: one still signing in, the other's sign-in
 * ended, the connected rows checked. The base reads with the switch on too, and knows no look line. */
async function settledOnBoth(page: Page, what: string): Promise<void> {
	await waitUntil(async () => {
		const read = async (key: Key) => (await lineOfRow(page, key).textContent({ timeout: 2000 }).catch(() => null)) ?? "";
		return readsAs(await read("tracker"), WORDS.status.signingIn) && !readsAs(await read("notes"), WORDS.status.signingIn) && await read("notes") !== "" && (await Promise.all((["wiki", "board", "long"] as const).map(read))).every((line) => line.startsWith(WORDS.status.connected));
	}, `${what}: the rows settle`, 20000);
	await answered(page, what);
	await still(page, what);
}

async function checkOff(browser: Browser): Promise<void> {
	const reading: Record<string, unknown> = {};
	for (const [where, options] of [["1440 light", desktop(1440, 900, LIGHT)], ["390 light", phone(LIGHT)]] as const) {
		const page = await openPage(browser, options, "off");
		// Every state, one signing in.
		signIns.clear();
		signIns.set(C.tracker.id, "pending");
		signIns.set(C.notes.id, "then-busy");
		let opened = await openConnectors(page);
		await settledOnBoth(page, `${where}, switch off`);
		same(await page.locator(".settings-look-next").count(), 0, `${where}, switch off: elements with the look's class`);
		same(await page.locator(".connector-waiting-foot").count(), 0, `${where}, switch off: a foot`);
		same([await row(page, "tracker").locator(".connector-item-note").textContent(), await buttonOf(page, "tracker").textContent()], [WORDS.signingInNote, WORDS.button.cancel], `${where}, switch off: today's row signing in`);
		reading[`${where}, every state`] = await readAsItIs(opened);
		// The Directory with a key row open, then a search with no match.
		await opened.getByRole("button", { name: WORDS.directoryAdd({ name: "GitHub", kind: "token" }), exact: true }).click();
		await opened.locator(".connector-dir-token-row").waitFor();
		await still(page, `${where}, switch off, a key row`);
		reading[`${where}, a key row`] = await readAsItIs(opened);
		await opened.locator(".connector-dir-search").fill("no such connector anywhere");
		await opened.getByText(WORDS.directoryNoMatch).waitFor();
		await page.mouse.move(5, 5);
		reading[`${where}, no match`] = await readAsItIs(opened);
		await closeWindow(page);
		// The line after an add.
		opened = await openConnectors(page);
		await opened.getByRole("button", { name: WORDS.directoryAdd({ name: "Context7", kind: "open" }), exact: true }).click();
		await opened.locator(".connector-notice").waitFor({ timeout: 15000 });
		await rowsRead(page, { wiki: WORDS.status.connected }, `${where}, switch off, after an add`);
		await answered(page, `${where}, switch off, after an add`);
		await page.mouse.move(5, 5);
		await still(page, `${where}, switch off, after an add`);
		reading[`${where}, after an add`] = await readAsItIs(opened);
		await removeDirectoryAdds();
		await closeWindow(page);
		// A failed list, and none.
		for (const [name, list] of [["a failed list", "failed"], ["no connectors", []]] as Array<[string, Scene["list"]]>) {
			opened = await openConnectors(page, { list });
			await answered(page, `${where}, switch off, ${name}`);
			reading[`${where}, ${name}`] = await readAsItIs(opened);
			await closeWindow(page);
		}
		await page.context().close();

		// With the switch on, the pages this one shares its parts with.
		const on = await openPage(browser, options, "on");
		signIns.clear();
		signIns.set(C.tracker.id, "pending");
		signIns.set(C.notes.id, "then-busy");
		opened = await openConnectors(on);
		await settledOnBoth(on, `${where}, switch on`);
		// On its start: at 390 its button sits on the row's middle.
		await row(on, "ticket").locator(".connector-item-hit").click({ position: { x: 32, y: 32 } });
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
		await openWindow(on, "room");
		await goToPage(on, "Connectors");
		await pane(on).locator(".room-skills-row, .room-connectors-section .settings-empty").first().waitFor({ timeout: 15000 });
		await answered(on, `${where}, a room's Connectors`);
		await on.mouse.move(5, 5);
		await still(on, `${where}, a room's Connectors`);
		reading[`${where}, switch on, a room's Connectors`] = await readAsItIs(pane(on));
		await closeWindow(on);
		opened = await openConnectors(on, { shared: true });
		reading[`${where}, switch on, a shared server`] = await readAsItIs(opened);
		await on.context().close();
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
	console.log(`  ok  switch off at 1440 and 390: no look class, no foot, today's row signing in; ${Object.keys(reading).length} readings${process.env.LOOK_OFF_BASE ? " equal to the base's" : ""}${process.env.LOOK_OFF_READING ? ` (kept in ${process.env.LOOK_OFF_READING})` : ""}`);
}

// --- With the switch on ------------------------------------------------------------------------

async function checkConnectorsHeader(browser: Browser): Promise<void> {
	for (const theme of [LIGHT, DARK] as const) {
		const at = `1440 ${theme}`;
		const page = await openPage(browser, desktop(1440, 900, theme), "on");
		const opened = await openConnectors(page, { list: ALL_CONNECTED });
		const add = opened.locator(".connector-add-btn");
		same(await inkedOn(page, theme), [], `${at}: the ink buttons`);
		const caret = add.locator(".connector-add-caret");
		same([await caret.getAttribute("aria-hidden"), (await boxOf(caret.locator("svg"))).width, await add.getAttribute("aria-label") ?? (await add.innerText()).trim()], ["true", 12, WORDS.addConnector], `${at}: the caret, hidden from a screen reader, and the button's name`);
		const [addBox, actions, head] = [await boxOf(add), await boxOf(opened.locator(".pane-head > .pane-head-actions")), await boxOf(opened.locator(".pane-head"))];
		near(addBox.right, actions.right, `${at}: Add connector ends the header's actions`);
		assert(addBox.top >= head.top && addBox.bottom <= head.bottom, `${at}: Add connector in the header`);
		await add.click();
		const menu = page.locator(".ai-profile-menu");
		await menu.waitFor();
		const menuBox = await boxOf(menu);
		near(menuBox.top - addBox.bottom, 6, `${at}: the menu 6 under Add connector`);
		near(menuBox.right, addBox.right, `${at}: the menu's right edge on Add connector's`);
		same(await menu.locator("[role=menuitem]").allInnerTexts(), [WORDS.addWays.directory, WORDS.addWays.web, WORDS.addWays.program], `${at}: the menu's three ways`);
		same(await menu.locator("[role=menuitem]").evaluateAll((items) => items.map((item) => item.getBoundingClientRect().height)), [32, 32, 32], `${at}: the ways 32 tall`);
		await page.keyboard.press("Escape");
		await menu.waitFor({ state: "detached" });
		assert(await add.evaluate((button) => button === document.activeElement), `${at}: Escape gives the focus back to Add connector`);
		assert(await page.locator(".settings-overlay").isVisible(), `${at}: Escape closed only the menu`);
		await add.press("Enter");
		await menu.waitFor();
		await page.getByRole("menuitem", { name: WORDS.addWays.directory }).click();
		await scrolled(page, at);
		const [title, headNow, paneBox] = [await boxOf(opened.locator(".connector-directory > .group-head .settings-group-kicker")), await boxOf(opened.locator(".pane-head")), await boxOf(opened)];
		assert(title.top >= headNow.bottom - 0.5 && title.bottom <= paneBox.bottom, `${at}: the Directory's title wholly under the header (${title.top}..${title.bottom} against ${headNow.bottom})`);
		assert(await opened.locator(".connector-dir-search").evaluate((input) => input === document.activeElement), `${at}: the focus in the Directory's search`);
		await page.context().close();
	}
	const page = await openPage(browser, phone(LIGHT), "on");
	const opened = await openConnectors(page, { list: ALL_CONNECTED });
	const [add, list, first] = [await boxOf(opened.locator(".connector-add-btn")), await boxOf(opened.locator(".connector-list")), await boxOf(page.locator(".connector-list > .connector-item").first())];
	same([Math.round(add.left), add.right < list.right, add.height], [Math.round(list.left), true, 44], "390: Add connector from the column's left edge at its words' width, 44 tall");
	assert(first.top <= 240, `390: the first row starts at ${first.top} px`);
	await page.context().close();
	console.log("  ok  Add connector with its hidden caret, no ink on the page, ending the header's actions; its menu 6 under it, right edges on one x, three ways 32 tall in order; Escape closes only the menu and gives the focus back; From the directory leaves the Directory's title under the header and the focus in its search; at 390 across the column and 44 tall, the first row at 240 or higher; both themes");
}

/** Each row of the list measured: its height, its columns' x, its button, and line 2. */
const measureRows = (page: Page) => page.locator(".connector-list > .connector-item").evaluateAll((rows) => rows.map((element) => {
	const box = (selector: string) => { const found = element.querySelector(selector); if (!found) return null; const { left, right, top, bottom, width, height } = found.getBoundingClientRect(); return { left, right, top, bottom, width, height }; };
	const button = element.querySelector<HTMLElement>(".connector-item-side button, .connector-item-side a");
	const status = element.querySelector<HTMLElement>(".connector-item-status")!;
	const nameText = element.querySelector<HTMLElement>(".connector-item-name-text")!;
	const tag = element.querySelector<HTMLElement>(".connector-dir-kind");
	return {
		name: nameText.textContent!,
		row: box(".connector-item-row")!,
		tile: box(".connector-avatar")!,
		nameLine: box(".connector-item-name")!,
		text: box(".connector-item-text"),
		state: box(".connector-item-state")!,
		chevron: box(".disclosure-chevron"),
		button: button ? { ...button.getBoundingClientRect().toJSON(), words: button.innerText.trim(), inHit: !!button.closest(".connector-item-hit") } : null,
		line: { text: status.textContent!, cut: status.scrollWidth > status.clientWidth, tip: status.closest(".connector-item-state")!.getAttribute("title") },
		nameCut: nameText.scrollWidth > nameText.clientWidth,
		nameShown: nameText.getBoundingClientRect().width,
		nameTextRight: nameText.getBoundingClientRect().right,
		tag: tag ? { whole: tag.scrollWidth <= tag.clientWidth, tip: tag.getAttribute("title"), text: tag.textContent, right: tag.getBoundingClientRect().right, bottom: tag.getBoundingClientRect().bottom, nameRight: element.querySelector(".connector-item-name")!.getBoundingClientRect().right } : null,
	};
}));

/** A row's fill as seen, and the token's colour over the same card: a fill is a mix over what is behind it. */
const fillAndToken = (hit: Locator, token: string) => hit.evaluate((element, name) => {
	const w = window as any;
	const value = getComputedStyle(document.querySelector(".settings-dialog")!).getPropertyValue(name).trim();
	return [w.__seen(element.parentElement!, getComputedStyle(element).backgroundColor), w.__seen(element.parentElement!, value)] as [string, string];
}, token);

/** On every row the tag ends before the button and some of the name shows; a tag cut short has its words in its tip. */
function clearOfButtons(rows: Awaited<ReturnType<typeof measureRows>>, at: string): void {
	const imported = rows.find((one) => one.name === C.imported.name);
	same([imported?.tag?.text, imported?.button?.words], [WORDS.tagImported("Claude Desktop"), WORDS.button.checkConnection], `${at}: the program from another app, its tag and its button`);
	same(rows.filter((one) => one.button && one.tag && one.tag.right > one.button.left + 0.5 && one.button.top < one.tag.bottom).map((one) => one.name), [], `${at}: a tag under a row's button`);
	same(rows.filter((one) => one.nameShown < 14).map((one) => `${one.name} ${one.nameShown}`), [], `${at}: a name with none of it showing`);
	same(rows.filter((one) => one.tag && !one.tag.whole && one.tag.tip !== one.tag.text).map((one) => one.name), [], `${at}: a cut tag without its words in its tip`);
	// Only a tag too long for any name beside it gives way: a short one stays whole while the name is cut.
	same(rows.filter((one) => one.name !== C.imported.name && one.tag && !one.tag.whole).map((one) => one.name), [], `${at}: a short tag cut`);
}

async function checkConnectorRows(browser: Browser): Promise<void> {
	for (const theme of [LIGHT, DARK] as const) {
		const at = `1440 ${theme}`;
		const page = await openPage(browser, desktop(1440, 900, theme), "on");
		await openEveryState(page, { list: [...EVERY_STATE, "imported"] });
		const rows = await measureRows(page);
		clearOfButtons(rows, at);
		same(rows.map((one) => one.row.height), rows.map(() => 64), `${at}: every row 64 tall`);
		// One row pattern (44): the name over one status line at the left; at the right edge one action, a button while the
		// row needs one, else the chevron, both ending at one x down the list.
		const action = (one: typeof rows[0]) => one.button ?? one.chevron!;
		for (const [column, of] of [["tile", (one: typeof rows[0]) => one.tile.left], ["name", (one: typeof rows[0]) => one.nameLine.left], ["line 2", (one: typeof rows[0]) => one.state.left], ["right edge", (one: typeof rows[0]) => action(one).right]] as const) {
			same([...new Set(rows.map(of).map((x) => Math.round(x * 2) / 2))].length, 1, `${at}: the ${column} column at one x`);
		}
		same(rows.filter((one) => one.button ? one.chevron : !one.chevron).map((one) => one.name), [], `${at}: a row with both a button and a chevron, or with neither`);
		same(rows.filter((one) => one.state.right > action(one).left + 0.5).map((one) => one.name), [], `${at}: line 2 running under the action`);
		const withButtons = rows.filter((one) => one.button);
		same(withButtons.map((one) => [one.name, Math.round(one.button!.height), one.button!.inHit, Math.round(Math.abs(one.button!.top + one.button!.height / 2 - (one.row.top + 32)))]), withButtons.map((one) => [one.name, 28, false, 0]), `${at}: each button 28 tall, outside the row's open target, on the row's middle`);
		const lineOf = (key: Key) => rows.find((one) => one.name === C[key].name)!;
		// The counts in the status line: the rooms end it, after the tools.
		same(lineOf("wiki").line.text, `${WORDS.status.connected} · ${WORDS.toolCount(4)} · ${WORDS.roomsInLine(2)}`, `${at}: a connected row's tools and rooms in its status line`);
		same([lineOf("ticket").line, lineOf("ticket").button?.words], [{ text: inLine(WORDS.wentWrong.addressNotFound.fact, 0), cut: false, tip: inLine(WORDS.wentWrong.addressNotFound.fact, 0) }, WORDS.button.changeAddress], `${at}: a broken row's reason whole beside its button`);
		same([lineOf("slow").line.text, lineOf("slow").button?.words], [inLine(WORDS.wentWrong.noAnswer.fact, 0), WORDS.button.tryAgain], `${at}: a row that didn't answer`);
		same(lineOf("locked").line, { text: inLine(LINES.locked, 0), cut: true, tip: inLine(LINES.locked, 0) }, `${at}: a long reason cut with its whole in its tip`);
		same([lineOf("tracker").button, lineOf("wiki").button], [null, null], `${at}: no button on a row signing in or connected`);
		// With no rooms column the row has room for a 60-character name; cut or whole, its tag stays whole beside it, clear of the chevron.
		const long = lineOf("long");
		same([long.tag?.whole, (long.tag?.right ?? 0) <= (long.tag?.nameRight ?? 0) + 0.5, long.nameLine.right <= action(long).left + 0.5], [true, true, true], `${at}: a 60-character name beside its whole tag, clear of the chevron`);
		assert(C.long.name.length >= 60, "the long name runs 60 characters");
		// The status marks, and words never coloured.
		const colours = await tokens(page);
		const marks = await page.locator(".connector-list > .connector-item").evaluateAll((elements) => elements.map((element) => {
			const w = window as any;
			const state = element.querySelector(".connector-item-state")!;
			const dot = getComputedStyle(element.querySelector(".connector-dot")!, "::before");
			return { name: element.querySelector(".connector-item-name-text")!.textContent, fill: dot.backgroundColor === "rgba(0, 0, 0, 0)" ? null : w.__seen(state, dot.backgroundColor), ring: dot.borderTopStyle, size: [dot.width, dot.height], spins: dot.animationName, words: w.__seen(state, getComputedStyle(state).color), contrast: w.__contrast(element.querySelector(".connector-item-status")!) as number };
		}));
		const mark = (key: Key) => marks.find((one) => one.name === C[key].name)!;
		same([mark("wiki").fill, mark("chat").fill, mark("ticket").fill, mark("office").fill, mark("calendar").fill, mark("calendar").ring, mark("tracker").size, mark("tracker").spins], [colours.ok, colours.warn, colours.danger, colours.grey, null, "solid", ["12px", "12px"], "spin"], `${at}: dots green, amber, red, grey, a hollow ring (its 1.5 px edge drawn as the screen allows) and a 12 px spinner`);
		same([mark("ticket").words, mark("wiki").words], [colours.soft, colours.muted], `${at}: a reason in soft text, a status muted`);
		same(marks.filter((one) => chroma(one.words) > 40).map((one) => one.name), [], `${at}: coloured words on line 2`);
		same(marks.filter((one) => one.contrast < 4.5).map((one) => `${one.name} ${one.contrast.toFixed(2)}`), [], `${at}: line 2 under 4.5:1`);
		// Hover, pressed and focus.
		const hit = row(page, "wiki").locator(".connector-item-hit");
		await hit.hover();
		await still(page, `${at}: hover`);
		same(...await fillAndToken(hit, "--exx-row-hover"), `${at}: a row's hover fill`);
		await page.mouse.down();
		await still(page, `${at}: pressed`);
		same(...await fillAndToken(hit, "--exx-row-press"), `${at}: a row's pressed fill`);
		// Let go on the page's title: a click lands on what both share, the pane, never the window's backdrop.
		await pane(page).locator(".pane-head h2").hover();
		await page.mouse.up();
		same([await page.locator(".connector-page").count(), await page.locator(".settings-overlay").count()], [0, 1], `${at}: a press let go off the row opens nothing`);
		const slowHit = row(page, "slow").locator(".connector-item-hit");
		// From the button of the row above (Shared calendar's Connect, the list being in name order).
		await row(page, "slow").evaluate((element) => element.previousElementSibling!.querySelector<HTMLElement>(".connector-item-side button")!.focus());
		await page.keyboard.press("Tab");
		assert(await slowHit.evaluate((element) => element === document.activeElement), `${at}: Tab from a row's button reaches the next row`);
		// The ring in the window's lighter focus colour (44), as seen over the row.
		same(await slowHit.evaluate((element) => { const w = window as any; const style = getComputedStyle(element); const token = getComputedStyle(document.querySelector(".settings-dialog")!).getPropertyValue("--settings-focus").trim(); return [style.outlineStyle, style.outlineWidth, style.outlineOffset, w.__seen(element, style.outlineColor) === w.__seen(element, token)]; }), ["solid", "2px", "-2px", true], `${at}: the focus ring inside the row`);
		same(await row(page, "slow").evaluate((element) => [element, element.nextElementSibling].map((one) => one ? getComputedStyle(one, "::before").visibility : "none")), ["hidden", "hidden"], `${at}: no line drawn over a focused row's ring`);
		await page.keyboard.press("Tab");
		assert(await buttonOf(page, "slow").evaluate((element) => element === document.activeElement), `${at}: Tab reaches its button right after its row`);
		// Its button opens nothing; checking to connected keeps the row's height and columns.
		const release = holdCheck(C.slow.id, { ok: true, toolCount: 3, toolNames: ["find_ticket", "add_ticket", "close_ticket"] });
		const before = (await measureRows(page)).find((one) => one.name === C.slow.name)!;
		await buttonOf(page, "slow").click();
		await rowsRead(page, { slow: WORDS.status.checking }, `${at}: Try again checks`);
		same(await buttonOf(page, "slow").evaluate((button) => [(button as HTMLButtonElement).disabled, getComputedStyle(button.querySelector(".connector-slot-label")!).visibility, ...[...button.querySelectorAll(".spinner")].map((spinner) => getComputedStyle(spinner).visibility)]), [true, "visible", "hidden"], `${at}: the pressed button keeps its words, the row's one spinner on its second line`);
		const during = (await measureRows(page)).find((one) => one.name === C.slow.name)!;
		release();
		// The check was answered here, so the server's list knows no tool count for it: the status alone.
		await rowsRead(page, { slow: WORDS.status.connected }, `${at}: the check connects`);
		await still(page, `${at}: connected`);
		const after = (await measureRows(page)).find((one) => one.name === C.slow.name)!;
		// Connected, the button gives its place on the right edge to the chevron.
		const shape = (one: typeof before) => [one.row.height, one.tile.left, one.nameLine.left, one.state.left, Math.round((one.button ?? one.chevron!).right)];
		same([shape(during), shape(after)], [shape(before), shape(before)], `${at}: checking and connected keep the row's height and columns`);
		same([!!before.button, !!after.button, !!after.chevron], [true, false, true], `${at}: connected, the chevron in the button's place`);
		same(await page.locator(".connector-page").count(), 0, `${at}: pressing a row's button opens nothing`);
		await closeWindow(page);
		// A list where every connector works: no button anywhere.
		await openConnectors(page, { list: ALL_CONNECTED });
		await rowsRead(page, { wiki: LINES.wiki, board: LINES.board }, `${at}: all connected`);
		same(await page.locator(".connector-list .connector-item-side :is(button, a)").count(), 0, `${at}: an all-connected list's buttons`);
		await page.context().close();
	}
	for (const theme of [LIGHT, DARK] as const) {
		const at = `390 ${theme}`;
		const page = await openPage(browser, phone(theme), "on");
		await openEveryState(page, { list: [...EVERY_STATE, "imported"] });
		const rows = await measureRows(page);
		clearOfButtons(rows, at);
		// The name with its tag and the status line, which wraps whole, 2 apart, 12 above and under, the tile and a
		// chevron on their middle; a row with a button has no chevron and grows by a line of its own, 8 under the
		// status, on the text's left edge.
		const lines = rows.map((one) => {
			const text = { top: one.nameLine.top, height: one.state.bottom - one.nameLine.top } as Box;
			const last = one.button ?? one.state;
			return [one.name, Math.round(one.nameLine.top - one.row.top), one.nameLine.height, Math.round(one.state.top - one.nameLine.bottom), one.line.cut, Math.round(middle(one.tile) - middle(text)), one.chevron ? Math.round(middle(one.chevron) - middle(text)) : null, one.button ? [Math.round(one.button.top - one.state.bottom), Math.round(one.button.left - one.nameLine.left), Math.round(one.button.height)] : null, Math.round(one.row.bottom - last.bottom)];
		});
		same(lines, rows.map((one) => [one.name, 12, 20, 2, false, 0, one.button ? null : 0, one.button ? [8, 0, 44] : null, 12]), `${at}: the name's line and the whole status line, a button on a line of its own under them`);
		same(rows.filter((one) => one.button).length, 8, `${at}: the rows with a button`);
		// The name is cut only at the row's edge, its tag whole after it.
		same(rows.filter((one) => (one.tag && !one.tag.whole) || (one.nameCut && Math.abs((one.tag?.right ?? one.nameTextRight) - one.nameLine.right) > 1)).map((one) => one.name), [], `${at}: a name cut before the row's edge, or a tag cut`);
		// The status line wraps between its parts, never inside one that fits a line.
		same(await page.locator(".connector-list .connector-item-status").evaluateAll((all) => all.flatMap((status) => {
			const text = status.textContent!;
			const node = document.createTreeWalker(status, NodeFilter.SHOW_TEXT);
			const ends: Array<[Node, number]> = [];
			while (node.nextNode()) for (let i = 0; i <= node.currentNode.textContent!.length; i += 1) if (i < node.currentNode.textContent!.length) ends.push([node.currentNode, i]);
			let at = 0;
			return text.split(" · ").flatMap((part) => {
				const range = document.createRange();
				range.setStart(...ends[at]);
				range.setEnd(ends[at + part.length - 1][0], ends[at + part.length - 1][1] + 1);
				at += part.length + 3;
				const tops = new Set([...range.getClientRects()].filter((box) => box.width > 0).map((box) => Math.round(box.top)));
				const wide = [...range.getClientRects()].reduce((sum, box) => sum + box.width, 0);
				return tops.size > 1 && wide < status.getBoundingClientRect().width ? [part] : [];
			});
		})), [], `${at}: a part of the status line cut in two`);
		same(rows.find((one) => one.name === C.locked.name)!.line, { text: inLine(LINES.locked, 0), cut: false, tip: inLine(LINES.locked, 0) }, `${at}: a long reason whole, on as many lines as it takes`);
		await nothingSideways(page, at);
		await page.context().close();
	}
	console.log("  ok  rows at 1440: 64 tall in every state with their columns at one x, one action on the right edge (a button 28 tall outside the open target, else the chevron) at one x; tools and rooms in the status line; a reason in its status's place, whole or cut with its tip; dots by state, words uncoloured at 4.5:1 or more; hover, pressed and an inside focus ring, Tab to the button after its row; checking to connected keeps the row and puts the chevron in the button's place; an all-connected list has no button; at 390 the status line whole, buttons 44 on a line of their own, nothing sideways; both themes");
}

async function checkWaitingFoot(browser: Browser): Promise<void> {
	for (const theme of [LIGHT, DARK] as const) {
		const at = `1440 ${theme}`;
		const page = await openPage(browser, desktop(1440, 900, theme), "on");
		const opened = await openEveryState(page);
		signIns.delete(C.tracker.id);
		await closeWindow(page);
		await openConnectors(page);
		await rowsRead(page, { calendar: WORDS.status.notConnected }, `${at}: nothing signing in`);
		same(await page.locator(".connector-waiting-foot").count(), 0, `${at}: no foot with nothing under way`);
		// Connect on one that signs in.
		asked.length = 0;
		await buttonOf(page, "calendar").click();
		await rowsRead(page, { calendar: WORDS.status.signingIn }, `${at}: Connect leaves its row waiting`);
		same(await buttonOf(page, "calendar").count(), 0, `${at}: no button on the row signing in`);
		const foot = footOf(page);
		await foot.waitFor();
		const strip = foot.locator(".connector-waiting");
		same([await foot.getAttribute("role"), await strip.count(), await strip.locator(".connector-waiting-name").innerText(), await strip.locator(".connector-waiting-line").innerText(), (await strip.locator("button").innerText()).trim(), await strip.locator(".connector-dot-busy").count()], ["status", 1, C.calendar.name, WORDS.signingInNote, WORDS.button.cancel, 1], `${at}: the foot's strip`);
		await waitUntil(() => strip.locator("button").evaluate((button) => button === document.activeElement), `${at}: the focus on the foot's Cancel`);
		const [stripBox, list, footBox, head, cancel] = [await boxOf(strip), await boxOf(opened.locator(".connector-list")), await boxOf(foot), await boxOf(opened.locator(".pane-head")), await boxOf(strip.locator("button"))];
		same([stripBox.height, Math.round(stripBox.left), Math.round(stripBox.right), Math.round(cancel.right), cancel.height], [64, Math.round(list.left), Math.round(list.right), Math.round(list.right), 28], `${at}: the strip 64 tall on the column's edges, Cancel small at its right`);
		same([Math.round(footBox.left), Math.round(footBox.right)], [Math.round(head.left), Math.round(head.right)], `${at}: the foot across the pane as the header`);
		const hairline = await foot.evaluate((element) => { const style = getComputedStyle(element); return [style.borderTopWidth, (window as any).__seen(element, style.borderTopColor) as string]; });
		same(hairline[0], "1px", `${at}: a hairline above the foot`);
		// At the end of the page nothing is under it.
		await page.evaluate(() => { const scroller = [...document.querySelectorAll(".settings-dialog-pane")].find((one) => one.getClientRects().length)!; scroller.scrollTop = scroller.scrollHeight; });
		await scrolled(page, `${at}: the end`);
		const [last, footNow] = [await boxOf(opened.locator(".connector-config-note .cli-note").last()), await boxOf(foot)];
		assert(last.bottom <= footNow.top + 0.5, `${at}: the page's last line above the foot (${last.bottom} against ${footNow.top})`);
		// Cancel stops the sign-in: asked once, the foot gone, the row as before.
		await strip.locator("button").click();
		await rowsRead(page, { calendar: WORDS.status.notConnected }, `${at}: Cancel`);
		await foot.waitFor({ state: "detached" });
		same([asked.filter((one) => one === `DELETE login ${C.calendar.id}`).length, (await buttonOf(page, "calendar").innerText()).trim()], [1, WORDS.button.connect], `${at}: Cancel asks once, and the row offers Connect again`);
		await waitUntil(() => buttonOf(page, "calendar").evaluate((button) => button === document.activeElement), `${at}: the focus back on the row's Connect once its strip went`);
		await page.context().close();
	}
	const at = "1440 light";
	const page = await openPage(browser, desktop(1440, 900, LIGHT), "on");
	// A sign-in still open after a reload and a reopening (R1D-F6), and Cancel there.
	signIns.clear();
	signIns.set(C.calendar.id, "pending");
	await openConnectors(page);
	await rowsRead(page, { calendar: WORDS.status.signingIn }, `${at}: after a reload, still signing in`);
	await footOf(page).locator(".connector-waiting-name", { hasText: C.calendar.name }).waitFor();
	await closeWindow(page);
	await openWindow(page, "settings");
	await goToPage(page, "Connectors");
	await rowsRead(page, { calendar: WORDS.status.signingIn }, `${at}: reopened, still signing in`);
	asked.length = 0;
	await footOf(page).locator("button").click();
	await rowsRead(page, { calendar: WORDS.status.notConnected }, `${at}: Cancel after reopening`);
	same(asked.filter((one) => one === `DELETE login ${C.calendar.id}`).length, 1, `${at}: Cancel after reopening asks once`);
	same(await page.locator(".connector-waiting-foot").count(), 0, `${at}: the foot gone`);
	// A program getting ready, and its Cancel stopping the check.
	const release = holdCheck(C.office.id, { ok: true, toolCount: 1, toolNames: ["open_file"] });
	const stopped: string[] = [];
	page.on("requestfailed", (request) => { if (request.url().includes(`/${C.office.id}/test`)) stopped.push(request.url()); });
	await buttonOf(page, "office").click();
	await rowsRead(page, { office: WORDS.status.gettingReady }, `${at}: a program getting ready`);
	const strip = footOf(page).locator(".connector-waiting");
	same([await strip.locator(".connector-waiting-name").innerText(), await strip.locator(".connector-waiting-line").innerText()], [C.office.name, WORDS.gettingReadyNote], `${at}: getting ready in the foot`);
	await strip.locator("button").click();
	await rowsRead(page, { office: WORDS.status.program }, `${at}: Cancel stops the program's check`);
	await waitUntil(() => buttonOf(page, "office").evaluate((button) => button === document.activeElement), `${at}: the focus back on the row's Check connection once its strip went`);
	await waitUntil(() => stopped.length === 1, `${at}: the check's request stopped`);
	release();
	// Two under way, newest last: the later in the list began first, so the list's order would read the other way.
	signIns.set(C.calendar.id, "pending");
	await closeWindow(page);
	await openConnectors(page);
	await rowsRead(page, { calendar: WORDS.status.signingIn }, `${at}: one signing in`);
	await buttonOf(page, "notes").click();
	await rowsRead(page, { notes: WORDS.status.signingIn }, `${at}: a second signing in`);
	same(await footOf(page).locator(".connector-waiting-name").allInnerTexts(), [C.calendar.name, C.notes.name], `${at}: two strips, newest last`);
	await page.context().close();
	// At 390: across the screen, the sentence on two lines, Cancel 44.
	const small = await openPage(browser, phone(LIGHT), "on");
	await openConnectors(small);
	await rowsRead(small, { calendar: WORDS.status.signingIn, notes: WORDS.status.signingIn }, "390: two signing in");
	const footBox = await boxOf(footOf(small));
	const [line, cancel] = [await boxOf(footOf(small).locator(".connector-waiting-line").first()), await boxOf(footOf(small).locator("button").first())];
	// Across the screen up to the pane's scrollbar, which the pane keeps beside what it scrolls.
	const inside = await pane(small).evaluate((element) => element.getBoundingClientRect().left + element.clientLeft + element.clientWidth);
	same([Math.round(footBox.left), Math.round(footBox.right), line.height, cancel.height], [0, Math.round(inside), 36, 44], "390: the foot across the screen, the sentence on two lines, Cancel 44");
	await nothingSideways(small, "390, the foot");
	await small.context().close();
	// Over remote access, and with the switch off: no foot.
	signIns.set(C.tracker.id, "pending");
	for (const [where, look, scene] of [["remote access", "on", { remote: true }], ["switch off", "off", {}]] as const) {
		const other = await openPage(browser, desktop(1440, 900, LIGHT), look);
		await openConnectors(other, scene);
		await rowsRead(other, { tracker: "remote" in scene ? WORDS.status.notConnected : WORDS.status.signingIn }, `${where}: one signing in`);
		await answered(other, where);
		same(await other.locator(".connector-waiting-foot").count(), 0, `${where}: a foot`);
		await other.context().close();
	}
	signIns.clear();
	console.log("  ok  the foot, both themes: Connect leaves its row waiting with no button and a strip of the mark, the name, the sentence and Cancel, 64 tall on the column's edges, across the pane with a hairline, the focus on Cancel; the page's last line above it at the end; Cancel asks once and the row is as before; a reload and a reopening bring it back and Cancel works; a program getting ready shows there and Cancel stops its check; two stack newest last; at 390 across the screen, two lines, Cancel 44; none over remote access or with the switch off");
}

async function checkDirectory(browser: Browser): Promise<void> {
	for (const theme of [LIGHT, DARK] as const) {
		const at = `1440 ${theme}`;
		const page = await openPage(browser, desktop(1440, 900, theme), "on");
		const opened = await openConnectors(page, { list: ALL_CONNECTED });
		const directory = opened.locator(".connector-directory");
		const [search, card, head, title] = [await boxOf(directory.locator(".connector-dir-search")), await boxOf(directory.locator(".settings-rows")), await boxOf(directory.locator(".group-head")), await boxOf(directory.locator(".settings-group-kicker"))];
		same([search.width, search.height, Math.round(search.right)], [240, 32, Math.round(card.right)], `${at}: the search 240 by 32 ending on the card's edge`);
		assert(search.top >= head.top - 0.5 && search.bottom <= head.bottom + 0.5 && search.top < title.bottom, `${at}: the search on the title's line`);
		const entries = await directory.locator(".connector-dir-row").evaluateAll((rows) => rows.map((element) => {
			const tag = element.querySelector<HTMLElement>(".connector-dir-kind")!;
			const sub = element.querySelector<HTMLElement>(".settings-row-sub")!;
			const add = element.querySelector<HTMLElement>("button");
			return { height: element.getBoundingClientRect().height, tag: tag.scrollWidth <= tag.clientWidth && tag.getBoundingClientRect().right <= element.querySelector(".settings-row-label")!.getBoundingClientRect().right + 0.5, sub: [Math.round(sub.getBoundingClientRect().height), sub.getAttribute("title") === sub.textContent], add: add ? [add.getBoundingClientRect().height, Math.round(add.getBoundingClientRect().right)] : null };
		}));
		same([...new Set(entries.map((one) => one.height))], [64], `${at}: the Directory's rows 64 tall`);
		same(entries.filter((one) => !one.tag).length, 0, `${at}: a tag cut`);
		same([...new Set(entries.map((one) => JSON.stringify(one.sub)))], [JSON.stringify([18, true])], `${at}: each description one line, whole in its tip`);
		same([...new Set(entries.flatMap((one) => (one.add ? [JSON.stringify(one.add)] : [])))].length, 1, `${at}: every Add 28 tall at one x`);
		same(entries[0].add?.[0], 28, `${at}: Add 28 tall`);
		const addX = entries[0].add![1];
		// A key: its key row with a secondary Add, Cancel closing it.
		await directory.getByRole("button", { name: WORDS.directoryAdd({ name: "GitHub", kind: "token" }), exact: true }).click();
		const keyRow = directory.locator(".connector-dir-token-row");
		await keyRow.waitFor();
		same(await inkedOn(page, theme), [], `${at}: ink buttons with a key row open`);
		same(await keyRow.getByRole("button", { name: "Add", exact: true }).isDisabled(), true, `${at}: the key row's Add waits for a key`);
		await directory.locator(".connector-dir-row", { hasText: "GitHub" }).getByRole("button", { name: "Cancel" }).click();
		await keyRow.waitFor({ state: "detached" });
		// No sign-in: added, with the line after an add; "Added" in Add's place.
		await directory.getByRole("button", { name: WORDS.directoryAdd({ name: "Context7", kind: "open" }), exact: true }).click();
		await opened.locator(".connector-notice").waitFor({ timeout: 15000 });
		const added = directory.locator(".connector-dir-row", { hasText: "Context7" }).locator(".settings-row-value");
		same([await added.innerText(), Math.round((await boxOf(added)).right)], ["Added", addX], `${at}: "Added" in Add's place`);
		// A sign-in: added, its row waiting and the foot.
		await directory.getByRole("button", { name: WORDS.directoryAdd({ name: "Notion", kind: "oauth" }), exact: true }).click();
		await footOf(page).locator(".connector-waiting-name", { hasText: "Notion" }).waitFor({ timeout: 15000 });
		await waitUntil(() => footOf(page).locator("button").evaluate((button) => button === document.activeElement), `${at}: the focus on the foot's Cancel once Add left`);
		same(await inkedOn(page, theme), [], `${at}: ink buttons after the adds`);
		await footOf(page).locator("button").click();
		await page.locator(".connector-waiting-foot").waitFor({ state: "detached" });
		await removeDirectoryAdds();
		// No match: one muted line, no card.
		await directory.locator(".connector-dir-search").fill("no such connector anywhere");
		const none = directory.getByText(WORDS.directoryNoMatch);
		await none.waitFor();
		const colours = await tokens(page);
		same([await directory.locator(".settings-rows").count(), await none.evaluate((element) => (window as any).__seen(element, getComputedStyle(element).color))], [0, colours.muted], `${at}: no match, a muted line and no card`);
		await page.context().close();
	}
	const page = await openPage(browser, phone(LIGHT), "on");
	const opened = await openConnectors(page, { list: ALL_CONNECTED });
	const directory = opened.locator(".connector-directory");
	const [search, card, title] = [await boxOf(directory.locator(".connector-dir-search")), await boxOf(directory.locator(".settings-rows")), await boxOf(directory.locator(".group-head .pane-head-text"))];
	same([search.top >= title.bottom, Math.round(search.left), Math.round(search.right), search.height], [true, Math.round(card.left), Math.round(card.right), 44], "390: the search on its own line, across the card, 44 tall");
	// A description runs to two lines on a phone, then "…" with its whole in its tip.
	const subs = await directory.locator(".connector-dir-row .settings-row-sub").evaluateAll((all) => all.map((sub) => [Math.round(sub.getBoundingClientRect().height), sub.scrollHeight <= sub.clientHeight + 1 || sub.getAttribute("title") === sub.textContent]));
	same([subs.every(([height]) => height === 18 || height === 36), subs.some(([height]) => height === 36), subs.every(([, whole]) => whole)], [true, true, true], `390: each description one or two lines, whole or in its tip (${subs.map(([height]) => height).join(" ")})`);
	await directory.getByRole("button", { name: WORDS.directoryAdd({ name: "GitHub", kind: "token" }), exact: true }).click();
	await directory.locator(".connector-dir-token-row").waitFor();
	const where = await directory.locator(".connector-dir-token-row").evaluate((keyRow) => {
		const [field, link] = [keyRow.querySelector("input")!.getBoundingClientRect(), keyRow.querySelector("a")!];
		const words = document.createRange();
		words.selectNodeContents(link);
		return [Math.round(words.getBoundingClientRect().left - field.left), link.getBoundingClientRect().top >= field.bottom];
	});
	same(where, [0, true], "390: where to get a key under the field, its words on the field's edge");
	await nothingSideways(page, "390, the Directory with a key row");
	await page.context().close();
	console.log("  ok  the Directory, both themes: the search 240 by 32 on its title's line ending on the card's edge; rows 64 with whole tags, one line of description whole in its tip, Add 28 at one x; a key opens its key row with a secondary Add and Cancel closes it; no sign-in adds with the line after an add and \"Added\" in Add's place; a sign-in leaves the foot with the focus on its Cancel; one ink button throughout; no match a muted line and no card; at 390 the search on its own line, 44 tall, nothing sideways");
}

async function checkEmptyAndFailed(browser: Browser): Promise<void> {
	for (const theme of [LIGHT, DARK] as const) {
		const at = `1440 ${theme}`;
		const page = await openPage(browser, desktop(1440, 900, theme), "on");
		// No connectors: the muted line with its link, no card, the Directory after it.
		let opened = await openConnectors(page, { list: [] });
		const colours = await tokens(page);
		const empty = opened.locator(".connector-list-section > .settings-empty");
		same([await empty.evaluate((element) => { const style = getComputedStyle(element); return [(window as any).__seen(element, style.color), style.backgroundColor, style.borderTopStyle, (element.nextElementSibling ? 1 : 0) + (element.closest("section")!.nextElementSibling?.classList.contains("connector-directory") ? 1 : 0)]; }), await empty.getByRole("button", { name: WORDS.empty.link }).count(), await opened.locator(".connector-list").count()], [[colours.muted, "rgba(0, 0, 0, 0)", "none", 1], 1, 0], `${at}: no connectors, a muted line with its link, no card, the Directory next`);
		await closeWindow(page);
		// A failed list: a strip with a red dot, its line in the text colour, and Try again reading the list again.
		opened = await openConnectors(page, { list: "failed" });
		const failed = opened.locator(".connector-load-error");
		const strip = await failed.evaluate((element) => { const w = window as any; const dot = getComputedStyle(element, "::before"); return { dot: w.__seen(element, dot.backgroundColor), size: [dot.width, dot.height], words: w.__seen(element, getComputedStyle(element).color), contrast: w.__contrast(element.querySelector("span")!) as number, radius: getComputedStyle(element).borderTopLeftRadius, height: element.getBoundingClientRect().height }; });
		same([strip.dot, strip.size, strip.words, strip.contrast >= 4.5, strip.radius, strip.height >= 40], [colours.danger, ["8px", "8px"], colours.text, true, "12px", true], `${at}: a failed list's strip (contrast ${strip.contrast.toFixed(2)})`);
		await answer(page, {});
		const reads = page.waitForRequest((request) => request.url().includes("/api/mcp/status"));
		await failed.getByRole("button", { name: WORDS.loadAgain }).click();
		await reads;
		await opened.locator(".connector-list").waitFor();
		await closeWindow(page);
		// The line after an add: a strip with a green dot, 12 above the list.
		opened = await openConnectors(page, { list: ALL_CONNECTED });
		await opened.getByRole("button", { name: WORDS.directoryAdd({ name: "Context7", kind: "open" }), exact: true }).click();
		const notice = opened.locator(".connector-notice");
		await notice.waitFor({ timeout: 15000 });
		const [noticeBox, list] = [await boxOf(notice), await boxOf(opened.locator(".connector-list"))];
		same([await notice.evaluate((element) => (window as any).__seen(element, getComputedStyle(element, "::before").backgroundColor)), Math.round(list.top - noticeBox.bottom)], [colours.ok, 12], `${at}: the line after an add, a green dot 12 above the list`);
		await removeDirectoryAdds();
		await closeWindow(page);
		// Loading: a muted line, shown only before the list was ever read, so in a page loaded again.
		await page.reload();
		await page.locator(".persistent-agent-card").first().waitFor({ timeout: 15000 });
		await installColourTools(page);
		let letGo = () => {};
		const held = new Promise<void>((resolve) => { letGo = resolve; });
		await page.route("**/api/mcp/status", async (route) => { await held; await route.fallback().catch(() => undefined); });
		await openWindow(page, "settings");
		await goToPage(page, "Connectors");
		const loading = pane(page).locator(".connector-list-section > .ai-setup-copy");
		await loading.waitFor();
		same(await loading.evaluate((element) => (window as any).__seen(element, getComputedStyle(element).color)), colours.muted, `${at}: loading, a muted line`);
		letGo();
		await page.context().close();
	}
	const page = await openPage(browser, phone(LIGHT), "on");
	for (const list of [[], "failed"] as Array<Scene["list"] & {}>) {
		await openConnectors(page, { list });
		await nothingSideways(page, `390, ${list.length ? "a failed list" : "no connectors"}`);
		await closeWindow(page);
	}
	await page.context().close();
	console.log("  ok  no connectors a muted line with its link and no card, the Directory next; a failed list a strip with a red dot, its line in the text colour at 4.5:1 or more, Try again reading the list again; the line after an add a strip with a green dot 12 above the list; loading a muted line; both themes; nothing sideways at 390");
}

async function checkReadOnly(browser: Browser): Promise<void> {
	const page = await openPage(browser, phone(LIGHT), "on");
	signIns.clear();
	signIns.set(C.tracker.id, "pending");
	const opened = await openConnectors(page, { remote: true });
	// Over remote access the page doesn't follow a sign-in: the row reads as it did before it.
	await rowsRead(page, { tracker: WORDS.status.notConnected }, "remote access: the rows");
	await answered(page, "remote access");
	same([await opened.locator(".connector-list .connector-item-side :is(button, a)").count(), await opened.locator(".connector-add-btn").count(), await opened.locator("section[aria-label='Connector directory']").count(), await page.locator(".connector-waiting-foot").count()], [0, 0, 0, 0], "remote access at 390: row buttons, Add connector, the Directory, a foot");
	await opened.getByText(WORDS.setUpOnComputer).waitFor();
	await nothingSideways(page, "remote access at 390");
	await row(page, "wiki").locator(".connector-item-hit").click();
	await opened.locator(".connector-page").waitFor();
	signIns.clear();
	await page.context().close();
	console.log("  ok  remote access at 390: no row button, no Add connector, no Directory, no foot, the line that connectors are set up on the computer itself, and a row opens its page (a shared server's page reads as on the base: checkOff)");
}

/** The spec's type scale: five sizes and three weights. */
const SIZES = ["24px", "18px", "14px", "13px", "12px"];
/** 600 is a section's label (44). */
const WEIGHTS = ["400", "500", "600", "700"];

async function checkShared(browser: Browser): Promise<void> {
	const off: string[] = [];
	for (const theme of [LIGHT, DARK] as const) {
		const page = await openPage(browser, desktop(1440, 900, theme), "on");
		await openEveryState(page);
		await pane(page).getByRole("button", { name: WORDS.directoryAdd({ name: "GitHub", kind: "token" }), exact: true }).click();
		await pane(page).locator(".connector-dir-token-row").waitFor();
		same(await inkedOn(page, theme), [], `1440 ${theme}: the ink buttons`);
		off.push(...await page.evaluate(({ sizes, weights, theme }) => {
			const w = window as any;
			const scroller = [...document.querySelectorAll(".settings-dialog-pane")].find((element) => element.getClientRects().length)!;
			const words = [...scroller.querySelectorAll("*")].filter((element) => element.getClientRects().length > 0 && ([...element.childNodes].some((node) => node.nodeType === Node.TEXT_NODE && node.textContent!.trim()) || element.matches("input:not([type=checkbox], [type=radio])")));
			const at = (element: Element) => `${theme}: ${element.tagName.toLowerCase()}.${[...element.classList].join(".")} "${(element.textContent ?? "").trim().slice(0, 24)}"`;
			const rgb = (hex: string) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
			return [
				...words.map((element) => [element, getComputedStyle(element)] as const).filter(([, style]) => !sizes.includes(style.fontSize) || !weights.includes(style.fontWeight)).map(([element, style]) => `${at(element)} ${style.fontSize} ${style.fontWeight}`),
				// Colour only on dots and red buttons: no word in a colour of its own (the theme's greys are warm, a status colour is not).
				...words.filter((element) => !element.closest("button.rs-btn-danger")).filter((element) => { const c = rgb(w.__seen(element, getComputedStyle(element).color)); return Math.max(...c) - Math.min(...c) > 40; }).map((element) => `${at(element)} coloured`),
				...words.filter((element) => !element.closest("button:disabled") && w.__contrast(element) < 4.5).map((element) => `${at(element)} ${w.__contrast(element).toFixed(2)}:1`),
			];
		}, { sizes: SIZES, weights: WEIGHTS, theme }));
		await page.context().close();
	}
	for (const one of new Set(off)) console.log(`  ..  ${one}`);
	same([...new Set(off)].length, 0, "words off the scale, coloured or under 4.5:1 (listed above)");
	for (const [width, height] of [[390, 844], [800, 700], [1024, 768], [1440, 900]] as const) {
		const page = await openPage(browser, width === 390 ? phone(LIGHT) : desktop(width, height, LIGHT), "on");
		await openEveryState(page);
		await nothingSideways(page, `${width}`);
		await page.context().close();
	}
	console.log("  ok  every state and a key row open, both themes: words on the scale, none coloured, each at 4.5:1 or more, one ink button; nothing sideways at 390, 800, 1024 and 1440");
}

// --- Pictures of each scene, for the eye --------------------------------------------------

async function shoot(page: Page, name: string): Promise<void> {
	if (!process.env.LOOK_SHOTS) return;
	fs.mkdirSync(process.env.LOOK_SHOTS, { recursive: true });
	await page.screenshot({ path: path.join(process.env.LOOK_SHOTS, `${name}.png`) });
}

/** Waits until each of these rows' second line starts with the given words, in words the base and the head share. */
async function linesStart(page: Page, keys: Key[], words: string, what: string): Promise<void> {
	await waitUntil(async () => (await Promise.all(keys.map((key) => lineOfRow(page, key).textContent({ timeout: 2000 }).catch(() => "")))).every((line) => line?.startsWith(words)), `${what}: the rows settle`, 20000);
	await answered(page, what);
	await still(page, what);
}

const toEnd = (page: Page) => page.evaluate(() => { const scroller = [...document.querySelectorAll(".settings-dialog-pane")].find((one) => one.getClientRects().length)!; scroller.scrollTop = scroller.scrollHeight; });

/**
 * The list's rows a person sees whole right now (nothing over their top or bottom edge, the sticky header and the
 * foot included), by name, and how far the pane would scroll to bring the last of them to the top under the header.
 */
const wholeRows = (page: Page) => page.evaluate(() => {
	const scroller = [...document.querySelectorAll(".settings-dialog-pane")].find((one) => one.getClientRects().length)!;
	const head = scroller.querySelector(".pane-head");
	const bandTop = Math.max(scroller.getBoundingClientRect().top, head && getComputedStyle(head).position === "sticky" ? head.getBoundingClientRect().bottom : 0);
	const rows = [...document.querySelectorAll(".connector-list > .connector-item")];
	const whole = rows.filter((row) => {
		const box = row.getBoundingClientRect();
		const on = (y: number) => row.contains(document.elementFromPoint(box.left + 4, y));
		return box.top >= 0 && box.bottom <= innerHeight && on(box.top + 1) && on(box.bottom - 1);
	});
	const name = (row: Element) => row.querySelector(".connector-item-name-text")!.textContent!.trim();
	const last = whole.at(-1);
	return { names: whole.map(name), all: rows.map(name), lastIsEnd: last === rows.at(-1), step: last ? last.getBoundingClientRect().top - bandTop : 0 };
});

/** Takes a picture of the list and logs which rows are whole in it. */
async function shootRows(page: Page, name: string): Promise<string[]> {
	await shoot(page, name);
	const { names } = await wholeRows(page);
	console.log(`  ..  ${name}: ${names.join(", ") || "no row whole"}`);
	return names;
}

/**
 * A picture of each scene the look is judged on, taken the same way from a page built from the base and from the
 * head, so they can sit side by side; every wait reads words both builds share. LOOK_INIT_SCRIPT names a script
 * file the page runs before its own, such as one that gives it the Mac app's look.
 */
async function checkPictures(browser: Browser): Promise<void> {
	if (!process.env.LOOK_SHOTS) return;
	const open = async (options: ReturnType<typeof desktop>) => {
		const page = await openPage(browser, options, "on");
		if (process.env.LOOK_INIT_SCRIPT) await page.context().addInitScript({ path: process.env.LOOK_INIT_SCRIPT });
		return page;
	};
	for (const [where, options] of [["1440-light", desktop(1440, 900, LIGHT)], ["1440-dark", desktop(1440, 900, DARK)], ["390-light", phone(LIGHT)], ["390-dark", phone(DARK)]] as const) {
		const page = await open(options);
		// Every state, one signing in.
		signIns.clear();
		signIns.set(C.tracker.id, "pending");
		signIns.set(C.notes.id, "then-busy");
		let opened = await openConnectors(page);
		await settledOnBoth(page, `${where}: every state`);
		const seen = new Set(await shootRows(page, `${where}-01-every-state`));
		if (where.startsWith("390")) {
			// On a phone, views down the list, each starting at the last row the one before showed whole, to its last row.
			for (const letter of "bcdefgh") {
				const view = await wholeRows(page);
				if (view.lastIsEnd) break;
				assert(view.step > 0, `${where}: the list's views move down`);
				await page.evaluate((step) => { [...document.querySelectorAll(".settings-dialog-pane")].find((one) => one.getClientRects().length)!.scrollTop += step; }, view.step);
				await scrolled(page, where);
				for (const one of await shootRows(page, `${where}-01${letter}-every-state-rest`)) seen.add(one);
			}
		} else {
			// The rest of the list, its last row on the pane's middle.
			await page.locator(".connector-list > .connector-item").last().evaluate((element) => element.scrollIntoView({ block: "center" }));
			await scrolled(page, where);
			for (const one of await shootRows(page, `${where}-01b-every-state-rest`)) seen.add(one);
		}
		await toEnd(page);
		await scrolled(page, where);
		for (const one of await shootRows(page, `${where}-02-every-state-end`)) seen.add(one);
		const missing = (await wholeRows(page)).all.filter((one) => !seen.has(one));
		assert(missing.length === 0, `${where}: rows whole in no picture: ${missing.join(", ")}`);
		await closeWindow(page);
		// Every connector working, then the add menu open.
		opened = await openConnectors(page, { list: ALL_CONNECTED });
		await linesStart(page, ALL_CONNECTED, WORDS.status.connected, `${where}: all connected`);
		await shoot(page, `${where}-03-all-connected`);
		await opened.locator(".connector-add-btn").click();
		await page.locator(".ai-profile-menu").waitFor();
		await shoot(page, `${where}-04-add-menu`);
		// The Directory, a key row open.
		await page.getByRole("menuitem", { name: WORDS.addWays.directory }).click();
		await scrolled(page, where);
		await opened.getByRole("button", { name: WORDS.directoryAdd({ name: "GitHub", kind: "token" }), exact: true }).click();
		await opened.locator(".connector-dir-token-row").waitFor();
		await shoot(page, `${where}-05-directory-key-row`);
		await page.context().close();
	}
	for (const [where, options] of [["1440-light", desktop(1440, 900, LIGHT)], ["1440-dark", desktop(1440, 900, DARK)]] as const) {
		const page = await open(options);
		signIns.clear();
		for (const [name, list] of [["06-no-connectors", []], ["07-failed-list", "failed"]] as Array<[string, Scene["list"]]>) {
			await openConnectors(page, { list });
			await answered(page, `${where}: ${name}`);
			await shoot(page, `${where}-${name}`);
			await closeWindow(page);
		}
		// A search with no match.
		let opened = await openConnectors(page, { list: ALL_CONNECTED });
		await opened.locator(".connector-dir-search").fill("no such connector anywhere");
		await opened.getByText(WORDS.directoryNoMatch).waitFor();
		await page.mouse.move(5, 5);
		await shoot(page, `${where}-08-no-match`);
		await closeWindow(page);
		// The line after an add.
		opened = await openConnectors(page, { list: ALL_CONNECTED });
		await opened.getByRole("button", { name: WORDS.directoryAdd({ name: "Context7", kind: "open" }), exact: true }).click();
		await opened.locator(".connector-notice").waitFor({ timeout: 15000 });
		await opened.locator(".connector-notice").scrollIntoViewIfNeeded();
		await page.mouse.move(5, 5);
		await still(page, `${where}: after an add`);
		await shoot(page, `${where}-09-after-an-add`);
		await removeDirectoryAdds();
		await closeWindow(page);
		// A row's reason, then its status while Try again checks.
		signIns.set(C.tracker.id, "pending");
		signIns.set(C.notes.id, "then-busy");
		opened = await openConnectors(page);
		await settledOnBoth(page, `${where}: a reason`);
		await row(page, "slow").scrollIntoViewIfNeeded();
		await shoot(page, `${where}-10-a-reason`);
		const release = holdCheck(C.slow.id, { ok: false, error: "fetch failed" });
		await buttonOf(page, "slow").click();
		await rowsRead(page, { slow: WORDS.status.checking }, `${where}: Try again checks`);
		await page.mouse.move(5, 5);
		await still(page, `${where}: checking`);
		await shoot(page, `${where}-11-the-reason-gives-way-while-checking`);
		release();
		// A program getting ready.
		const ready = holdCheck(C.office.id, { ok: true, toolCount: 1, toolNames: ["open_file"] });
		await buttonOf(page, "office").click();
		await rowsRead(page, { office: WORDS.status.gettingReady }, `${where}: getting ready`);
		await row(page, "office").scrollIntoViewIfNeeded();
		await page.mouse.move(5, 5);
		await still(page, `${where}: getting ready`);
		await shoot(page, `${where}-12-getting-ready`);
		ready();
		await closeWindow(page);
		// A row's hover, pressed and focus.
		opened = await openConnectors(page, { list: ALL_CONNECTED });
		await linesStart(page, ALL_CONNECTED, WORDS.status.connected, `${where}: a row's states`);
		const hit = row(page, "wiki").locator(".connector-item-hit");
		await hit.hover();
		await still(page, `${where}: hover`);
		await shoot(page, `${where}-13-row-hover`);
		await page.mouse.down();
		await still(page, `${where}: pressed`);
		await shoot(page, `${where}-14-row-pressed`);
		await opened.locator(".pane-head h2").hover();
		await page.mouse.up();
		await page.mouse.move(5, 5);
		await row(page, "board").locator(".connector-item-hit").focus();
		await page.keyboard.press("Tab");
		await still(page, `${where}: focus`);
		await shoot(page, `${where}-15-row-focus`);
		await page.context().close();
	}
	// Over remote access, on a phone.
	const page = await open(phone(LIGHT));
	signIns.clear();
	await openConnectors(page, { remote: true });
	await linesStart(page, ["wiki"], WORDS.status.connected, "remote access");
	await shoot(page, "390-light-16-remote-access");
	await toEnd(page);
	await still(page, "remote access, its end");
	await shoot(page, "390-light-17-remote-access-end");
	await page.context().close();
}

let model: http.Server | undefined;
let server: ChildProcessWithoutNullStreams | null = null;
try {
	const agents = await import("../src/persistent-agents.js");
	const lookRoom = agents.createPersistentAgentFromScaffoldInput({ displayName: ROOM, userName: "Synthetic User", preferredUserAddress: "Synthetic User" }).agent.agentId;
	const locking = agents.createPersistentAgentFromScaffoldInput({ displayName: LOCKING_ROOM, userName: "Synthetic User", preferredUserAddress: "Synthetic User" }).agent.agentId;
	// A program whose file lies in that room's own folder: the room could change it, so it can't start.
	const box = path.join(agentsRoot, locking, "runtime", "box");
	fs.mkdirSync(box, { recursive: true });
	fs.writeFileSync(path.join(box, "notes-tool"), "#!/bin/sh\nexit 1\n", { mode: 0o755 }); // portability-ok: never run, the room's folder holding it is what refuses its start
	fs.writeFileSync(path.join(agentDir, "mcp.json"), JSON.stringify({ mcpServers: {
		[C.wiki.id]: { displayName: C.wiki.name, url: at("/wiki/mcp") },
		[C.board.id]: { displayName: C.board.name, url: at("/board/mcp") },
		[C.ticket.id]: { displayName: C.ticket.name, url: NOWHERE },
		[C.slow.id]: { displayName: C.slow.name, url: NOWHERE },
		[C.calendar.id]: { displayName: C.calendar.name, url: at("/calendar/mcp") },
		[C.chat.id]: { displayName: C.chat.name, url: at("/chat/mcp") },
		[C.tracker.id]: { displayName: C.tracker.name, url: at("/tracker/mcp") },
		[C.notes.id]: { displayName: C.notes.name, url: at("/notes/mcp") },
		[C.office.id]: { displayName: C.office.name, command: "never-started-connector", args: ["--stdio"] },
		[C.node.id]: { displayName: C.node.name, command: "npx", args: ["-y", "never-downloaded-connector"] },
		[C.locked.id]: { displayName: C.locked.name, command: path.join(box, "notes-tool") },
		[C.long.id]: { displayName: C.long.name, url: at("/wiki/mcp") },
		[C.imported.id]: { displayName: C.imported.name, command: "never-started-connector", args: ["--files"] },
	} }));
	const now = Date.now();
	fs.writeFileSync(path.join(agentDir, "mcp-connector-checks.json"), JSON.stringify({ schemaVersion: 1, checks: {
		[C.ticket.id]: { at: now, ok: false, httpStatus: 404, error: "HTTP 404" },
		[C.slow.id]: { at: now, ok: false, error: "fetch failed" },
		[C.calendar.id]: { at: now, ok: false, needsAuth: true, httpStatus: 401 },
		[C.tracker.id]: { at: now, ok: false, needsAuth: true, httpStatus: 401 },
		[C.notes.id]: { at: now, ok: false, needsAuth: true, httpStatus: 401 },
		[C.node.id]: { at: now, ok: false, error: "npx was not found", programFailure: { cause: "node-missing" } },
	} }));
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
	const key = await authedFetch(`${baseUrl}/api/auth/api-key`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ provider: "synthetic", key: "synthetic-test-key" }) });
	assert(key.ok, `saving the synthetic key: ${key.status}`);
	// Team wiki is on in two rooms.
	for (const room of [lookRoom, locking]) {
		const granted = await authedFetch(`${baseUrl}/api/persistent-agents/${room}/mcp-connectors`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "grant", name: C.wiki.id }) });
		assert(granted.ok, `Team wiki on in ${room}: ${granted.status}`);
	}
	const browser = await chromium.launch({ ignoreDefaultArgs: ["--hide-scrollbars"] });
	try {
		const failed: string[] = [];
		const only = process.env.LOOK_ROWS?.split(",");
		for (const check of [checkRulesUnderSwitch, checkOff, checkConnectorsHeader, checkConnectorRows, checkWaitingFoot, checkDirectory, checkEmptyAndFailed, checkReadOnly, checkShared, checkPictures]) {
			if (only && !only.includes(check.name)) continue;
			try {
				await check(browser);
			} catch (error) {
				failed.push(`${check.name}: ${(error as Error).message.split("\n").filter((line, i) => i === 0 || /waiting for/.test(line)).slice(0, 2).join(" ").replace(/\u001b\[\d+m/g, "")}`);
				console.log(`  FAIL ${failed.at(-1)}`);
				for (const context of browser.contexts()) { if (process.env.LOOK_SHOTS) for (const open of context.pages()) await open.screenshot({ path: path.join(process.env.LOOK_SHOTS, `fail-${check.name}.png`) }).catch(() => {}); await context.close(); }
			}
		}
		assert(failed.length === 0, `${failed.length} rows failed:\n${failed.join("\n")}`);
	} finally {
		await browser.close();
	}
	console.log("settings look connectors ui smoke passed");
} finally {
	await stopSmokeServer(server);
	model?.close();
	standIns.close();
	fs.rmSync(tempRoot, { recursive: true, force: true });
}
