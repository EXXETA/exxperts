// Settings, Connectors, in the browser at desktop and phone width, against a
// real server and real connectors on this computer: the list's line, rows
// that open each connector's own page with no "⋯" menu, what a broken one
// says on its row with its fix beside it, rows that keep their height and
// their columns in every state, the Add connector menu and its three ways,
// and a connector's page: its facts, its tools in two groups, Change address,
// Disconnect, Check connection, and Remove asked in the app's dialog with the
// rooms named. A Remove a room can't take keeps the connector whole and offers
// Try again; one that works takes it out of every room. A sign-in waits in the
// row while the person moves between the list and the page, closes Settings
// or reloads. A program added by the form is checked right after Add, and only
// then: its row says Connected with its tool count, or why it can't start, and
// Cancel while it is getting ready ends the download it started. Opening the
// list starts no program, one from another app's file included. Every
// connected row gives its tool count and leaves its documents out; a web one that fails says why nothing answered when its check can
// tell, the same after Settings is opened again, and one that wants a sign-in
// offers Connect, a 403 with no key too; one whose sign-in finds none to offer
// says only a key helps, with Change key. An ordinary web page and a
// certificate this computer doesn't trust each say so, and only something that never
// answers says it didn't answer in time. A web connector just added reads
// "Checking…" until its check ends, never Connect before it. Only a program
// that downloads at its first start is getting ready; another one is checking.
// A missing uv says so with its install link, as Node.js does, and Python by
// the name this computer lacks names the one it has. A sign-in the service
// refuses, or the person declines, says which, and one with no sign-in where
// a sign-in is wanted says only a key helps. A sign-in waits as long as the
// server's own does, and its end says it took too long. Nothing signs in anywhere: the sign-in
// routes are answered in the page, and so are the checks of the directory's
// real addresses. The programs are stand-ins written here; nothing is
// downloaded.
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import fs from "node:fs";
import { execFileSync } from "node:child_process";
import http from "node:http";
import https from "node:https";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import { fileURLToPath } from "node:url";
import { chromium, type Browser, type Page, type Route } from "playwright";
import { authedFetch, SMOKE_AUTH_TOKEN, SMOKE_SERVER_AUTH_ENV, SMOKE_SERVER_SPAWN_TREE_OPTIONS, smokeHomeEnv, stopSmokeServer, freePort, waitForServer } from "./smoke-server-process.js";
import { waitEvery } from "./smoke-wait.js";

const waitUntil = waitEvery(100);

function assert(condition: unknown, message: string): asserts condition {
	if (!condition) throw new Error(message);
}
function same(actual: unknown, expected: unknown, what: string): void {
	assert(JSON.stringify(actual) === JSON.stringify(expected), `${what}: got ${JSON.stringify(actual)}, expected ${JSON.stringify(expected)}`);
}

{
	const p = typeof chromium?.executablePath === "function" ? chromium.executablePath() : "";
	if (!p || !fs.existsSync(p)) {
		console.log("connector page ui smoke skipped (Chromium not installed)");
		process.exit(0);
	}
}

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const webServerDir = path.resolve(scriptDir, "..");
const repoRoot = path.resolve(webServerDir, "..", "..");
const port = await freePort();
const baseUrl = `http://127.0.0.1:${port}`;

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "exxperts-connector-page-"));
const tempHome = path.join(tempRoot, "home");
const agentsRoot = path.join(tempHome, ".exxperts", "app", "personalized-agents");
const agentDir = path.join(tempHome, ".exxperts", "agent");
for (const dir of [agentsRoot, agentDir]) fs.mkdirSync(dir, { recursive: true, mode: 0o700 });

// A connector program: it answers MCP on standard input and output, with as many tools as
// STAND_IN_TOOLS says, its first answer held for STAND_IN_DELAY_MS so its row's checking shows.
const standIn = path.join(tempRoot, "stand-in-notes.cjs");
fs.writeFileSync(standIn, `
const tools = Array.from({ length: Number(process.env.STAND_IN_TOOLS || 0) }, (_, i) => ({ name: "note_" + (i + 1), description: "Note " + (i + 1) + ".", inputSchema: { type: "object" } }));
let buffer = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
	buffer += chunk;
	let end;
	while ((end = buffer.indexOf("\\n")) !== -1) {
		const line = buffer.slice(0, end).trim();
		buffer = buffer.slice(end + 1);
		if (!line) continue;
		const message = JSON.parse(line);
		if (message.id === undefined) continue;
		const result = message.method === "initialize" ? { protocolVersion: message.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: "stand-in-notes", version: "1.0.0" } } : message.method === "tools/list" ? { tools } : {};
		const answer = () => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: message.id, result }) + "\\n");
		if (message.method === "initialize") setTimeout(answer, Number(process.env.STAND_IN_DELAY_MS || 0));
		else answer();
	}
});
`);
// An npm that stands in for a first download: it writes its process id and waits, as a slow download does.
// npx runs a package through it, so a connector started by npx gets ready for as long as it runs.
const standInBin = path.join(tempRoot, "stand-in-bin");
const downloadPidFile = path.join(tempRoot, "download.pid");
fs.mkdirSync(standInBin);
for (const program of ["npm", "npx"]) {
	// portability-ok: only the Cancel rows run it, and they are skipped on Windows
	fs.writeFileSync(path.join(standInBin, program), `#!/bin/sh\nif [ "$1" = "config" ]; then echo "${path.join(tempRoot, "npm-cache")}"; exit 0; fi\necho $$ > "${downloadPidFile}"\nexec /bin/sleep 600\n`, { mode: 0o755 });
}
const downloadRuns = (pid: number) => {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
};
process.env.HOME = tempHome;
process.env.USERPROFILE = tempHome;
process.env.EXXPERTS_CODING_AGENT_DIR = agentDir;
process.env.PI_CODING_AGENT_DIR = agentDir;
process.env.EXXETA_PERSISTENT_AGENTS_ROOT = agentsRoot;

const { CONNECTOR_WORDS: WORDS, lineText } = await import("../../web-ui/src/connector-rows.js");
const { CONNECTOR_REQUEST_LINES } = await import("../src/connector-form.js");
const authStore = await import("pi-mcp-adapter/mcp-auth.ts" as string);

// The connectors: each path of one server on this computer is one connector.
const TOOLS: Record<string, Array<Record<string, unknown>>> = {
	"/wiki/mcp": [
		{ name: "search_pages", description: "Search pages by the words in their title or text.", annotations: { readOnlyHint: true } },
		{ name: "get_page", description: "Read one page.", annotations: { readOnlyHint: true, destructiveHint: false } },
		{ name: "create_page", description: "Create a page in a space." },
		{ name: "wipe_space", description: "Empty a space.", annotations: { readOnlyHint: true, destructiveHint: true } },
	],
	"/board/mcp": [
		{ name: "list_papers", description: "List the board papers.", annotations: { readOnlyHint: true } },
		{ name: "file_paper", description: "File a new paper." },
	],
	"/one/mcp": [{ name: "read_menu", description: "Read the week's menu.", annotations: { readOnlyHint: true } }],
	"/docs/mcp": [
		{ name: "find_doc", description: "Find a document.", annotations: { readOnlyHint: true } },
		{ name: "file_doc", description: "File a document." },
	],
	"/none/mcp": [],
	"/notes/mcp": [
		{ name: "read_note", description: "Read one note.", annotations: { readOnlyHint: true } },
		{ name: "write_note", description: "Write a note." },
		{ name: "purge_notes", description: "Delete every note.", annotations: { destructiveHint: true } },
		{ name: "old_export", description: "Export the notes the old way." },
	],
};
/** What a connector offers to read besides its tools: a room calls each as a tool of its own. */
const RESOURCES: Record<string, Array<Record<string, unknown>>> = { "/notes/mcp": [{ uri: "notes://all", name: "notes", description: "Every note." }], "/docs/mcp": [{ uri: "docs://index", name: "index", description: "The list of documents." }] };
const connectors = http.createServer((req, res) => {
	let raw = "";
	req.on("data", (chunk) => { raw += chunk; });
	req.on("end", () => {
		const where = new URL(req.url ?? "/", "http://x").pathname;
		if (where === "/tickets/mcp") return void res.writeHead(401, { "content-type": "text/plain" }).end("sign in first");
		const tools = TOOLS[where];
		if (!tools) return void res.writeHead(404).end("not here");
		if (req.method !== "POST") return void res.writeHead(405).end();
		const message = JSON.parse(raw || "{}");
		if (message.id === undefined) return void res.writeHead(202).end();
		const result = message.method === "initialize" ? { protocolVersion: message.params?.protocolVersion, capabilities: RESOURCES[where] ? { tools: {}, resources: {} } : { tools: {} }, serverInfo: { name: "stand-in", version: "1.0.0" } }
			: message.method === "tools/list" ? { tools: tools.map((tool) => ({ inputSchema: { type: "object" }, ...tool })) }
			: message.method === "resources/list" ? { resources: RESOURCES[where] ?? [] } : {};
		res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ jsonrpc: "2.0", id: message.id, result }));
	});
});
await new Promise<void>((resolve) => connectors.listen(0, "127.0.0.1", resolve));
const at = (where: string) => `http://127.0.0.1:${(connectors.address() as AddressInfo).port}${where}`;
// A service that wants a sign-in for everything, its sign-in's own addresses included, and turns down the
// app's own registration, as the measured service did: the connection then ends with no words of its own.
const signInFirst = http.createServer((req, res) => {
	req.resume();
	req.on("end", () => void (req.url?.startsWith("/register") ? res.writeHead(400, { "content-type": "application/json" }).end('{"error":"invalid_client_metadata"}') : res.writeHead(401, { "content-type": "text/plain" }).end("sign in first")));
});
await new Promise<void>((resolve) => signInFirst.listen(0, "127.0.0.1", resolve));
// An address with nothing listening: a port that was free a moment ago.
const nothingThere = http.createServer();
await new Promise<void>((resolve) => nothingThere.listen(0, "127.0.0.1", resolve));
const closedAt = `http://127.0.0.1:${(nothingThere.address() as AddressInfo).port}/mcp`;
await new Promise<void>((resolve) => nothingThere.close(() => resolve()));

// An ordinary web page at every path; a service that turns away everyone without a key; one that takes the
// connection and never answers; and a connector behind a certificate made here, which this computer doesn't trust.
const webStandIn = async (how: http.RequestListener): Promise<{ server: http.Server; at: string }> => {
	const one = http.createServer(how);
	await new Promise<void>((resolve) => one.listen(0, "127.0.0.1", resolve));
	return { server: one, at: `http://127.0.0.1:${(one.address() as AddressInfo).port}/mcp` };
};
const webPage = await webStandIn((req, res) => void req.resume().on("end", () => res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end("<!DOCTYPE html><html><body>Welcome</body></html>")));
const forbidding = await webStandIn((req, res) => void req.resume().on("end", () => res.writeHead(403, { "content-type": "text/plain" }).end("forbidden")));
const silentDesk = await webStandIn(() => {});
let untrusted: { server: http.Server; at: string } | null = null;
{
	const folder = fs.mkdtempSync(path.join(os.tmpdir(), "exxperts-untrusted-"));
	try {
		execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", path.join(folder, "key.pem"), "-out", path.join(folder, "cert.pem"), "-days", "1", "-subj", "/CN=127.0.0.1"], { stdio: "ignore" });
		const one = https.createServer({ key: fs.readFileSync(path.join(folder, "key.pem")), cert: fs.readFileSync(path.join(folder, "cert.pem")) }, (_req, res) => void res.writeHead(200, { "content-type": "application/json" }).end("{}"));
		await new Promise<void>((resolve) => one.listen(0, "127.0.0.1", resolve));
		untrusted = { server: one as unknown as http.Server, at: `https://127.0.0.1:${(one.address() as AddressInfo).port}/mcp` };
	} catch {
		console.log("connector-page-ui-smoke: the certificate rows skipped (no openssl to make a certificate)");
	} finally {
		fs.rmSync(folder, { recursive: true, force: true });
	}
}
const standIns = [webPage.server, forbidding.server, silentDesk.server, ...(untrusted ? [untrusted.server] : [])];

let server: ChildProcessWithoutNullStreams | null = null;
let browser: Browser | null = null;

async function api(route: string, init: { method?: string; body?: unknown } = {}): Promise<{ status: number; body: any }> {
	const response = await authedFetch(`${baseUrl}${route}`, { method: init.method ?? "GET", ...(init.body === undefined ? {} : { headers: { "content-type": "application/json" }, body: JSON.stringify(init.body) }) });
	const text = await response.text();
	return { status: response.status, body: text ? JSON.parse(text) : null };
}
const statusOf = async (name: string) => ((await api("/api/mcp/status")).body.servers as Array<{ name: string }>).find((one) => one.name === name) as any;
const roomGrants = async (room: string): Promise<string[]> => (await api(`/api/persistent-agents/${room}/mcp-connectors`)).body.settings.grantedConnectors;

/** What the page asked of the routes this smoke answers itself, in order. */
const asked: string[] = [];
/** The directory's real addresses and the sign-in are never reached: their routes are answered here. */
const signIns = new Map<string, "pending" | "busy" | "too-slow" | "declined" | "refused" | "no-sign-in">();
/** A check answered once `until` settles, or after `ms`: with `answer`, else by the server itself. */
const slowChecks = new Map<string, { ms?: number; until?: Promise<unknown>; answer?: unknown }>();
async function answerInPage(page: Page): Promise<void> {
	await page.route("**/api/mcp/servers/*/login", async (route: Route) => {
		const request = route.request();
		const name = decodeURIComponent(new URL(request.url()).pathname.split("/").at(-2)!);
		asked.push(`${request.method()} login ${name}`);
		if (request.method() === "POST") {
			signIns.set(name, "pending");
			return route.fulfill({ json: { started: true } });
		}
		if (request.method() === "DELETE") {
			const was = signIns.get(name) === "pending";
			signIns.delete(name);
			return route.fulfill({ json: { cancelled: was } });
		}
		const now = signIns.get(name);
		return route.fulfill({ json: now === "pending" ? { pending: true } : now ? { pending: false, cause: now, detail: `stand-in: ${now}` } : { pending: false } });
	});
	await page.route("**/api/mcp/servers/*/test", async (route: Route) => {
		const name = decodeURIComponent(new URL(route.request().url()).pathname.split("/").at(-2)!);
		asked.push(`test ${name}`);
		const slow = slowChecks.get(name);
		if (slow) {
			await (slow.until ?? new Promise((resolve) => setTimeout(resolve, slow.ms)));
			if (slow.answer === undefined) return route.fallback().catch(() => undefined);
			return route.fulfill({ json: slow.answer }).catch(() => undefined);
		}
		// The directory's own addresses are on the internet: answered here, as an open one answers.
		if (["context7", "notion", "github"].includes(name)) return route.fulfill({ json: { ok: true, toolCount: 0, toolNames: [] } });
		return route.fallback();
	});
}

async function signIn(page: Page): Promise<void> {
	await page.goto(`${baseUrl}/auth/session?token=${SMOKE_AUTH_TOKEN}`);
	await page.locator(".persistent-agent-card").first().waitFor({ timeout: 15000 });
	const dismiss = page.locator(".whats-new-close");
	if (await dismiss.count()) await dismiss.click();
}
async function openConnectors(page: Page): Promise<void> {
	await page.locator(".product-sidebar-footer button, .home-gear, button[aria-label='Settings']").first().click();
	await page.locator(".sidebar-config-menu button, .sidebar-config-menu a").filter({ hasText: /Settings/ }).first().click();
	await page.waitForSelector(".settings-overlay", { timeout: 10000 });
	await page.locator(".settings-dialog-nav-item").filter({ hasText: /^Connectors$/ }).first().click();
	await page.locator(".connector-list .connector-item").first().waitFor({ timeout: 15000 });
}
async function closeSettings(page: Page): Promise<void> {
	await page.locator(".settings-dialog-close").click();
	await page.locator(".settings-overlay").waitFor({ state: "detached", timeout: 10000 });
}
const row = (page: Page, name: string) => page.locator(".connector-list .connector-item").filter({ has: page.locator(".connector-item-name-text", { hasText: new RegExp(`^${name}$`) }) });
/** The pane foot's strip of a connector signing in or getting ready, with its line and its Cancel. */
const footStrip = (page: Page, name: string) => page.locator(".connector-waiting-foot .connector-waiting").filter({ has: page.locator(".connector-waiting-name", { hasText: new RegExp(`^${name}$`) }) });
/** How many rooms have a connector on, as a row's line ends with it; no row here is on in more than three. */
const ROOMS_LINES = [0, 1, 2, 3].map((rooms) => WORDS.roomsInLine(rooms));
/** What a row shows: its one line under the name (without the rooms it ends with, kept apart), whether it reads as broken, its button, and, while it signs in or gets
 * ready, the pane foot's strip for it (its line and its Cancel, which the row then leaves to the foot). */
const rowRead = async (page: Page, name: string) => row(page, name).evaluate((item, roomsLines) => {
	const shown = item.querySelector(".connector-item-name-text")?.textContent;
	const strip = [...document.querySelectorAll(".connector-waiting-foot .connector-waiting")].find((one) => one.querySelector(".connector-waiting-name")?.textContent === shown);
	const button = (item.querySelector(".connector-item-slot .connector-slot-label, .connector-item-slot a") as HTMLElement | null)?.textContent ?? null;
	const line = item.querySelector(".connector-item-status")?.textContent ?? null;
	const rooms = roomsLines.find((words) => line?.endsWith(` · ${words}`)) ?? null;
	return {
		line: line !== null && rooms !== null ? line.slice(0, -` · ${rooms}`.length) : line,
		rooms,
		broken: item.querySelector(".connector-item-state")?.classList.contains("is-broken") ?? false,
		button: button ?? strip?.querySelector(".connector-slot-label")?.textContent ?? null,
		footNote: strip?.querySelector(".connector-waiting-line")?.textContent ?? null,
	};
}, ROOMS_LINES);
type RowWant = { status: string; note?: string | null; button?: string | null };
/** The statuses of a row that went wrong: its line says why in the status's place. */
const BROKEN_STATUSES: string[] = [WORDS.status.notAnswering, WORDS.status.addressNotFound, WORDS.status.cantConnect, WORDS.status.cantConnectNow, WORDS.status.needsReconnecting, WORDS.status.cantStart, WORDS.status.signInFailed, WORDS.status.cantSignIn];
/** Whether a row reads as wanted: a status and its note (undefined: any note), and its button. A row that went wrong
 * shows its note in the status's place, a connected one its status then its count, and one signing in or getting
 * ready its status, with its note and Cancel in the pane's foot. */
function rowSays(want: RowWant, now: Awaited<ReturnType<typeof rowRead>>): boolean {
	if (want.button !== undefined && now.button !== want.button) return false;
	// The rooms end the line, so a reason keeps no full stop before them.
	const stem = (text: string | null) => text?.replace(/\.$/, "") ?? null;
	if (BROKEN_STATUSES.includes(want.status)) return now.broken && (want.note === undefined || stem(now.line) === stem(want.note ?? want.status));
	if (now.broken) return false;
	if (want.status === WORDS.status.connected) {
		if (want.note === undefined) return now.line === want.status || Boolean(now.line?.startsWith(`${want.status} · `));
		return now.line === (want.note === null ? want.status : `${want.status} · ${want.note}`);
	}
	if (want.status === WORDS.status.signingIn || want.status === WORDS.status.gettingReady) return now.line === want.status && (want.note === undefined || now.footNote === want.note);
	return now.line === want.status && !want.note;
}
async function waitForRow(page: Page, name: string, want: RowWant, what: string, limitMs = 20000): Promise<void> {
	let last: unknown = null;
	try {
		await waitUntil(async () => {
			last = await rowRead(page, name);
			return rowSays(want, last as Awaited<ReturnType<typeof rowRead>>);
		}, what, limitMs);
	} catch (error) {
		throw new Error(`${(error as Error).message} (the row reads ${JSON.stringify(last)})`);
	}
}
/** Each row's height, the left edge of each of its columns and the fixed edge of its button, as drawn: a button is as
 * wide as its words, so at desktop it ends at one x, and on a phone, on a line of its own, it starts at one. */
type RowLayout = { height: number; avatar: number | null; text: number | null; note: number | null; slot: number | null };
const COLUMNS = { avatar: ".connector-avatar", text: ".connector-item-text", note: ".connector-item-note", slot: ".connector-item-slot" };
const layout = (page: Page): Promise<Record<string, RowLayout>> => page.locator(".connector-list .connector-item").evaluateAll((items, columns) => Object.fromEntries(items.map((item) => {
	const drawn: Record<string, number | null> = { height: Math.round(item.getBoundingClientRect().height) };
	for (const [column, selector] of Object.entries(columns)) {
		const found = item.querySelector(selector) as HTMLElement | null;
		// An empty button slot has no place of its own: a row whose Cancel waits in the pane's foot leaves it empty.
		const edge = column === "slot" && window.innerWidth > 760 ? "right" : "left";
		drawn[column] = found && found.offsetParent !== null && (column !== "slot" || found.childElementCount > 0) ? Math.round(found.getBoundingClientRect()[edge]) : null;
	}
	return [item.querySelector(".connector-item-name-text")?.textContent ?? "?", drawn as unknown as RowLayout];
})), COLUMNS);
async function backToList(page: Page): Promise<void> {
	await page.locator(".connector-page-back").click();
	await page.locator(".connector-list").waitFor({ timeout: 10000 });
}
async function openPage(page: Page, name: string): Promise<void> {
	await row(page, name).locator(".connector-item-hit").click();
	await page.locator(".connector-page").waitFor({ timeout: 10000 });
}
/** Whether the element's words lie inside what its scrolling pane shows. */
const wordsInView = (page: Page, selector: string) => page.locator(selector).first().evaluate((element) => {
	let pane = element.parentElement;
	while (pane && !/auto|scroll/.test(getComputedStyle(pane).overflowY)) pane = pane.parentElement;
	const words = document.createRange();
	words.selectNodeContents(element);
	const shown = words.getBoundingClientRect();
	const box = (pane ?? document.documentElement).getBoundingClientRect();
	return shown.height > 0 && shown.top >= box.top && shown.bottom <= box.bottom;
});
const fact = (page: Page, label: string) => page.locator(".connector-page .connector-fact").filter({ has: page.locator(".settings-row-label", { hasText: new RegExp(`^${label}$`) }) });
/** The Status row on a connector's page, its first: the state's words, or what went wrong in their place, its details and its step. */
const statusRow = (page: Page) => page.locator(".connector-page .connector-facts > .connector-fact-status:first-child");
const statusWords = (page: Page) => statusRow(page).locator(".connector-status-words").innerText();

try {
	// The rooms, then the server's world: four web connectors, one with an
	// expired sign-in and one signed in, a program nothing ever starts, and
	// Cursor's own connector of the same name as Team wiki, which only the
	// files can give (the add route names a new one clear of Cursor's).
	fs.writeFileSync(path.join(agentDir, "mcp.json"), JSON.stringify({ imports: ["cursor"], mcpServers: { "team-wiki": { displayName: "Team wiki", url: at("/wiki/mcp") } } }));
	fs.mkdirSync(path.join(tempHome, ".cursor"), { recursive: true });
	fs.writeFileSync(path.join(tempHome, ".cursor", "mcp.json"), JSON.stringify({ mcpServers: { "team-wiki": { url: at("/wiki/mcp") }, "cursor-notes": { command: "never-started-cursor-notes", args: ["--stdio"] } } }));
	server = spawn("npx", ["tsx", "src/index.ts"], {
		shell: process.platform === "win32",
		...SMOKE_SERVER_SPAWN_TREE_OPTIONS,
		cwd: webServerDir,
		env: smokeHomeEnv(tempHome, { PORT: String(port), ...SMOKE_SERVER_AUTH_ENV, EXXETA_HOME: repoRoot, EXXPERTS_CODING_AGENT_DIR: agentDir, EXXETA_PERSISTENT_AGENTS_ROOT: agentsRoot }) as NodeJS.ProcessEnv,
		stdio: ["ignore", "pipe", "pipe"],
	}) as unknown as ChildProcessWithoutNullStreams;
	await waitForServer(server, baseUrl, { tries: 100 });
	const rooms: string[] = [];
	for (const displayName of ["Board papers", "Monthly reporting"]) {
		const created = await api("/api/persistent-agents", { method: "POST", body: { displayName, userName: "Synthetic User", preferredUserAddress: "Synthetic User" } });
		assert(created.status >= 200 && created.status < 300, `the room ${displayName} is made: ${JSON.stringify(created.body).slice(0, 200)}`);
		rooms.push(created.body.agent.agentId);
	}
	const add = async (body: Record<string, unknown>) => {
		const added = await api("/api/mcp/servers", { method: "POST", body });
		assert(added.status >= 200 && added.status < 300, `added ${JSON.stringify(body)}: ${JSON.stringify(added.body)}`);
		return added.body.name as string;
	};
	await add({ name: "Board files", url: at("/board/mcp") });
	await add({ name: "Shared calendar", url: at("/gone/mcp") });
	await add({ name: "Ticket desk", url: at("/tickets/mcp") });
	await add({ name: "Expired desk", url: at("/tickets/mcp") });
	await add({ name: "Signed wiki", url: at("/wiki/mcp") });
	await add({ name: "Office files", commandLine: "never-started-connector --stdio" });
	await add({ name: "Menu", url: at("/one/mcp") });
	await add({ name: "Empty kit", url: at("/none/mcp") });
	await add({ name: "Closed desk", url: closedAt });
	await add({ name: "Lost desk", url: "http://exxperts-smoke-desk.invalid/mcp" });
	await add({ name: "Sign-in desk", url: `http://127.0.0.1:${(signInFirst.address() as AddressInfo).port}/mcp` });
	await add({ name: "Docs desk", url: at("/docs/mcp") });
	await add({ name: "Web page desk", url: webPage.at });
	await add({ name: "Forbidding desk", url: forbidding.at });
	await add({ name: "Silent desk", url: silentDesk.at });
	if (untrusted) await add({ name: "Untrusted desk", url: untrusted.at });
	const hour = () => Math.floor(Date.now() / 1000);
	authStore.updateTokens("expired-desk", { accessToken: "synthetic-expired", expiresAt: hour() - 3600 }, at("/tickets/mcp"));
	authStore.updateTokens("signed-wiki", { accessToken: "synthetic-valid", expiresAt: hour() + 3600 }, at("/wiki/mcp"));
	for (const room of rooms) assert((await api(`/api/persistent-agents/${room}/mcp-connectors`, { method: "PUT", body: { action: "grant", name: "team-wiki" } })).status === 200, "team-wiki is on in each room");
	assert((await api(`/api/persistent-agents/${rooms[0]}/mcp-connectors`, { method: "PUT", body: { action: "grant", name: "board-files" } })).status === 200, "board-files is on in Board papers");

	browser = await chromium.launch();
	for (const width of ["desktop", "phone"] as const) {
		const context = await browser.newContext(width === "desktop" ? { viewport: { width: 1440, height: 900 } } : { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
		asked.length = 0;
		const page = await context.newPage();
		const pageErrors: string[] = [];
		page.on("pageerror", (error) => pageErrors.push(error.message));
		await answerInPage(page);
		await signIn(page);
		await openConnectors(page);
		const where = `${width}:`;

		// The list: its line, no "⋯", rows that open a page, the rooms each is on in.
		same((await page.locator(".pane-lead").first().innerText()).trim(), lineText(WORDS.subtitle, false), `${where} the line under the title`);
		same(await page.locator(".connector-list button[aria-haspopup], .connector-list .connector-item-more").count(), 0, `${where} no row has a "⋯" menu`);
		same((await rowRead(page, "Team wiki")).rooms, WORDS.roomsInLine(2), `${where} Team wiki's line ends on in 2 rooms`);
		// Only what takes the connection and never answers didn't answer in time, once its 20 s are up. The list is
		// read again once every check behind it has ended, so the rows that show what it read are looked at after this one.
		await waitForRow(page, "Silent desk", { status: WORDS.status.notAnswering, note: WORDS.wentWrong.noAnswer.fact, button: WORDS.button.tryAgain }, `${where} an address that never answers didn't answer in time`, 45000);
		await waitForRow(page, "Shared calendar", { status: WORDS.status.cantConnect, note: WORDS.wentWrong.addressNotFound.fact, button: WORDS.button.changeAddress }, `${where} a web address that wasn't found says so on its row, with Change address`);
		await waitForRow(page, "Expired desk", { status: WORDS.status.needsReconnecting, note: null, button: WORDS.button.reconnect }, `${where} an expired sign-in says so, with Reconnect`);
		await waitForRow(page, "Team wiki", { status: WORDS.status.connected, note: WORDS.toolCount(4), button: null }, `${where} a connector that answers reads Connected, with its tool count`);
		same(WORDS.toolCount(4), "4 tools", "the count's words");
		await waitForRow(page, "Menu", { status: WORDS.status.connected, note: "1 tool", button: null }, `${where} one tool is counted as one`);
		await waitForRow(page, "Empty kit", { status: WORDS.status.connected, note: "No tools", button: null }, `${where} none says so`);
		// Why nothing answered, when the check can tell, with Try again on the row and Change address on its page.
		await waitForRow(page, "Closed desk", { status: WORDS.status.notAnswering, note: WORDS.wentWrong.nothingThere.fact, button: WORDS.button.tryAgain }, `${where} nothing listening at its address says so`);
		await waitForRow(page, "Lost desk", { status: WORDS.status.addressNotFound, note: WORDS.wentWrong.nameNotFound.fact, button: WORDS.button.tryAgain }, `${where} a web address whose name isn't found says so`);
		// A row never checked reads the same, so the row is read once its check has ended.
		await waitUntil(async () => (await statusOf("sign-in-desk"))?.lastCheck?.needsAuth === true, `${where} the sign-in desk's check ends wanting a sign-in`);
		await waitForRow(page, "Sign-in desk", { status: WORDS.status.notConnected, note: null, button: WORDS.button.connect }, `${where} a service that wants a sign-in reads Not connected, with Connect`);
		// Two tools and one document: the row counts the tools alone.
		await waitForRow(page, "Docs desk", { status: WORDS.status.connected, note: "2 tools", button: null }, `${where} a connector's line leaves its documents out`);
		// Something that answered, but not as a connector, or wasn't used: its own line, with Change address and no Try again.
		await waitForRow(page, "Web page desk", { status: WORDS.status.cantConnect, note: WORDS.wentWrong.webPage.fact, button: WORDS.button.changeAddress }, `${where} an address that leads to a web page says so, with Change address`);
		// Its line says nothing to change, so its page's steps stand on their own rows.
		await openPage(page, "Web page desk");
		same([await statusWords(page), await statusRow(page).getByRole("button").allInnerTexts(), await fact(page, WORDS.details.address).getByRole("button").allInnerTexts()], [lineText(WORDS.wentWrong.webPage, false), [WORDS.button.checkConnection], [WORDS.button.changeAddress]], `${where} an address that leads to a web page: Check connection in the Status row, Change address on its own`);
		await backToList(page);
		if (untrusted) await waitForRow(page, "Untrusted desk", { status: WORDS.status.cantConnect, note: WORDS.wentWrong.untrustedCertificate.fact, button: WORDS.button.changeAddress }, `${where} an address this computer doesn't trust says so, with Change address`);
		// A 403 with no key, never signed in, wants a sign-in as a 401 does; one that finds none to offer, after Connect,
		// says only a key helps, with Change key, which opens its key in place.
		await waitUntil(async () => (await statusOf("forbidding-desk"))?.lastCheck?.httpStatus === 403, `${where} the forbidding desk's check ends`);
		await waitForRow(page, "Forbidding desk", { status: WORDS.status.notConnected, note: null, button: WORDS.button.connect }, `${where} a 403 with no key reads Not connected, with Connect`);
		const forbiddingSignIns = asked.filter((one) => one === "POST login forbidding-desk").length;
		await row(page, "Forbidding desk").getByRole("button", { name: WORDS.button.connect, exact: true }).click();
		await waitUntil(async () => asked.filter((one) => one === "POST login forbidding-desk").length === forbiddingSignIns + 1, `${where} Connect asks the forbidding desk for a sign-in`);
		signIns.set("forbidding-desk", "no-sign-in");
		await waitForRow(page, "Forbidding desk", { status: WORDS.status.cantSignIn, note: WORDS.signInFailed.wantsKeyAdd.fact, button: WORDS.button.changeKey }, `${where} a 403 that offers no sign-in says only a key helps, with Change key`);
		assert(!(await rowRead(page, "Forbidding desk")).line?.includes("likely works without one"), `${where} it never says it likely works without one`);
		await row(page, "Forbidding desk").getByRole("button", { name: WORDS.button.changeKey, exact: true }).click();
		const keyField = page.locator(".connector-page .connector-edit input[type=password]");
		await keyField.waitFor();
		assert(await keyField.evaluate((field) => field === document.activeElement), `${where} Change key opens its page with the key field ready`);
		same(await statusWords(page), lineText(WORDS.signInFailed.wantsKeyAdd, false), `${where} its page says to add a key`);
		await page.locator(".connector-page .connector-edit").getByRole("button", { name: WORDS.button.cancel, exact: true }).click();
		// A first key has its Key row: its button there alone, and Check connection in the Status row.
		same([await statusRow(page).getByRole("button").allInnerTexts(), await fact(page, WORDS.details.key).getByRole("button").allInnerTexts(), await page.locator(".connector-page").getByRole("button", { name: WORDS.button.changeKey, exact: true }).count()], [[WORDS.button.checkConnection], [WORDS.button.changeKey], 1], `${where} a first key: Change key on the Key row, Check connection in the Status row, each once`);
		await backToList(page);
		signIns.delete("forbidding-desk");
		// Settings closed and opened again: each row reads its kept check while the next check is held.
		const heldAgain: Array<() => void> = [];
		for (const [id, reach] of [["closed-desk", "nothing-there"], ["lost-desk", "name-not-found"]]) {
			let release = () => {};
			slowChecks.set(id, { until: new Promise<void>((resolve) => { release = resolve; }), answer: { ok: false, reach, error: "held" } });
			heldAgain.push(release);
		}
		await closeSettings(page);
		await openConnectors(page);
		await waitUntil(async () => asked.filter((one) => one === "test closed-desk").length >= 2 && asked.filter((one) => one === "test lost-desk").length >= 2, `${where} the reopened list checks both again`);
		await waitForRow(page, "Closed desk", { status: WORDS.status.notAnswering, note: WORDS.wentWrong.nothingThere.fact, button: WORDS.button.tryAgain }, `${where} after Settings is opened again, nothing listening still says so`);
		await waitForRow(page, "Lost desk", { status: WORDS.status.addressNotFound, note: WORDS.wentWrong.nameNotFound.fact, button: WORDS.button.tryAgain }, `${where} after Settings is opened again, a name not found still says so`);
		for (const id of ["closed-desk", "lost-desk"]) slowChecks.delete(id);
		for (const release of heldAgain) release();
		for (const [name, said] of [["Closed desk", WORDS.wentWrong.nothingThere], ["Lost desk", WORDS.wentWrong.nameNotFound]] as const) {
			await openPage(page, name);
			same(await statusWords(page), lineText(said, false), `${where} ${name}'s page says what went wrong in full`);
			same(await page.locator(".connector-page").getByRole("button", { name: WORDS.button.changeAddress, exact: true }).count(), 1, `${where} ${name}'s page offers Change address beside it`);
			await backToList(page);
		}
		await waitForRow(page, "Office files", { status: WORDS.status.program, note: null, button: WORDS.button.checkConnection }, `${where} a program never checked reads as one, unstarted, with no count and Check connection`);
		await waitForRow(page, "cursor-notes", { status: WORDS.status.program, note: null, button: WORDS.button.checkConnection }, `${where} so does one from another app's file`);
		assert(!asked.includes("test office-files") && !asked.includes("test cursor-notes"), `${where} opening the list starts no program, one from another app's file included`);
		const idle = await layout(page);
		// On a desktop every row has one height, with or without a button. On a phone the name's line and the status's
		// lines stand in 64 px, each line more of the status 18, and a button a line of its own under them.
		const heights = (withButton: boolean) => [...new Set(Object.values(idle).filter((one) => (one.slot !== null) === withButton).map((one) => one.height))];
		const [withButton, bare] = [heights(true), heights(false)];
		const phoneSize = (one: RowLayout) => (one.height - (one.slot === null ? 64 : 116)) % 18 === 0 && one.height >= (one.slot === null ? 64 : 116);
		if (width === "desktop") {
			same([withButton.length, bare.length], [1, 1], `${where} every row with a button has one height, and every row without one (${JSON.stringify(idle)})`);
			same(withButton, bare, `${where} a row with a button as tall as one without`);
		} else same(Object.entries(idle).filter(([, one]) => !phoneSize(one)), [], `${where} every row 64 tall, each more line of its status 18, its button a line of its own`);
		/** Every row as it was, one named in `changed` too but for its words wrapping on a phone; a row named `inFoot`
		 * signs in or gets ready, so its button has gone to the pane's foot. */
		const sameLayout = async (what: string, changed: string[] = [], inFoot?: string) => {
			const now = await layout(page);
			for (const [name, before] of Object.entries(idle)) {
				const want = name === inFoot ? { ...before, slot: null, height: bare[0] } : before;
				if (width === "phone" && (changed.includes(name) || name === inFoot)) {
					assert(phoneSize(now[name]), `${where} ${name}'s height ${what}, got ${JSON.stringify(now[name])}`);
					same({ ...now[name], height: null }, { ...want, height: null }, `${where} ${name}'s columns ${what}`);
				} else same(now[name], want, `${where} ${name}'s height and columns ${what}`);
			}
		};

		// Change address on the row opens the connector's page with its address field.
		await row(page, "Shared calendar").getByRole("button", { name: WORDS.button.changeAddress, exact: true }).click();
		await page.locator(".connector-page .connector-edit-input").first().waitFor();
		same(await page.locator(".connector-page h2").innerText(), "Shared calendar", `${where} Change address opens Shared calendar's page`);
		assert(await page.locator(".connector-page .connector-edit-input").first().evaluate((input) => input === document.activeElement), `${where} the address field has the focus`);
		await page.locator(".connector-page .connector-edit-foot").getByRole("button", { name: WORDS.button.cancel, exact: true }).click();
		same(await statusWords(page), lineText(WORDS.wentWrong.addressNotFound, false), `${where} the page says what went wrong in full`);
		// The sentence names the step: the Status row's button, with Check connection after the words, each once on the page.
		const stepsOf = async (label: string) => [await statusRow(page).getByRole("button").allInnerTexts(), await fact(page, label).getByRole("button").allInnerTexts()];
		same(await stepsOf(WORDS.details.address), [[WORDS.button.checkConnection, WORDS.button.changeAddress], []], `${where} an address not found: Check connection after the words, Change address the Status row's button, none on the address's row`);
		for (const words of [WORDS.button.changeAddress, WORDS.button.checkConnection]) same(await page.locator(".connector-page").getByRole("button", { name: words, exact: true }).count(), 1, `${where} ${words} shows once`);
		// Its edit open, its button steps aside and the check stays.
		await statusRow(page).getByRole("button", { name: WORDS.button.changeAddress, exact: true }).click();
		await page.locator(".connector-page .connector-edit-input").first().waitFor();
		same(await statusRow(page).getByRole("button").allInnerTexts(), [WORDS.button.checkConnection], `${where} while the address is edited: Check connection alone in the Status row`);
		await page.locator(".connector-page .connector-edit-foot").getByRole("button", { name: WORDS.button.cancel, exact: true }).click();
		// The service put right, Check connection finds it, with no change here; gone again, it says so again.
		TOOLS["/gone/mcp"] = TOOLS["/board/mcp"];
		await statusRow(page).getByRole("button", { name: WORDS.button.checkConnection, exact: true }).click();
		await waitUntil(async () => (await statusWords(page)) === WORDS.status.connected, `${where} Check connection checks again: the page says Connected`);
		delete TOOLS["/gone/mcp"];
		await statusRow(page).getByRole("button", { name: WORDS.button.checkConnection, exact: true }).click();
		await waitUntil(async () => (await statusWords(page)) === lineText(WORDS.wentWrong.addressNotFound, false), `${where} Check connection finds it gone again`);
		await backToList(page);
		await sameLayout("after another row's page was opened");

		// A sign-in in progress: the row's line says where to go, and the row keeps its size.
		await row(page, "Ticket desk").getByRole("button", { name: WORDS.button.connect, exact: true }).click();
		await waitForRow(page, "Ticket desk", { status: WORDS.status.signingIn, note: WORDS.signingInNote, button: WORDS.button.cancel }, `${where} Connect leaves the row signing in`);
		await sameLayout("while one signs in", [], "Ticket desk");
		// It waits while the person opens its page and comes back, ...
		await openPage(page, "Ticket desk");
		same(await statusWords(page), WORDS.status.signingIn, `${where} its page says it is signing in`);
		assert((await statusRow(page).innerText()).includes(WORDS.signingInNote), `${where} its page says where to sign in`);
		await backToList(page);
		await waitForRow(page, "Ticket desk", { status: WORDS.status.signingIn }, `${where} back on the list it still signs in`);
		// ... closes Settings and opens it again, ...
		await closeSettings(page);
		await openConnectors(page);
		await waitForRow(page, "Ticket desk", { status: WORDS.status.signingIn, button: WORDS.button.cancel }, `${where} after Settings closed and opened, it still signs in`);
		// ... and reloads; then Cancel on its page ends it.
		await page.reload();
		await page.locator(".persistent-agent-card").first().waitFor({ timeout: 15000 });
		await openConnectors(page);
		await waitForRow(page, "Ticket desk", { status: WORDS.status.signingIn }, `${where} after a reload, it still signs in`);
		await openPage(page, "Ticket desk");
		const cancels = asked.filter((one) => one === "DELETE login ticket-desk").length;
		await statusRow(page).getByRole("button", { name: WORDS.button.cancel, exact: true }).click();
		await waitUntil(async () => asked.filter((one) => one === "DELETE login ticket-desk").length === cancels + 1, `${where} Cancel on the page ends the sign-in`);
		await backToList(page);
		await waitForRow(page, "Ticket desk", { status: WORDS.status.notConnected, button: WORDS.button.connect }, `${where} after Cancel the row offers Connect again`);
		// The person's own No reads as theirs, with Try again; a refusal trying again can't change, with none, and with
		// Change key, as this one added by its address with no key takes its first key there.
		for (const [cause, want] of [
			["declined", { status: WORDS.status.signInFailed, note: WORDS.signInFailed.declined.fact, button: WORDS.button.tryAgain }],
			["refused", { status: WORDS.status.cantSignIn, note: WORDS.signInFailed.refusedKeyInPlace.fact, button: WORDS.button.changeKey }],
			// No sign-in where its check found one wanted: only a key can help, given in place.
			["no-sign-in", { status: WORDS.status.cantSignIn, note: "It wants a sign-in or a key, and doesn't offer a sign-in here.", button: WORDS.button.changeKey }],
		] as const) {
			// One with no Try again offers Connect again only on a fresh opening of Settings, which forgets the failed sign-in.
			if ((await rowRead(page, "Ticket desk")).button === WORDS.button.changeKey) {
				await closeSettings(page);
				await openConnectors(page);
			}
			const pressed = asked.filter((one) => one === "POST login ticket-desk").length;
			signIns.delete("ticket-desk");
			await row(page, "Ticket desk").getByRole("button", { name: WORDS.button.tryAgain, exact: true }).or(row(page, "Ticket desk").getByRole("button", { name: WORDS.button.connect, exact: true })).click();
			await waitUntil(async () => asked.filter((one) => one === "POST login ticket-desk").length === pressed + 1, `${where} the sign-in starts again (${cause})`);
			signIns.set("ticket-desk", cause);
			await waitForRow(page, "Ticket desk", want, `${where} a sign-in that ends ${cause} says so`);
		}
		await closeSettings(page);
		await openConnectors(page);
		// A sign-in that fails says so on the row, at the same size.
		const started = asked.filter((one) => one === "POST login ticket-desk").length;
		await row(page, "Ticket desk").getByRole("button", { name: WORDS.button.connect, exact: true }).click();
		// Failed only once it has started, so the start can't mark it waiting again.
		await waitUntil(async () => asked.filter((one) => one === "POST login ticket-desk").length === started + 1, `${where} Connect asks for the sign-in`);
		signIns.set("ticket-desk", "busy");
		await waitForRow(page, "Ticket desk", { status: WORDS.status.signInFailed, note: WORDS.wentWrong.busy.fact, button: WORDS.button.tryAgain }, `${where} a failed sign-in says so with Try again`);
		await sameLayout("after a sign-in fails", ["Ticket desk"]);
		// Removed and added again by the same name, it starts afresh: nothing of the old one's sign-in shows.
		await openPage(page, "Ticket desk");
		await page.locator(".connector-remove-group").getByRole("button", { name: WORDS.button.remove, exact: true }).click();
		await page.locator(".confirm-dialog-backdrop").getByRole("button", { name: WORDS.button.remove, exact: true }).click();
		await page.locator(".connector-list").waitFor();
		await waitUntil(async () => (await row(page, "Ticket desk").count()) === 0, `${where} Ticket desk is removed`);
		await page.locator(".pane-head-actions").getByRole("button", { name: WORDS.addConnector, exact: true }).click();
		await page.getByRole("menuitem", { name: WORDS.addWays.web }).click();
		const again = page.locator(".connector-custom-form");
		await again.locator(".connector-form-field", { hasText: WORDS.form.name }).locator("input").fill("Ticket desk");
		await again.locator(".connector-form-field", { hasText: WORDS.form.address }).locator("input").fill(at("/tickets/mcp"));
		await again.getByRole("button", { name: WORDS.form.add, exact: true }).click();
		await waitForRow(page, "Ticket desk", { status: WORDS.status.notConnected, note: null, button: WORDS.button.connect }, `${where} added again, it offers Connect, not the old failed sign-in`);
		signIns.delete("ticket-desk");

		// A program's check getting ready, then failing for want of Node.js: the row's line and fix, at the same size.
		// Held until the getting-ready row is measured, however slow the runner.
		let release = () => {};
		slowChecks.set("office-files", { until: new Promise<void>((resolve) => { release = resolve; }), answer: { ok: false, error: "spawn npx ENOENT", programFailure: { cause: "runtime-missing", runtime: "node" } } });
		await openPage(page, "Office files");
		same(await fact(page, WORDS.details.runs).locator(".connector-fact-value").innerText(), WORDS.details.runsHere, `${where} a program runs on this computer, as you`);
		assert((await fact(page, WORDS.details.runs).innerText()).includes("never-started-connector --stdio"), `${where} its command is shown`);
		same(await page.locator(".connector-tools-group .cli-note").innerText(), WORDS.tools.notChecked, `${where} a program never checked shows no tools`);
		assert(!asked.includes("test office-files"), `${where} opening a program's page starts nothing`);
		await statusRow(page).getByRole("button", { name: WORDS.button.checkConnection, exact: true }).click();
		await backToList(page);
		// A program that downloads nothing first is checking, with the pressed Check connection busy in its place.
		await waitForRow(page, "Office files", { status: WORDS.status.checking, note: null, button: WORDS.button.checkConnection }, `${where} a slow program that downloads nothing first is checking`);
		await sameLayout("while a program is checked", ["Ticket desk", "Office files"]);
		release();
		await waitForRow(page, "Office files", { status: WORDS.status.cantStart, note: WORDS.wentWrong.nodeMissing.fact, button: WORDS.button.install }, `${where} a program without Node.js says so, with How to install it`);
		same(await row(page, "Office files").locator(".connector-item-slot a").getAttribute("href"), "https://nodejs.org/en/download", `${where} its link is Node.js's`);
		same(await row(page, "Office files").locator(".connector-item-slot a, .connector-item-slot .connector-slot-label").allInnerTexts(), [WORDS.button.install], `${where} the row has room for How to install it alone`);
		await sameLayout("after a program can't start", ["Ticket desk", "Office files"]);
		await openPage(page, "Office files");
		same(await statusRow(page).locator("a, .connector-slot-label").allInnerTexts(), [WORDS.button.install, WORDS.button.tryAgain], `${where} its page offers How to install it, then Try again, beside the line`);
		same(await page.locator(".connector-tools-group .cli-note").innerText(), WORDS.tools.notConnected, `${where} after a failed check its tools wait for it to connect, not for another check`);
		await backToList(page);
		slowChecks.delete("office-files");

		// The Add connector menu, and its three ways.
		const addButton = page.locator(".pane-head-actions").getByRole("button", { name: WORDS.addConnector, exact: true });
		await addButton.click();
		same(await page.locator(".ai-profile-menu [role=menuitem]").allInnerTexts(), [WORDS.addWays.directory, WORDS.addWays.web, WORDS.addWays.program], `${where} the menu's three ways`);
		await page.keyboard.press("Escape");
		await page.locator(".ai-profile-menu").waitFor({ state: "detached" });
		assert(await page.locator(".settings-overlay").isVisible(), `${where} Escape closes the menu only`);
		await addButton.click();
		await page.getByRole("menuitem", { name: WORDS.addWays.directory }).click();
		await waitUntil(() => page.locator(".connector-dir-search").evaluate((input) => input === document.activeElement), `${where} From the directory goes to the directory's search`);

		await addButton.click();
		await page.getByRole("menuitem", { name: WORDS.addWays.web }).click();
		const webForm = page.locator(".connector-custom-form");
		// Each width adds its own, so the phone's isn't found as the desktop's.
		const webAdded = width === "desktop" ? { name: "Board files two", id: "board-files-two" } : { name: "Board files three", id: "board-files-three" };
		same(await webForm.locator(".pane-head h2").innerText(), WORDS.form.webTitle, `${where} the web form's title`);
		same(await webForm.locator(".connector-form-field > span").allInnerTexts(), [WORDS.form.name, WORDS.form.address], `${where} the web form asks a name and a web address`);
		same(await webForm.locator(".connector-oauth-toggle").getAttribute("aria-expanded"), "false", `${where} the key, headers and own sign-in app are folded away`);
		same((await webForm.locator(".connector-oauth-toggle").innerText()).trim(), WORDS.form.more, `${where} the fold's words`);
		await webForm.locator(".connector-form-field", { hasText: WORDS.form.name }).locator("input").fill(webAdded.name);
		await webForm.locator(".connector-form-field", { hasText: WORDS.form.address }).locator("input").fill(at("/board/mcp"));
		same(await webForm.locator(".connector-form-line").allInnerTexts(), [WORDS.form.signInLater, WORDS.form.trustWeb(new URL(at("/")).host)], `${where} the web form's two lines, with where a room's words go`);
		await webForm.locator(".connector-oauth-toggle").click();
		assert(await webForm.locator(".connector-form-field", { hasText: WORDS.form.key }).isVisible() && await webForm.getByText(WORDS.form.signInApp, { exact: true }).isVisible() && await webForm.getByText(WORDS.form.headers, { exact: true }).isVisible(), `${where} the fold holds the key, the own sign-in app and the headers`);
		// Its check held until the row is read, then answered by the server.
		let releaseWeb = () => {};
		slowChecks.set(webAdded.id, { until: new Promise<void>((resolve) => { releaseWeb = resolve; }) });
		await webForm.getByRole("button", { name: WORDS.form.add, exact: true }).click();
		await webForm.waitFor({ state: "detached", timeout: 10000 });
		await row(page, webAdded.name).waitFor();
		assert(await statusOf(webAdded.id), `${where} the web form adds it`);
		// Checked right after Add: "Checking…" with nothing to press, never Not connected with Connect. Should it offer Connect,
		// a sign-in that fails meanwhile must not outlast the check that connects.
		const whileChecked = await rowRead(page, webAdded.name);
		if (whileChecked.button === WORDS.button.connect) {
			await row(page, webAdded.name).getByRole("button", { name: WORDS.button.connect, exact: true }).click();
			signIns.set(webAdded.id, "busy");
			await waitForRow(page, webAdded.name, { status: WORDS.status.signInFailed, note: WORDS.wentWrong.busy.fact }, `${where} the sign-in it offered fails`);
		}
		assert(rowSays({ status: WORDS.status.checking, note: null, button: null }, whileChecked), `${where} a web connector just added reads Checking… with nothing to press, got ${JSON.stringify(whileChecked)}`);
		same(await page.locator(".connector-list-section > .connector-notice").allInnerTexts(), [], `${where} no notice while it is checked`);
		releaseWeb();
		await waitForRow(page, webAdded.name, { status: WORDS.status.connected, note: WORDS.toolCount(2), button: null }, `${where} then reads Connected with its tool count`);
		same(await page.locator(".connector-list-section > .connector-notice").allInnerTexts(), [WORDS.addedCustom(webAdded.name)], `${where} and the notice says it was added`);
		same(asked.filter((one) => one === `test ${webAdded.id}`).length, 1, `${where} it was checked once`);
		slowChecks.delete(webAdded.id);
		signIns.delete(webAdded.id);

		await addButton.click();
		await page.getByRole("menuitem", { name: WORDS.addWays.program }).click();
		const programForm = page.locator(".connector-custom-form");
		same(await programForm.locator(".pane-head h2").innerText(), WORDS.form.programTitle, `${where} the program form's title`);
		same(await programForm.locator(".connector-form-field > span").allInnerTexts(), [WORDS.form.name, WORDS.form.command, WORDS.form.commandHint, WORDS.form.settings], `${where} the program form asks a name, its command and its settings`);
		same(await programForm.locator(".connector-form-line").allInnerTexts(), [WORDS.form.trustProgram, WORDS.form.programChecked], `${where} the program's one warning, and that Add starts it once`);
		await programForm.getByRole("button", { name: WORDS.form.cancel, exact: true }).click();

		/** Adds a program by the form, its settings typed one row each, with nothing pressed after Add. */
		const addProgram = async (name: string, command: string, settings: Record<string, string> = {}) => {
			await addButton.click();
			await page.getByRole("menuitem", { name: WORDS.addWays.program }).click();
			const form = page.locator(".connector-custom-form");
			await form.locator(".connector-form-field", { hasText: WORDS.form.name }).locator("input").fill(name);
			await form.locator(".connector-form-field", { hasText: WORDS.form.command }).locator("input").fill(command);
			for (const [index, [setting, value]] of Object.entries(settings).entries()) {
				if (index > 0) await form.getByRole("button", { name: WORDS.form.addSetting, exact: true }).click();
				await form.getByRole("textbox", { name: WORDS.form.settingName(index + 1), exact: true }).fill(setting);
				await form.getByLabel(WORDS.form.settingValue(index + 1), { exact: true }).fill(value);
			}
			await form.getByRole("button", { name: WORDS.form.add, exact: true }).click();
			await form.waitFor({ state: "detached", timeout: 10000 });
		};
		const notice = () => page.locator(".connector-list-section > .connector-notice").allInnerTexts();

		// A program that works: checked right after Add, its row reads Checking…, then Connected with its tool count, and the notice follows.
		const works = { name: `Notes program ${width}`, id: `notes-program-${width}`, tools: width === "desktop" ? 2 : 1 };
		await addProgram(works.name, `node ${standIn}`, { STAND_IN_TOOLS: String(works.tools), STAND_IN_DELAY_MS: "1500" });
		await waitForRow(page, works.name, { status: WORDS.status.checking, note: null, button: null }, `${where} a program just added is checked with no further press`);
		same(await notice(), [], `${where} no notice while it is checked`);
		await waitForRow(page, works.name, { status: WORDS.status.connected, note: WORDS.toolCount(works.tools), button: null }, `${where} then reads Connected with its tool count`);
		same(await notice(), [WORDS.addedCustom(works.name)], `${where} and the notice says it was added`);
		same(asked.filter((one) => one === `test ${works.id}`).length, 1, `${where} it was checked once`);

		// A program started by uvx downloads at its first start: past a few seconds it is getting ready, with Cancel.
		// Its check ends finding no uv: it says so, with uv's own install link.
		const uvx = { name: `Markdown ${width}`, id: `markdown-${width}` };
		let releaseUvx = () => {};
		slowChecks.set(uvx.id, { until: new Promise<void>((resolve) => { releaseUvx = resolve; }), answer: { ok: false, error: "spawn uvx ENOENT", programFailure: { cause: "runtime-missing", runtime: "uv" } } });
		await addProgram(uvx.name, "uvx markitdown-mcp");
		await waitForRow(page, uvx.name, { status: WORDS.status.gettingReady, note: WORDS.gettingReadyNote, button: WORDS.button.cancel }, `${where} a program started by uvx is getting ready, with Cancel`);
		releaseUvx();
		await waitForRow(page, uvx.name, { status: WORDS.status.cantStart, note: WORDS.wentWrong.uvMissing.fact, button: WORDS.button.install }, `${where} a program without uv says so, with How to install it`);
		same(await row(page, uvx.name).locator(".connector-item-slot a").getAttribute("href"), "https://docs.astral.sh/uv/getting-started/installation/", `${where} its link is uv's`);
		// The row has room for the link alone, as for Node.js; once uv is installed its page takes the person on: the link first, then Try again.
		same(await row(page, uvx.name).locator(".connector-item-slot a, .connector-item-slot .connector-slot-label").allInnerTexts(), [WORDS.button.install], `${where} the row has room for How to install it alone`);
		await openPage(page, uvx.name);
		same(await statusRow(page).locator("a, .connector-slot-label").allInnerTexts(), [WORDS.button.install, WORDS.button.tryAgain], `${where} the page offers How to install it, then Try again, beside the line`);
		slowChecks.set(uvx.id, { ms: 0, answer: { ok: true, toolCount: 1, toolNames: ["convert"] } });
		await statusRow(page).getByRole("button", { name: WORDS.button.tryAgain, exact: true }).click();
		await backToList(page);
		await waitForRow(page, uvx.name, { status: WORDS.status.connected, button: null }, `${where} with uv installed, Try again on its page connects it`);
		slowChecks.delete(uvx.id);
		// Python by a name this computer doesn't have: the row names the one it has, with Remove to add it again.
		const python = { name: `Python tool ${width}`, id: `python-tool-${width}` };
		slowChecks.set(python.id, { ms: 0, answer: { ok: false, error: "spawn python ENOENT", programFailure: { cause: "python-is-python3", found: "python3" } } });
		await addProgram(python.name, "python -m markitdown_mcp");
		await waitForRow(page, python.name, { status: WORDS.status.cantStart, note: WORDS.wentWrong.pythonOtherName("python3", "python").fact, button: WORDS.button.remove }, `${where} python where only python3 is says so, with Remove`);
		same(WORDS.wentWrong.pythonOtherName("python3", "python").fact, 'This computer has Python as "python3", not "python".', "the Python line's words");
		slowChecks.delete(python.id);

		// Programs that can't start: each kept, its row says why with its way on, and no notice.
		const missing = { name: `Missing notes ${width}`, id: `missing-notes-${width}` };
		await addProgram(missing.name, "never-installed-notes --stdio");
		await waitForRow(page, missing.name, { status: WORDS.status.cantStart, note: WORDS.wentWrong.programMissing("never-installed-notes").fact, button: WORDS.button.tryAgain }, `${where} a program that isn't there says so, with Try again`);
		same(await notice(), [], `${where} no notice after it failed`);
		assert(await statusOf(missing.id), `${where} the connector is kept`);
		const stops = { name: `Stopping notes ${width}`, id: `stopping-notes-${width}` };
		await addProgram(stops.name, "node -e process.exit(3)");
		await waitForRow(page, stops.name, { status: WORDS.status.cantStart, note: WORDS.wentWrong.programStopped.fact, button: WORDS.button.tryAgain }, `${where} a program that stops at once says so, with Try again`);
		same(await notice(), [], `${where} no notice after it failed`);
		assert(await statusOf(stops.id), `${where} the connector is kept`);

		// Cancel while it is getting ready: the download it started ends, nothing of the check is kept, and the row offers Check connection, which checks it.
		if (width === "desktop" && process.platform !== "win32") {
			const slow = { name: "Slow notes", id: "slow-notes" };
			fs.rmSync(downloadPidFile, { force: true });
			await addProgram(slow.name, "npx -y stand-in-notes-package", { PATH: `${standInBin}:/usr/bin:/bin` });
			await waitForRow(page, slow.name, { status: WORDS.status.gettingReady, note: WORDS.gettingReadyNote, button: WORDS.button.cancel }, `${where} a program that downloads first is getting ready, with Cancel`);
			await waitUntil(async () => fs.existsSync(downloadPidFile) && fs.readFileSync(downloadPidFile, "utf8").trim() !== "", `${where} its download has started`);
			const download = Number(fs.readFileSync(downloadPidFile, "utf8").trim());
			assert(downloadRuns(download), `${where} the download runs`);
			await footStrip(page, slow.name).getByRole("button", { name: WORDS.button.cancel, exact: true }).click();
			await waitUntil(async () => !downloadRuns(download), `${where} Cancel ends the download`);
			await waitForRow(page, slow.name, { status: WORDS.status.program, note: null, button: WORDS.button.checkConnection }, `${where} after Cancel the row reads as a program never checked, with Check connection`);
			same(await notice(), [], `${where} no notice after Cancel`);
			const kept = await statusOf(slow.id);
			assert(kept && kept.lastCheck === null && kept.tools === null, `${where} the connector is kept, and nothing of the check: ${JSON.stringify({ lastCheck: kept?.lastCheck, tools: kept?.tools })}`);
			fs.rmSync(downloadPidFile, { force: true });
			const checked = asked.filter((one) => one === `test ${slow.id}`).length;
			await row(page, slow.name).getByRole("button", { name: WORDS.button.checkConnection, exact: true }).click();
			await waitUntil(async () => asked.filter((one) => one === `test ${slow.id}`).length === checked + 1, `${where} Check connection on the row checks it`);
			await waitForRow(page, slow.name, { status: WORDS.status.gettingReady, button: WORDS.button.cancel }, `${where} and it gets ready again`);
			await waitUntil(async () => fs.existsSync(downloadPidFile) && fs.readFileSync(downloadPidFile, "utf8").trim() !== "", `${where} its download has started again`);
			const again = Number(fs.readFileSync(downloadPidFile, "utf8").trim());
			await footStrip(page, slow.name).getByRole("button", { name: WORDS.button.cancel, exact: true }).click();
			await waitUntil(async () => !downloadRuns(again), `${where} Cancel ends that download too`);
			await waitForRow(page, slow.name, { status: WORDS.status.program, button: WORDS.button.checkConnection }, `${where} and the row is as before`);
		}

		// From the directory: one that signs in goes to its sign-in page in the same click; one with a key asks for it first; an open one is added and checked.
		if (width === "desktop") {
			await page.locator(".connector-dir-row", { hasText: "Notion" }).getByRole("button", { name: WORDS.directoryAdd({ name: "Notion", kind: "oauth" }), exact: true }).click();
			await waitForRow(page, "Notion", { status: WORDS.status.signingIn, note: WORDS.signingInNote, button: WORDS.button.cancel }, `${where} Add from the directory leaves the new row signing in`);
			same(asked.filter((one) => one === "POST login notion").length, 1, `${where} one click asked for the sign-in page once`);
			await footStrip(page, "Notion").getByRole("button", { name: WORDS.button.cancel, exact: true }).click();
			await waitForRow(page, "Notion", { status: WORDS.status.notConnected }, `${where} Cancel ends it`);
			await page.locator(".connector-dir-row", { hasText: "GitHub" }).getByRole("button", { name: WORDS.directoryAdd({ name: "GitHub", kind: "token" }), exact: true }).click();
			await page.locator(".connector-dir-token-input").waitFor();
			assert(!(await statusOf("github")) && !asked.includes("POST login github"), `${where} a directory entry that needs a key asks for it before it is added`);
			await page.locator(".connector-dir-row", { hasText: "Context7" }).getByRole("button", { name: WORDS.directoryAdd({ name: "Context7", kind: "open" }), exact: true }).click();
			await row(page, "Context7").waitFor();
			await waitUntil(async () => asked.includes("test context7"), `${where} an open directory entry is checked once added`);
			assert(!asked.includes("POST login context7"), `${where} an open one opens no sign-in`);
		}

		// A connector's own page: its facts, its tools in two groups by the gate's rule, and Check connection.
		// Opened from a list scrolled down to its row, it opens at its beginning: its way back and its name in view.
		const scrolledBy = await row(page, "Team wiki").evaluate((element) => {
			element.scrollIntoView({ block: "start" });
			let pane = element.parentElement;
			while (pane && pane.scrollTop === 0) pane = pane.parentElement;
			return pane?.scrollTop ?? 0;
		});
		assert(scrolledBy > 0, `${where} the list is scrolled down to Team wiki's row`);
		await openPage(page, "Team wiki");
		for (const [what, selector] of [["way back", ".connector-page-back"], ["name", ".connector-page-head h2"]]) assert(await wordsInView(page, selector), `${where} a page opened from a scrolled list shows its ${what}`);
		same(await page.locator(".connector-page-back").getAttribute("aria-label"), WORDS.details.backName, `${where} the page's way back`);
		same(await page.locator(".connector-page .connector-facts .settings-row-label").allInnerTexts(), [WORDS.details.status, WORDS.details.address, WORDS.details.key, WORDS.details.signIn, WORDS.details.usedIn], `${where} a web connector's facts: one added here with no key takes a first one, and one with no sign-in stored offers it`);
		same(await statusWords(page), WORDS.status.connected, `${where} its connection's state, in its first row`);
		same(await fact(page, "Rooms").locator("a").allInnerTexts(), ["Board papers", "Monthly reporting"], `${where} the rooms it is on in, each a link`);
		await waitUntil(async () => (await page.locator(".connector-tools-kicker").count()) === 2, `${where} its tools show`);
		same(await page.locator(".connector-tools-kicker").allInnerTexts(), ["Read-only tools", "Tools that may change things"], `${where} the two groups`);
		same(await page.locator(".connector-tools-line").innerText(), "Your choices count in every room where this connector is on, also when you're away. A room on Auto with protection off never asks.", `${where} the line above the tools`);
		const group = (index: number) => page.locator(".connector-tools").nth(index).locator(".settings-row-label").allInnerTexts();
		same(await group(0), ["Search pages", "Get page"], `${where} read-only: marked read-only and not destructive`);
		same(await group(1), ["Create page", "Wipe space"], `${where} the rest, an unmarked tool and a destructive one included, may change things`);
		assert((await page.locator(".connector-tools").first().innerText()).includes("Search pages by the words in their title or text."), `${where} each tool with its connector's line`);
		await backToList(page);
		await openPage(page, webAdded.name);
		const checks = asked.filter((one) => one === `test ${webAdded.id}`).length;
		await statusRow(page).getByRole("button", { name: WORDS.button.checkConnection, exact: true }).click();
		await waitUntil(async () => asked.filter((one) => one === `test ${webAdded.id}`).length === checks + 1, `${where} Check connection checks it again`);
		await waitUntil(async () => (await page.locator(".connector-tools-kicker").count()) === 2, `${where} and lists its tools`);
		same(await page.locator(".connector-tools").nth(1).locator(".settings-row-label").allInnerTexts(), ["File paper"], `${where} the added one's own tools`);
		await backToList(page);

		// Disconnect, from the page of one signed in.
		await openPage(page, "Signed wiki");
		same(await fact(page, WORDS.details.signIn).locator(".connector-item-status").innerText(), WORDS.details.signedIn, `${where} a signed-in connector says so`);
		// Its check failing, the connection says so, and the sign-in still shows with Disconnect.
		slowChecks.set("signed-wiki", { ms: 0, answer: { ok: false, error: "connect ECONNREFUSED 127.0.0.1:9" } });
		await statusRow(page).getByRole("button", { name: WORDS.button.checkConnection, exact: true }).click();
		await waitUntil(async () => (await statusRow(page).locator(".connector-dot-err").count()) === 1, `${where} a failed check shows in the Status row`);
		same(await fact(page, WORDS.details.signIn).locator(".connector-item-status").innerText(), WORDS.details.signedIn, `${where} and the sign-in still shows`);
		slowChecks.delete("signed-wiki");
		await fact(page, WORDS.details.signIn).getByRole("button", { name: WORDS.button.disconnect, exact: true }).click();
		await waitUntil(async () => (await statusOf("signed-wiki")).auth.hasStoredTokens === false, `${where} Disconnect signs it out`);
		await backToList(page);
		// Signed in again for the other width.
		authStore.updateTokens("signed-wiki", { accessToken: "synthetic-valid", expiresAt: hour() + 3600 }, at("/wiki/mcp"));

		// Change address from the page: the broken one moves to an address that answers.
		if (width === "phone") {
			await openPage(page, "Shared calendar");
			await statusRow(page).getByRole("button", { name: WORDS.button.changeAddress, exact: true }).click();
			const field = page.locator(".connector-page .connector-edit-input").first();
			await field.fill(at("/board/mcp"));
			await page.locator(".connector-page .connector-edit-foot").getByRole("button", { name: WORDS.button.save, exact: true }).click();
			await waitUntil(async () => (await statusOf("shared-calendar")).target === at("/board/mcp"), `${where} Change address saves the new address`);
			await waitUntil(async () => (await page.locator(".connector-tools-kicker").count()) === 2, `${where} the moved connector is checked and lists its tools`);
			await backToList(page);
		}
		if (pageErrors.length) throw new Error(`${where} the page threw: ${pageErrors.join("; ")}`);
		await context.close();
	}

	// A program that downloads nothing first is checking all the while: past the 3 s after which one that downloads
	// is getting ready, too. The page's clock runs ahead; the check is held here until then.
	{
		const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
		const page = await context.newPage();
		await page.clock.install();
		await answerInPage(page);
		await signIn(page);
		await openConnectors(page);
		let release = () => {};
		slowChecks.set("office-files", { until: new Promise<void>((resolve) => { release = resolve; }), answer: { ok: true, toolCount: 1, toolNames: ["read"] } });
		await openPage(page, "Office files");
		await statusRow(page).getByRole("button", { name: WORDS.button.checkConnection, exact: true }).click();
		await backToList(page);
		const checking = { status: WORDS.status.checking, note: null, button: WORDS.button.checkConnection };
		await waitForRow(page, "Office files", checking, "clock: a slow program that downloads nothing first is checking");
		await page.clock.runFor(4000);
		await waitForRow(page, "Office files", checking, "clock: still checking past the 3 s, not getting ready");
		release();
		await waitForRow(page, "Office files", { status: WORDS.status.connected }, "clock: once its check answers it is connected");
		slowChecks.delete("office-files");
		await context.close();
	}

	// A sign-in waits as long as the server's own does: still waiting past the page's old 3 minutes; ended by
	// the server's own limit, it says it took too long, with Try again; and should that end never be heard,
	// the page's own limit after it says the same. The page's clock runs ahead; the sign-in's routes answer here.
	{
		const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
		const page = await context.newPage();
		await page.clock.install();
		await answerInPage(page);
		await signIn(page);
		await openConnectors(page);
		const tooSlow = { status: WORDS.status.signInFailed, note: WORDS.signInFailed.tooSlow.fact, button: WORDS.button.tryAgain };
		await waitForRow(page, "Sign-in desk", { status: WORDS.status.notConnected, button: WORDS.button.connect }, "limit: the sign-in desk offers Connect");
		await row(page, "Sign-in desk").getByRole("button", { name: WORDS.button.connect, exact: true }).click();
		await waitForRow(page, "Sign-in desk", { status: WORDS.status.signingIn }, "limit: Connect leaves it signing in");
		await page.clock.fastForward("03:10");
		await page.clock.runFor(4000);
		await waitForRow(page, "Sign-in desk", { status: WORDS.status.signingIn, button: WORDS.button.cancel }, "limit: past 3 minutes it still waits for the browser");
		signIns.set("sign-in-desk", "too-slow");
		await page.clock.runFor(4000);
		await waitForRow(page, "Sign-in desk", tooSlow, "limit: the server's own end says it took too long, with Try again");
		signIns.delete("sign-in-desk");
		await row(page, "Sign-in desk").getByRole("button", { name: WORDS.button.tryAgain, exact: true }).click();
		await waitForRow(page, "Sign-in desk", { status: WORDS.status.signingIn }, "limit: Try again signs in again");
		const cancels = asked.filter((one) => one === "DELETE login sign-in-desk").length;
		await page.clock.fastForward("05:40");
		await page.clock.runFor(4000);
		await waitForRow(page, "Sign-in desk", tooSlow, "limit: with the server's end never heard, the page's own limit says the same");
		same(asked.filter((one) => one === "DELETE login sign-in-desk").length, cancels + 1, "limit: and ends the server's sign-in");
		signIns.delete("sign-in-desk");
		await context.close();
	}

	// Each tool's choice on its connector's page: one control per tool with the
	// three choices and Use default, no mark on a tool with nothing chosen, its
	// resources listed as tools, a tool its entry switches off by hand shown as
	// Blocked with no control; a reload keeps them, a failed save leaves the
	// control as it was, a changed connector saves nothing; the words alone over
	// remote access and where the choices can't be read.
	const mcpFile = path.join(agentDir, "mcp.json");
	const choicesFile = path.join(agentDir, "mcp-tool-choices.json");
	const notesDesk = { displayName: "Notes desk", url: at("/notes/mcp"), excludeTools: ["old_export"] };
	const writeNotesDesk = (entry: Record<string, unknown>) => {
		const config = JSON.parse(fs.readFileSync(mcpFile, "utf-8"));
		config.mcpServers["notes-desk"] = entry;
		fs.writeFileSync(mcpFile, JSON.stringify(config));
	};
	writeNotesDesk(notesDesk);
	const choicesNow = async () => JSON.stringify((await statusOf("notes-desk")).choices);
	const tool = (page: Page, name: string) => page.locator(`.connector-page .connector-tool[data-tool="${name}"]`);
	/** A tool's choice as drawn: the words, whether it has a control, and anything else beside it. */
	const drawn = (page: Page, name: string) => tool(page, name).evaluate((line) => ({
		mark: [...line.querySelector(".connector-choice")!.children].filter((one) => !one.matches(".ai-profile-menu-anchor, .connector-choice-words, .connector-slot-btn, .rs-btn")).map((one) => one.textContent).join(" ") || null,
		words: line.querySelector(".connector-choice-btn .connector-slot-label, .connector-choice-words")?.textContent ?? null,
		control: line.querySelectorAll(".connector-choice-btn").length,
	}));
	const { choices: CHOICE } = WORDS.tools;
	const menuItems = (page: Page) => page.locator(".ai-profile-menu [role=menuitemradio]");
	const pickIn = async (page: Page, name: string, words: string) => {
		await tool(page, name).locator(".connector-choice-btn").click();
		await menuItems(page).filter({ hasText: new RegExp(`^${words}$`) }).click();
	};
	const toolsShown = (page: Page) => waitUntil(async () => (await page.locator(".connector-page .connector-tool").count()) === 5, "choices: Notes desk lists its tools");
	{
		const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
		const page = await context.newPage();
		const pageErrors: string[] = [];
		page.on("pageerror", (error) => pageErrors.push(error.message));
		await answerInPage(page);
		await signIn(page);
		await openConnectors(page);
		await openPage(page, "Notes desk");
		await statusRow(page).getByRole("button", { name: WORDS.button.checkConnection, exact: true }).click();
		await toolsShown(page);
		same(await page.locator(".connector-tools-line").innerText(), WORDS.tools.applies, "choices: the line above the tools");
		const groupTools = (index: number) => page.locator(".connector-page .connector-tools").nth(index).locator(".connector-tool").evaluateAll((lines) => lines.map((line) => (line as HTMLElement).dataset.tool));
		same(JSON.stringify(await groupTools(0)), JSON.stringify(["read_note", "get_notes"]), "choices: a resource is listed with the read-only tools, by the name a room calls it");
		same(JSON.stringify(await groupTools(1)), JSON.stringify(["write_note", "purge_notes", "old_export"]), "choices: the rest, the one switched off by hand included");
		for (const [name, words] of [["read_note", CHOICE.allow], ["get_notes", CHOICE.allow], ["write_note", CHOICE.ask], ["purge_notes", CHOICE.ask]] as const) {
			same(JSON.stringify(await drawn(page, name)), JSON.stringify({ mark: null, words, control: 1 }), `choices: ${name} with nothing chosen shows what it does by default, with a control and no word beside it`);
		}
		same(JSON.stringify(await drawn(page, "old_export")), JSON.stringify({ mark: null, words: CHOICE.blocked, control: 0 }), "choices: a tool switched off by hand reads Blocked, with no control");
		const controlLefts = await page.locator(".connector-page .connector-choice-btn").evaluateAll((buttons) => [...new Set(buttons.map((button) => Math.round(button.getBoundingClientRect().left)))]);
		same(controlLefts.length, 1, `choices: Always allow and Ask first controls start at one edge, in both groups (lefts ${controlLefts.join(", ")})`);
		same(await choicesNow(), "{}", "choices: nothing is saved until the person picks");

		// The menu: the three choices and Use default, the one in force checked and focused; Escape gives the focus back.
		const purge = tool(page, "purge_notes").locator(".connector-choice-btn");
		same(await purge.getAttribute("aria-label"), WORDS.tools.choiceLabel("Purge notes", CHOICE.ask), "choices: the control's name says the tool and what it does now");
		await purge.click();
		same(JSON.stringify(await menuItems(page).allInnerTexts()), JSON.stringify([CHOICE.allow, CHOICE.ask, CHOICE.blocked, WORDS.tools.useDefault]), "choices: the menu's four entries");
		same(JSON.stringify(await menuItems(page).evaluateAll((items) => items.map((item) => item.getAttribute("aria-checked")))), JSON.stringify(["false", "false", "false", "true"]), "choices: with nothing chosen, Use default is checked");
		await waitUntil(() => page.evaluate((words) => document.activeElement?.textContent === words, WORDS.tools.useDefault), "choices: the open menu takes the focus to the checked entry");
		await page.keyboard.press("Escape");
		await waitUntil(async () => (await menuItems(page).count()) === 0 && (await purge.evaluate((button) => button === document.activeElement)), "choices: Escape closes the menu and gives the focus back to the control");
		// By keyboard: Enter opens, the arrow moves, Enter picks.
		await page.keyboard.press("Enter");
		await waitUntil(() => page.evaluate((words) => document.activeElement?.textContent === words, WORDS.tools.useDefault), "choices: Enter opens the menu");
		await page.keyboard.press("ArrowUp");
		await page.keyboard.press("Enter");
		await waitUntil(async () => (await choicesNow()) === JSON.stringify({ purge_notes: "blocked" }), "choices: Blocked picked by keyboard is saved");
		await waitUntil(async () => JSON.stringify(await drawn(page, "purge_notes")) === JSON.stringify({ mark: null, words: CHOICE.blocked, control: 1 }), "choices: a saved choice shows with no Default mark");
		// By pointer: Always allow on a tool the connector doesn't mark, and Ask first on a read-only one.
		await pickIn(page, "write_note", CHOICE.allow);
		await waitUntil(async () => (await choicesNow()) === JSON.stringify({ purge_notes: "blocked", write_note: "allow" }), "choices: Always allow is saved");
		await pickIn(page, "read_note", CHOICE.ask);
		await waitUntil(async () => (await choicesNow()) === JSON.stringify({ purge_notes: "blocked", write_note: "allow", read_note: "ask" }), "choices: Ask first on a read-only tool is saved");
		await waitUntil(async () => JSON.stringify(await drawn(page, "read_note")) === JSON.stringify({ mark: null, words: CHOICE.ask, control: 1 }), "choices: and shows");

		// Back to the list and in again: the page shows what was just saved.
		await backToList(page);
		await openPage(page, "Notes desk");
		await toolsShown(page);
		for (const [name, words] of [["read_note", CHOICE.ask], ["write_note", CHOICE.allow], ["purge_notes", CHOICE.blocked]] as const) {
			await waitUntil(async () => JSON.stringify(await drawn(page, name)) === JSON.stringify({ mark: null, words, control: 1 }), `choices: back and in again, ${name} still reads ${words}`);
		}

		// A reload keeps them.
		await page.reload();
		await page.locator(".persistent-agent-card, .connector-page").first().waitFor({ timeout: 15000 });
		if ((await page.locator(".connector-page").count()) === 0) {
			await openConnectors(page);
			await openPage(page, "Notes desk");
		}
		await toolsShown(page);
		for (const [name, words] of [["read_note", CHOICE.ask], ["write_note", CHOICE.allow], ["purge_notes", CHOICE.blocked]] as const) {
			same(JSON.stringify(await drawn(page, name)), JSON.stringify({ mark: null, words, control: 1 }), `choices: after a reload ${name} still reads ${words}`);
		}
		// Use default clears a choice: the tool shows its default again.
		await pickIn(page, "read_note", WORDS.tools.useDefault);
		await waitUntil(async () => (await choicesNow()) === JSON.stringify({ purge_notes: "blocked", write_note: "allow" }), "choices: Use default clears the saved choice");
		await waitUntil(async () => JSON.stringify(await drawn(page, "read_note")) === JSON.stringify({ mark: null, words: CHOICE.allow, control: 1 }), "choices: and the tool shows its default again");

		// A save that fails says so on the tool's line and leaves the control as it was.
		await page.route("**/api/mcp/servers/*/tools", (route) => route.fulfill({ status: 500, json: { error: "stand-in failure" } }));
		await pickIn(page, "get_notes", CHOICE.blocked);
		await waitUntil(async () => (await tool(page, "get_notes").locator(".connector-row-error").count()) === 1, "choices: a failed save says so");
		same(await tool(page, "get_notes").locator(".connector-row-error").innerText(), CONNECTOR_REQUEST_LINES.saveFailed, "choices: in the save-failed line");
		same(JSON.stringify(await drawn(page, "get_notes")), JSON.stringify({ mark: null, words: CHOICE.allow, control: 1 }), "choices: and the control stays as it was");
		await page.unroute("**/api/mcp/servers/*/tools");
		same(await choicesNow(), JSON.stringify({ purge_notes: "blocked", write_note: "allow" }), "choices: nothing was saved");
		// A save whose answer never comes back, though the server saved it: the page reads the choices again and shows what was saved.
		await page.route("**/api/mcp/servers/*/tools", async (route) => {
			await route.fetch();
			await route.abort("connectionreset");
		});
		await pickIn(page, "get_notes", CHOICE.blocked);
		await waitUntil(async () => (await choicesNow()) === JSON.stringify({ purge_notes: "blocked", write_note: "allow", get_notes: "blocked" }), "choices: a save whose answer was lost was saved");
		await waitUntil(async () => JSON.stringify(await drawn(page, "get_notes")) === JSON.stringify({ mark: null, words: CHOICE.blocked, control: 1 }), "choices: a save whose answer was lost shows what was saved");
		same(await tool(page, "get_notes").locator(".connector-row-error").count(), 0, "choices: a save whose answer was lost but was saved says no failure");
		// Both answers lost, the save's and the read's after it: the page can't tell what was saved, so the tool shows no choice,
		// says so, and Try again reads again. The same for Use default.
		const cutStatus = async (route: Route) => route.abort("connectionreset");
		const unsureLine = tool(page, "get_notes").locator(".connector-row-error");
		const checkAgain = tool(page, "get_notes").getByRole("button", { name: WORDS.button.tryAgain, exact: true });
		for (const [pick, saved, shown] of [[WORDS.tools.useDefault, { purge_notes: "blocked", write_note: "allow" }, { mark: null, words: CHOICE.allow, control: 1 }], [CHOICE.blocked, { purge_notes: "blocked", write_note: "allow", get_notes: "blocked" }, { mark: null, words: CHOICE.blocked, control: 1 }]] as const) {
			await page.route("**/api/mcp/status", cutStatus);
			await pickIn(page, "get_notes", pick);
			await waitUntil(async () => (await choicesNow()) === JSON.stringify(saved), `choices: ${pick} with both answers lost was saved`);
			await waitUntil(async () => (await unsureLine.innerText().catch(() => "")) === WORDS.tools.unsure, `choices: ${pick} with both answers lost says the page can't tell`);
			same(JSON.stringify(await drawn(page, "get_notes")), JSON.stringify({ mark: null, words: null, control: 0 }), `choices: ${pick} with both answers lost shows no choice`);
			same(await tool(page, "read_note").locator(".connector-choice-btn").isDisabled(), true, `choices: ${pick} with both answers lost, every other menu waits until Try again reads it`);
			await page.unroute("**/api/mcp/status", cutStatus);
			await checkAgain.click();
			await waitUntil(async () => JSON.stringify(await drawn(page, "get_notes")) === JSON.stringify(shown) && (await unsureLine.count()) === 0, `choices: ${pick}: Try again reads again and shows what is saved`);
		}
		await page.unroute("**/api/mcp/servers/*/tools");
		// A save that never reached the server, its read lost too: Try again shows the choice as it was and says the change wasn't saved.
		await page.route("**/api/mcp/servers/*/tools", cutStatus);
		await page.route("**/api/mcp/status", cutStatus);
		await pickIn(page, "get_notes", CHOICE.ask);
		await waitUntil(async () => (await unsureLine.innerText().catch(() => "")) === WORDS.tools.unsure, "choices: a save that never arrived, its read lost too, says the page can't tell");
		await page.unroute("**/api/mcp/status", cutStatus);
		await page.unroute("**/api/mcp/servers/*/tools", cutStatus);
		await checkAgain.click();
		await waitUntil(async () => JSON.stringify(await drawn(page, "get_notes")) === JSON.stringify({ mark: null, words: CHOICE.blocked, control: 1 }) && (await unsureLine.innerText().catch(() => "")) === CONNECTOR_REQUEST_LINES.saveFailed, "choices: Try again shows the choice as it was and says the change wasn't saved");
		same(await choicesNow(), JSON.stringify({ purge_notes: "blocked", write_note: "allow", get_notes: "blocked" }), "choices: a save that never arrived changed nothing");
		await pickIn(page, "get_notes", WORDS.tools.useDefault);
		await waitUntil(async () => (await choicesNow()) === JSON.stringify({ purge_notes: "blocked", write_note: "allow" }), "choices: put back to its default");
		await waitUntil(async () => JSON.stringify(await drawn(page, "get_notes")) === JSON.stringify({ mark: null, words: CHOICE.allow, control: 1 }) && (await tool(page, "purge_notes").locator(".connector-choice-btn").isEnabled()), "choices: and shows it, the controls free again");

		// A connector moved since the page showed it: an Always allow saves nothing, and the page says it changed.
		writeNotesDesk({ ...notesDesk, url: at("/notes/mcp?moved") });
		await pickIn(page, "purge_notes", CHOICE.allow);
		await waitUntil(async () => (await page.locator(".connector-page-error span").innerText().catch(() => "")) === CONNECTOR_REQUEST_LINES.toolsChanged, "choices: a changed connector says so");
		same(await choicesNow(), JSON.stringify({ purge_notes: "blocked", write_note: "allow" }), "choices: and nothing was saved");
		writeNotesDesk(notesDesk);
		if (pageErrors.length) throw new Error(`choices: the page threw: ${pageErrors.join("; ")}`);
		await context.close();
	}
	{
		// Over remote access: the words alone.
		const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
		const page = await context.newPage();
		await page.route("**/api/remote/client-context", (route) => route.fulfill({ contentType: "application/json", body: JSON.stringify({ remote: true, capability: "read-only" }) }));
		await answerInPage(page);
		await signIn(page);
		await openConnectors(page);
		await openPage(page, "Notes desk");
		await toolsShown(page);
		same(await page.locator(".connector-page .connector-choice-btn").count(), 0, "choices: over remote access no tool has a control");
		for (const [name, mark, words] of [["read_note", null, CHOICE.allow], ["write_note", null, CHOICE.allow], ["purge_notes", null, CHOICE.blocked], ["old_export", null, CHOICE.blocked]] as const) {
			same(JSON.stringify(await drawn(page, name)), JSON.stringify({ mark, words, control: 0 }), `choices: over remote access ${name} reads ${words} in words`);
		}
		await context.close();
	}
	{
		// The choices can't be read: the page says so, every tool reads Ask first with no control, and the file stays as it was.
		// A removal says why and what to do, with no Try again; Reset choices asks first, and only its yes sets the file aside.
		const kept = fs.readFileSync(choicesFile, "utf-8");
		fs.writeFileSync(choicesFile, "{ not json");
		const setAside = () => fs.readdirSync(agentDir).filter((name) => name.startsWith("mcp-tool-choices.json.unreadable-"));
		const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
		const page = await context.newPage();
		await answerInPage(page);
		await signIn(page);
		await openConnectors(page);
		await openPage(page, "Notes desk");
		await toolsShown(page);
		const unreadableLine = page.locator(".connector-tools-unreadable");
		const resetButton = unreadableLine.getByRole("button", { name: WORDS.tools.reset, exact: true });
		same(await unreadableLine.locator("p").innerText(), WORDS.tools.unreadable["cannot-read"], "choices: unreadable, the page says so");
		same(await resetButton.count(), 1, "choices: unreadable, Reset choices is offered beside it");
		same(await page.locator(".connector-tools-line").count(), 0, "choices: unreadable, no line says a room on Auto with protection off doesn't ask, as every tool asks");
		for (const name of ["read_note", "get_notes", "write_note", "purge_notes"]) same(JSON.stringify(await drawn(page, name)), JSON.stringify({ mark: null, words: CHOICE.ask, control: 0 }), `choices: unreadable, ${name} reads Ask first with no control`);
		same(JSON.stringify(await drawn(page, "old_export")), JSON.stringify({ mark: null, words: CHOICE.blocked, control: 0 }), "choices: unreadable, the one switched off by hand still reads Blocked");
		same(fs.readFileSync(choicesFile, "utf-8"), "{ not json", "choices: unreadable, nothing is written over the file");
		// Remove: refused at once with what to do first, with no question it would refuse anyway, and Reset choices in its line.
		await page.locator(".connector-remove-group").getByRole("button", { name: WORDS.button.remove, exact: true }).click();
		const dialog = page.locator(".confirm-dialog-backdrop");
		await waitUntil(async () => (await page.locator(".connector-page-error span").innerText().catch(() => "")) === CONNECTOR_REQUEST_LINES.removeChoicesUnreadableBesideReset, "choices: unreadable, a removal says why and what to do");
		same(await dialog.count(), 0, "choices: unreadable, Remove asks no question it would refuse");
		same(JSON.stringify(await page.locator(".connector-page-error button").allInnerTexts()), JSON.stringify([WORDS.tools.reset]), "choices: unreadable, the removal's line offers Reset choices and no Try again");
		assert(await statusOf("notes-desk"), "choices: unreadable, the connector is still there");
		// A reset started from the removal's line that fails says so in that line, beside the button pressed.
		await page.route("**/api/mcp/tool-choices/reset", (route) => route.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ error: CONNECTOR_REQUEST_LINES.choicesResetFailed }) }));
		await page.locator(".connector-page-error").getByRole("button", { name: WORDS.tools.reset, exact: true }).click();
		await dialog.getByRole("button", { name: WORDS.tools.reset, exact: true }).click();
		await waitUntil(async () => (await page.locator(".connector-page-error span").innerText().catch(() => "")) === CONNECTOR_REQUEST_LINES.choicesResetFailed, "choices: a failed reset from the removal's line says so there");
		same(await page.locator(".connector-tools-group .connector-row-error").count(), 0, "choices: a failed reset from the removal's line says nothing under Tools");
		same(await page.locator(".connector-page-error").getByRole("button", { name: WORDS.tools.reset, exact: true }).count(), 1, "choices: after a failed reset the removal's line still offers Reset choices");
		await page.unroute("**/api/mcp/tool-choices/reset");
		// Remove again: its line says again why it can't be removed.
		await page.locator(".connector-remove-group").getByRole("button", { name: WORDS.button.remove, exact: true }).click();
		await waitUntil(async () => (await page.locator(".connector-page-error span").innerText().catch(() => "")) === CONNECTOR_REQUEST_LINES.removeChoicesUnreadableBesideReset, "choices: after a failed reset, Remove again says why again");
		const underTools = page.locator(".connector-tools-group .connector-row-error");
		same(await underTools.innerText(), CONNECTOR_REQUEST_LINES.choicesResetFailed, "choices: once its line has gone, the failed reset says so under Tools");
		// Remove pressed while a reset from the removal's line is still on its way: when it fails, that is still said, under Tools.
		let answerReset: () => void = () => undefined;
		const resetHeld = new Promise<void>((resolve) => { answerReset = resolve; });
		await page.route("**/api/mcp/tool-choices/reset", async (route) => { await resetHeld; await route.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ error: CONNECTOR_REQUEST_LINES.choicesResetFailed }) }); });
		await page.locator(".connector-page-error").getByRole("button", { name: WORDS.tools.reset, exact: true }).click();
		await dialog.getByRole("button", { name: WORDS.tools.reset, exact: true }).click();
		await waitUntil(async () => (await underTools.count()) === 0, "choices: a reset on its way clears its earlier failure");
		await page.locator(".connector-remove-group").getByRole("button", { name: WORDS.button.remove, exact: true }).click();
		answerReset();
		await waitUntil(async () => (await underTools.innerText().catch(() => "")) === CONNECTOR_REQUEST_LINES.choicesResetFailed, "choices: a reset that fails after Remove was pressed says so under Tools");
		same(await page.locator(".connector-page-error span").innerText(), CONNECTOR_REQUEST_LINES.removeChoicesUnreadableBesideReset, "choices: and the removal's line says why it can't be removed");
		await page.unroute("**/api/mcp/tool-choices/reset");
		// Reset choices asks first, saying what the person gets; Cancel changes nothing.
		await resetButton.click();
		same(await dialog.locator("h2").innerText(), WORDS.tools.resetQuestion, "choices: Reset choices asks first");
		same(await dialog.locator("p").innerText(), WORDS.tools.resetConsequence, "choices: the question says a blocked tool is no longer blocked");
		await dialog.getByRole("button", { name: WORDS.button.cancel, exact: true }).click();
		await dialog.waitFor({ state: "hidden" });
		same(fs.readFileSync(choicesFile, "utf-8"), "{ not json", "choices: Cancel loosens nothing, the file stays");
		same(setAside().length, 0, "choices: Cancel sets nothing aside");
		// Its yes, from the removal's line: the file is set aside as it was, every tool is back to its default with its control, and the removal's line goes.
		await page.locator(".connector-page-error").getByRole("button", { name: WORDS.tools.reset, exact: true }).click();
		await dialog.getByRole("button", { name: WORDS.tools.reset, exact: true }).click();
		await waitUntil(async () => (await unreadableLine.count()) === 0, "choices: after the reset the line goes");
		assert(!fs.existsSync(choicesFile) && setAside().length === 1 && fs.readFileSync(path.join(agentDir, setAside()[0]), "utf-8") === "{ not json", `choices: the reset keeps the old file beside it, got ${JSON.stringify(setAside())}`);
		same(JSON.stringify(await drawn(page, "write_note")), JSON.stringify({ mark: null, words: CHOICE.ask, control: 1 }), "choices: after the reset each tool is back to its default, with its control");
		same(await page.locator(".connector-page-error").count(), 0, "choices: after the reset the removal's line goes");
		same(await page.locator(".connector-tools-line").innerText(), WORDS.tools.applies, "choices: after the reset the line above the tools is back");
		await pickIn(page, "write_note", CHOICE.blocked);
		await waitUntil(async () => (await choicesNow()) === JSON.stringify({ write_note: "blocked" }), "choices: after the reset a choice saves");
		await context.close();
		{
			// The file turns unreadable after the page read it: Remove asks as usual, and the server's refusal brings Reset choices into its line.
			const late = await browser.newContext({ viewport: { width: 1440, height: 900 } });
			const latePage = await late.newPage();
			await answerInPage(latePage);
			await signIn(latePage);
			await openConnectors(latePage);
			await openPage(latePage, "Notes desk");
			await toolsShown(latePage);
			fs.writeFileSync(choicesFile, "{ not json");
			await latePage.locator(".connector-remove-group").getByRole("button", { name: WORDS.button.remove, exact: true }).click();
			await latePage.locator(".confirm-dialog-backdrop").getByRole("button", { name: WORDS.button.remove, exact: true }).click();
			await waitUntil(async () => (await latePage.locator(".connector-page-error span").innerText().catch(() => "")) === CONNECTOR_REQUEST_LINES.removeChoicesUnreadableBesideReset, "choices: unreadable since the page read them, a removal says why and what to do");
			same(JSON.stringify(await latePage.locator(".connector-page-error button").allInnerTexts()), JSON.stringify([WORDS.tools.reset]), "choices: unreadable since the page read them, the removal's line offers Reset choices");
			assert(await statusOf("notes-desk"), "choices: unreadable since the page read them, the connector is still there");
			// On the list, with no button beside it, the line says where Reset choices is.
			await backToList(latePage);
			same(await row(latePage, "Notes desk").locator(".connector-item-status").innerText(), CONNECTOR_REQUEST_LINES.removeChoicesUnreadable["cannot-read"], "choices: on the list the removal's line says where Reset choices is");
			await late.close();
		}
		// A newer version's choices: the page says to update, with no reset. Over remote access, no reset either.
		for (const [remote, written, why] of [[false, JSON.stringify({ schemaVersion: 2, connectors: {} }), "newer"], [true, "{ not json", "cannot-read"]] as const) {
			fs.writeFileSync(choicesFile, written);
			const later = await browser.newContext({ viewport: { width: 1440, height: 900 } });
			const laterPage = await later.newPage();
			if (remote) await laterPage.route("**/api/remote/client-context", (route) => route.fulfill({ contentType: "application/json", body: JSON.stringify({ remote: true, capability: "read-only" }) }));
			await answerInPage(laterPage);
			await signIn(laterPage);
			await openConnectors(laterPage);
			await openPage(laterPage, "Notes desk");
			await toolsShown(laterPage);
			const line = laterPage.locator(".connector-tools-unreadable");
			same(await line.locator("p").innerText(), WORDS.tools.unreadable[why], remote ? "choices: over remote access the page says they can't be read" : "choices: a newer version's choices, the page says to update");
			same(await line.getByRole("button").count(), 0, remote ? "choices: over remote access no Reset choices" : "choices: a newer version's choices offer no reset");
			if (!remote) {
				await laterPage.locator(".connector-remove-group").getByRole("button", { name: WORDS.button.remove, exact: true }).click();
				await waitUntil(async () => (await laterPage.locator(".connector-page-error span").innerText().catch(() => "")) === CONNECTOR_REQUEST_LINES.removeChoicesUnreadable.newer, "choices: a newer version's choices, a removal says to update first");
				same(await laterPage.locator(".connector-page-error button").count(), 0, "choices: a newer version's choices, the removal's line offers no reset");
			}
			await later.close();
		}
		for (const name of setAside()) fs.rmSync(path.join(agentDir, name));
		fs.writeFileSync(choicesFile, kept);
	}
	{
		// At phone width: the menu opens by touch inside the screen and a tap picks.
		const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
		const page = await context.newPage();
		await answerInPage(page);
		await signIn(page);
		await openConnectors(page);
		await openPage(page, "Notes desk");
		await toolsShown(page);
		await tool(page, "get_notes").locator(".connector-choice-btn").tap();
		const box = await page.locator(".ai-profile-menu").boundingBox();
		assert(box && box.x >= 0 && box.x + box.width <= 390, `choices: phone, the menu fits the screen, got ${JSON.stringify(box)}`);
		await menuItems(page).filter({ hasText: new RegExp(`^${CHOICE.blocked}$`) }).tap();
		await waitUntil(async () => (await choicesNow()) === JSON.stringify({ purge_notes: "blocked", write_note: "allow", get_notes: "blocked" }), "choices: phone, a tap picks");
		await context.close();
	}

	// Remove, asked in the app's dialog with the rooms named; Keep keeps it.
	const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
	const page = await context.newPage();
	await answerInPage(page);
	const deletesSent: string[] = [];
	page.on("request", (request) => {
		if (request.method() === "DELETE" && /\/api\/mcp\/servers\/[^/]+$/.test(new URL(request.url()).pathname)) deletesSent.push(decodeURIComponent(new URL(request.url()).pathname.split("/").at(-1)!));
	});
	const grantsNow = async () => JSON.stringify(await Promise.all(rooms.map((room) => roomGrants(room))));
	/** Keep: the question closes, the page stays on the connector, no delete left the page, the app keeps ours, and every room its grants. */
	const keep = async (name: string, shown: string) => {
		const grantsBefore = await grantsNow();
		await dialog.getByRole("button", { name: WORDS.button.keep, exact: true }).click();
		await dialog.waitFor({ state: "hidden" });
		same(await page.locator(".connector-page-head h2").innerText(), shown, `after Keep the page stays on ${shown}`);
		same(JSON.stringify(deletesSent), "[]", `Keep on ${shown} sends no delete`);
		const kept = await statusOf(name);
		assert(kept && !kept.source?.importKind, `after Keep the app still has its own ${name}, got ${JSON.stringify(kept?.source)}`);
		same(await grantsNow(), grantsBefore, `after Keep every room keeps its grants (${shown})`);
	};
	await signIn(page);
	await openConnectors(page);
	await openPage(page, "Team wiki");
	await page.locator(".connector-remove-group").getByRole("button", { name: WORDS.button.remove, exact: true }).click();
	const dialog = page.locator(".confirm-dialog-backdrop");
	same(await dialog.locator("h2").innerText(), WORDS.removeQuestion("Team wiki"), "the question names the connector");
	same(await dialog.locator("p").innerText(), `Board papers and Monthly reporting stop using it. ${WORDS.removeCustomUnused}`, "the question names the rooms and what adding it back takes");
	await keep("team-wiki", "Team wiki");
	await page.locator(".connector-remove-group").getByRole("button", { name: WORDS.button.remove, exact: true }).click();
	await dialog.getByRole("button", { name: WORDS.button.remove, exact: true }).click();
	// Cursor's of the same name stays: the page shows it, where it came from, and where to change and remove it.
	await waitUntil(async () => (await page.locator(".connector-page-head .pane-head-beside").innerText().catch(() => "")) === WORDS.tagImported("Cursor"), "after Remove, the page shows Cursor's of the same name");
	same((await statusOf("team-wiki"))?.source?.importKind, "cursor", "the app keeps only Cursor's team-wiki");
	for (const room of rooms) assert(!(await roomGrants(room)).includes("team-wiki"), `and it is on in no room (${room})`);
	assert((await fact(page, WORDS.details.address).innerText()).includes(WORDS.wentWrong.imported("Cursor").fact), "an imported one's page says where to change its address");
	same(await page.locator(".connector-page").getByRole("button", { name: WORDS.button.changeAddress, exact: true }).count(), 0, "and offers no Change address");
	same(await page.locator(".connector-remove-group").innerText(), WORDS.importedNote("Cursor"), "where Remove would be, it says where to remove it");
	await backToList(page);
	same(await row(page, "team-wiki").locator(".connector-dir-kind").innerText(), WORDS.tagImported("Cursor"), "on the list it keeps its origin");
	same(await row(page, "Team wiki").count(), 0, "and ours is gone");

	// Removed with no namesake left: the page goes back to the list, and it leaves the app and every room.
	await openPage(page, "Signed wiki");
	await page.locator(".connector-remove-group").getByRole("button", { name: WORDS.button.remove, exact: true }).click();
	same(await dialog.locator("p").innerText(), WORDS.removeCustomUnused, "with no room using it, the rooms' sentence goes");
	await dialog.getByRole("button", { name: WORDS.button.remove, exact: true }).click();
	await page.locator(".connector-list").waitFor();
	await waitUntil(async () => (await row(page, "Signed wiki").count()) === 0, "a removed connector leaves the list");
	assert(!(await statusOf("signed-wiki")), "and the app");

	// A program needs its command to come back.
	await openPage(page, "Office files");
	await page.locator(".connector-remove-group").getByRole("button", { name: WORDS.button.remove, exact: true }).click();
	same(await dialog.locator("p").innerText(), WORDS.removeProgramUnused, "a program's question, used in no room");
	deletesSent.length = 0;
	await keep("office-files", "Office files");
	await backToList(page);

	// A room that can't be changed: nothing is removed, the page says so with Try again, and Try again finishes it.
	// A folder's refusal can be forced only off Windows and not as root; there, Remove simply goes through.
	await openPage(page, "Board files");
	await page.locator(".connector-remove-group").getByRole("button", { name: WORDS.button.remove, exact: true }).click();
	same(await dialog.locator("p").innerText(), `Board papers stops using it. ${WORDS.removeCustomUnused}`, "one room, named");
	const canForceFsRefusal = process.platform !== "win32" && process.getuid?.() !== 0;
	if (canForceFsRefusal) {
		const lockedRuntime = path.join(agentsRoot, rooms[0], "runtime");
		fs.chmodSync(lockedRuntime, 0o500);
		try {
			await dialog.getByRole("button", { name: WORDS.button.remove, exact: true }).click();
			await page.locator(".connector-page-error").waitFor({ timeout: 10000 });
			same(await page.locator(".connector-page-error span").innerText(), WORDS.remove.failed, "a Remove a room refused says so");
			assert(await statusOf("board-files"), "the connector stays when a room can't be changed");
			assert((await roomGrants(rooms[0])).includes("board-files"), "and stays on in that room");
		} finally {
			fs.chmodSync(lockedRuntime, 0o700);
		}
		await page.locator(".connector-page-error").getByRole("button", { name: WORDS.button.tryAgain, exact: true }).click();
	} else {
		await dialog.getByRole("button", { name: WORDS.button.remove, exact: true }).click();
	}
	await page.locator(".connector-list").waitFor();
	await waitUntil(async () => !(await statusOf("board-files")), "Try again removes it");
	assert(!(await roomGrants(rooms[0])).includes("board-files"), "Try again takes it out of the room");
	await add({ name: "Board files", url: at("/board/mcp") });
	for (const room of rooms) assert(!(await roomGrants(room)).includes("board-files"), `a new connector of the same name is on in no room (${room})`);
	await context.close();

	console.log("connector-page-ui-smoke: the list, the three ways to add, a connector's own page and Remove work as decided");
} catch (error) {
	console.error(error instanceof Error ? error.stack || error.message : error);
	console.error(`temp home kept for a look: ${tempRoot}`);
	process.exitCode = 1;
} finally {
	await browser?.close().catch(() => undefined);
	await stopSmokeServer(server);
	connectors.closeAllConnections();
	connectors.close();
	signInFirst.closeAllConnections();
	signInFirst.close();
	for (const one of standIns) {
		one.closeAllConnections();
		one.close();
	}
	if (process.exitCode !== 1) fs.rmSync(tempRoot, { recursive: true, force: true });
}
