// The page on a shared server: when the client-context probe says
// sharedServer, the controls that only work on someone's own computer are not
// on the page, the settings only an admin may change are read-only with one
// line, Home lists the rooms A to Z with no sort control, the page never asks
// for what such a server refuses, a refused start-up read leaves the page
// usable, and a signed-out person is sent to sign in instead of being told the
// connection is lost. A failed message whose line sends the person to their
// admin offers no button for that: a gateway's bare 403 shows Choose another
// model alone there, and Replace key as well on this computer; a gateway's
// bare 404 handed back before its model list was read tells the person to
// tell the admin there with no button, and on this computer to check the
// gateway, with AI setup's button. With
// sharedServer false every control is there as today. Who is signed in shows
// in the sidebar's footer with the server's sign-out link (when it sends one),
// the admin alone can change the AI setup (never sign a provider in or out),
// a different person on a later read reloads the page, and a room on a shared
// server keeps trying past two minutes. On a shared server the page names the
// person it was opened for on every request and on its socket, and the
// server's refusal of that person (409 person_changed) ends the page; Home's
// dropped socket asks client-context before each rebuild there.
// The probe is intercepted in the page, so one ordinary server serves both.
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, type Browser, type BrowserContext, type Page, type Route, type WebSocketRoute } from "playwright";
import { authedFetch, SMOKE_AUTH_TOKEN, SMOKE_SERVER_AUTH_ENV, SMOKE_SERVER_SPAWN_TREE_OPTIONS, stopSmokeServer, freePort, waitForServer } from "./smoke-server-process.js";
import { closeBrowser, closeContext } from "./smoke-close-context.js";

const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), "exxperts-shared-server-page-"));
process.env.HOME = tempHome;
process.env.USERPROFILE = tempHome;

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const webServerDir = path.resolve(scriptDir, "..");
const port = await freePort();
const baseUrl = `http://127.0.0.1:${port}`;

function assert(condition: unknown, message: string): asserts condition {
	if (!condition) throw new Error(message);
}

function pass(label: string): void {
	console.log(`  ok  ${label}`);
}

// Pinned literals, never built by the code under test.
const SHARED_LINE = "On a shared server, your admin sets this up.";
const NO_FOLDER_LINE = "On a shared server, rooms don't use a folder.";
const LOST_LINE = "exxperts lost its connection. Restarting the app usually fixes this.";
const LOST_SHARED_LINE = "exxperts lost its connection to the server. It usually comes back by itself within a minute. If it doesn't, reload the page.";
const SIGNED_OUT_LINE = "You were signed out. Sign in again to carry on.";
const ADMIN_HINT = "Just made an admin? Sign out and in again to get the admin's controls.";
const PILL_SHARED = "This room lost its connection. It keeps trying by itself.";
const PILL_DESKTOP_FAILED = "This room lost its connection. Use Reconnect to try again, or restart the app if it keeps happening.";
const RECONNECT_SHARED = "Try again now. If it keeps failing, reload the page or tell your admin.";
const RECONNECT_DESKTOP = "The automatic reconnect gave up. Try again now. If it keeps failing, restart exxperts.";
// The words for a missing or gone model, as the word list has them: a member and the admin on a shared server, and
// this computer as today. Each stopped state is a message handed back with the notice, for a key provider (the Claude
// API key) or a sign-in (ChatGPT).
type StoppedWords = { state: string; provider: string; model: string; key?: "missing" | "refused" | "no-workspace"; line: string; buttons: string };
const KEY_MODEL = { provider: "anthropic-api-key", model: "claude-opus-5-5" };
const SIGN_IN_MODEL = { provider: "openai-codex", model: "gpt-6.1-sol" };
const MODEL_WORDS: Record<"member" | "admin" | "computer", { help: string; stopped: StoppedWords[]; picker: string; enter: string; opening: string }> = {
	member: {
		help: "Your AI. Your admin sets up the models for this server. Each room picks one in Room settings, Model.",
		stopped: [
			{ state: "no key", ...KEY_MODEL, key: "missing", line: `Anthropic isn't available on this server. Choose another model to continue this conversation, or tell your admin.`, buttons: "Choose another model" },
			{ state: "a refused key", ...KEY_MODEL, key: "refused", line: `Anthropic did not accept the saved key. Choose another model to continue this conversation, or tell your admin.`, buttons: "Choose another model" },
			// The room's own model is named: the conversation runs on it.
			{ state: "a key outside a workspace", ...KEY_MODEL, key: "no-workspace", line: `GPT-6.1 Terra cannot answer because its key isn't tied to a workspace. Choose another model to continue this conversation, or tell your admin.`, buttons: "Choose another model" },
		],
		picker: "No models yet. Ask your admin to add one in Settings, AI setup.",
		enter: "Ask your admin to add a model in Settings, AI setup.",
		opening: "No AI model is set up on this server yet. Ask your admin to add one in Settings, AI setup, then open the room again.",
	},
	admin: {
		help: "Connect your AI. Open the gear, then Settings, AI setup. Add an API key or connect your company gateway. Set the default models for your rooms there.",
		stopped: [
			{ state: "no key", ...KEY_MODEL, key: "missing", line: `No Claude API key is saved. Add the key again to continue this conversation.`, buttons: "Choose another model|Add key" },
			{ state: "a refused key", ...KEY_MODEL, key: "refused", line: `Anthropic did not accept the saved key. Replace the key to continue this conversation.`, buttons: "Choose another model|Replace key" },
			{ state: "a sign-in gone", ...SIGN_IN_MODEL, line: `ChatGPT isn't available on this server. Choose another model to continue this conversation.`, buttons: "Choose another model" },
		],
		picker: "No models yet. Add an API key or a gateway in Settings, AI setup.",
		enter: "Add an API key or a gateway in Settings, AI setup.",
		opening: "No AI model is set up yet. Add an API key or a gateway in Settings, AI setup, then open the room again.",
	},
	computer: {
		help: "Connect your AI. Open the gear, then Settings, AI setup. Sign in with a subscription, add an API key, or connect your company gateway. Set the default models for your rooms there.",
		stopped: [
			{ state: "no key", ...KEY_MODEL, key: "missing", line: `No Claude API key is saved. Add the key again to continue this conversation.`, buttons: "Choose another model|Add key" },
			{ state: "a sign-in gone", ...SIGN_IN_MODEL, line: `ChatGPT Plus/Pro is signed out. Sign in again to continue this conversation.`, buttons: "Choose another model|Sign in" },
		],
		picker: "Sign in to an AI provider in Settings, AI setup, to choose a model.",
		enter: "Sign in to an AI provider in Settings, AI setup.",
		opening: "No AI provider is signed in. Sign in in Settings, AI setup, then open the room again.",
	},
};
// The server's own sign-out link, as client-context hands it over.
const SIGN_OUT_LINK = "/oauth2/sign_out?rd=https%3A%2F%2Flogin.example.test%2Flogout";
type Person = { id: string; name: string; admin: boolean };
// A name that is markup if it is ever read as markup.
const MEMBER: Person = { id: "11111111-1111-4111-8111-111111111111", name: "<i>Sample</i> Member", admin: false };
const ADMIN: Person = { id: "22222222-2222-4222-8222-222222222222", name: "Sample Admin", admin: true };
const OTHER: Person = { id: "33333333-3333-4333-8333-333333333333", name: "Sample Other", admin: false };
const ORDER_NOT_LOADED = "The saved order could not be loaded";
const BOUNDARY_LINE = "Something went wrong on this page. Reloading usually fixes it.";
const REFUSAL = { error: "Refused by the shared server smoke.", code: "smoke_refused" };
// The edge's answer to a request whose page names a person no longer signed in.
const PERSON_CHANGED = { error: "Another person is signed in on this server now.", code: "person_changed" };
const PAGE_PERSON_HEADER = "x-exxperts-page-person";
const PAGE_PERSON_PROTOCOLS = (person: Person) => ["exxperts", `exxperts-person.${person.id}`];
// Every route a shared server refuses that the page can call, which it must
// not even ask for: any request under these paths...
const NEVER_ASKED: readonly string[] = [
	"/api/remote/",
	"/api/settings/state-profile",
	"/api/settings/state-home/",
	"/api/settings/room-order",
	"/api/whats-new/seen",
	"/api/system/choose-folder",
	"/api/task-store/gc",
	"/api/auth/login",
	"/api/auth/logout",
	"/api/auth/api-key",
	"/api/mcp/",
	"/api/skills/featured",
	"/api/skills/repo/",
	"/api/web-search/searxng/setup",
	"/api/usage",
	"/api/knowledge/",
];
// ...and these room paths, whatever the method...
const NEVER_READ: readonly RegExp[] = [/^\/api\/persistent-agents\/[^/]+\/(prompt-diagnostics|reattach-buffer-stats)$/];
// ...and any change (a method other than GET) to these, whose reads are open.
const NEVER_CHANGED: readonly RegExp[] = [
	/^\/api\/ai\/defaults$/,
	/^\/api\/settings\/(instructions|web-search)$/,
	/^\/api\/skills(\/|$)/,
	/^\/api\/persistent-agent-ai-profile(s\/|$)/,
	/^\/api\/persistent-agents\/[^/]+\/(workspace-default|workspace-policy|bash-settings|workspace\/validate|consult)$/,
	/^\/api\/persistent-agents\/[^/]+\/files\/[^/]+\/save$/,
	/^\/api\/artifacts\/[^/]+\/export$/,
];
// Never counted: the probe itself, which the smoke answers.
const ALWAYS_ASKED: readonly string[] = ["/api/remote/client-context"];

// What the organisation's admin may do on top of everyone: the AI setup's writes.
// Provider sign-in and sign-out (login, logout) are refused for the admin too.
const ADMIN_MAY_ASK: readonly string[] = ["/api/auth/api-key"];
const ADMIN_MAY_CHANGE: readonly RegExp[] = [/^\/api\/ai\/defaults$/, /^\/api\/persistent-agent-ai-profile(s\/|$)/];

/** Whether a shared server refuses this request (method and path, no query) for this person. */
function refusedOnSharedServer(method: string, pathname: string, admin: boolean): boolean {
	if (ALWAYS_ASKED.includes(pathname)) return false;
	if (admin && ADMIN_MAY_ASK.includes(pathname)) return false;
	if (NEVER_ASKED.some((prefix) => pathname === prefix.replace(/\/$/, "") || pathname.startsWith(prefix.endsWith("/") ? prefix : `${prefix}/`))) return true;
	if (NEVER_READ.some((pattern) => pattern.test(pathname))) return true;
	if (admin && ADMIN_MAY_CHANGE.some((pattern) => pattern.test(pathname))) return false;
	return method !== "GET" && method !== "HEAD" && NEVER_CHANGED.some((pattern) => pattern.test(pathname));
}

const ROOMS = ["Beta Room", "Alpha Room", "Bash Room"];
const A_TO_Z = ["Alpha Room", "Bash Room", "Beta Room"];
const Z_TO_A = ["Beta Room", "Bash Room", "Alpha Room"];
const SHELF_FILE = "notes.txt";
// Home's socket retries within seconds and the warning waits out a 12-second
// grace after at least two failed attempts; a minute is ample.
const OUTAGE_LIMIT_MS = 60_000;

// A signed-in provider, so AI setup draws its rows and the rooms have a model.
const agentDir = path.join(tempHome, ".exxperts", "agent");
fs.mkdirSync(agentDir, { recursive: true, mode: 0o700 });
fs.writeFileSync(path.join(agentDir, "auth.json"), JSON.stringify({ "openai-codex": { type: "api_key", key: "sk-smoke" } }), { mode: 0o600 });
const workspaceRoot = path.join(tempHome, "bash-room-folder");
fs.mkdirSync(workspaceRoot, { recursive: true });

let server: ChildProcessWithoutNullStreams | null = null;

async function api(method: string, url: string, body?: unknown): Promise<any> {
	const res = await authedFetch(`${baseUrl}${url}`, { method, headers: { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
	const text = await res.text();
	assert(res.ok, `${method} ${url}: ${res.status} ${text}`);
	return text ? JSON.parse(text) : null;
}

// --- apiFetch with no browser: the page's person joins the caller's own headers in every form, and the server's 409s ---
{
	const realFetch = globalThis.fetch;
	let reloads = 0;
	const reloaded = () => reloads;
	const sent: Request[] = [];
	let answer = (): Response => Response.json({});
	// The page's reload, counted; fetch builds the request the browser would send, from the same arguments.
	Object.assign(globalThis, { location: { reload: () => { reloads += 1; } } });
	globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
		sent.push(new Request(input instanceof Request ? input : new URL(String(input), "http://page.test"), init));
		return answer();
	}) as typeof fetch;
	try {
		const api = await import("../../web-ui/src/api.js");
		const clientContext = await import("../../web-ui/src/remote-client-context.js");
		const last = () => sent[sent.length - 1];
		await api.apiFetch("/api/before", { headers: { "X-Caller": "kept" } });
		assert(!last().headers.has(PAGE_PERSON_HEADER) && last().headers.get("x-caller") === "kept", "apiFetch: a page that knows no person named one");
		answer = () => Response.json({ remote: false, capability: "full", sharedServer: true, person: MEMBER });
		await clientContext.fetchRemoteClientContext();
		answer = () => Response.json({});
		const forms: Array<[string, () => Promise<Response>]> = [
			["a plain object", () => api.apiFetch("/api/a", { headers: { "X-Caller": "kept" } })],
			["a Headers object", () => api.apiFetch("/api/a", { method: "POST", body: "{}", headers: new Headers({ "X-Caller": "kept" }) })],
			["a list of pairs", () => api.apiFetch("/api/a", { headers: [["X-Caller", "kept"]] })],
			["a Request", () => api.apiFetch(new Request("http://page.test/api/a", { headers: { "X-Caller": "kept" } }))],
			["no headers", () => api.apiFetch("/api/a")],
		];
		for (const [form, call] of forms) {
			await call();
			assert(last().headers.get(PAGE_PERSON_HEADER) === MEMBER.id, `apiFetch with ${form}: the page's person is not named, got ${JSON.stringify(last().headers.get(PAGE_PERSON_HEADER))}`);
			assert(form === "no headers" || last().headers.get("x-caller") === "kept", `apiFetch with ${form}: the caller's own header was lost`);
		}
		pass("apiFetch: no person, no header; with one, X-Exxperts-Page-Person names it beside the caller's own headers (plain object, Headers, pairs, a Request)");
		answer = () => Response.json({ error: "This room is busy.", code: "room_busy" }, { status: 409 });
		const conflict = await api.fetchJson("/api/b").then(() => null, (error: unknown) => error);
		assert(conflict instanceof api.ApiRequestError && conflict.status === 409 && conflict.code === "room_busy" && conflict.message === "This room is busy.", `apiFetch: another 409 did not reach its caller as the server's answer: ${String(conflict)}`);
		assert(!clientContext.personHasChanged() && reloaded() === 0, "apiFetch: another 409 ended the page");
		answer = () => Response.json(PERSON_CHANGED, { status: 409 });
		const refused = await Promise.allSettled([api.apiFetch("/api/c"), api.apiFetch("/api/d")]);
		assert(refused.every((result) => result.status === "rejected"), "apiFetch: a 409 person_changed came back to its caller as an answer");
		assert(clientContext.personHasChanged() && reloaded() === 1, `apiFetch: two 409 person_changed did not end the page once (${reloaded()} reloads)`);
		const before = sent.length;
		await api.apiFetch("/api/e").catch(() => {});
		assert(sent.length === before, "apiFetch: a request was sent after the page ended");
		pass("apiFetch: another 409 reaches its caller as today; 409 person_changed ends the page once and nothing is sent after it");
	} finally {
		globalThis.fetch = realFetch;
		Reflect.deleteProperty(globalThis, "location");
	}
}

// Environments without an installed Chromium (the Linux Docker gate sets
// EXXETA_SKIP_BROWSER_INSTALL=1) cannot run a browser assertion at all; skip
// whole, as the other browser smokes do.
{
	const p = typeof chromium?.executablePath === "function" ? chromium.executablePath() : "";
	if (!p || !fs.existsSync(p)) {
		console.log("shared server page smoke skipped (Chromium not installed)");
		fs.rmSync(tempHome, { recursive: true, force: true });
		process.exit(0);
	}
}

/** What the probe answers now: a test changes it between reads, or has the next ones fail. */
type ProbeAnswer = { person?: Person; signOut?: string; remote?: boolean; refuse?: boolean; fail: boolean; stall: boolean; holdNext: boolean; holding: boolean; released: number; release: (fail?: boolean) => void };
type Opened = { context: BrowserContext; page: Page; asked: string[]; probe: ProbeAnswer; reads: () => number; pending: () => number };

/** A signed-in page whose client-context probe answers sharedServer, and the person and sign-out link, as given. */
async function openApp(browser: Browser, sharedServer: boolean, prepare?: (context: BrowserContext) => Promise<unknown>, who: { person?: Person; signOut?: string; remote?: boolean; fail?: boolean } = {}): Promise<Opened> {
	const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
	const probe: ProbeAnswer = { ...who, fail: who.fail === true, stall: false, holdNext: false, holding: false, released: 0, release: () => {} };
	const answerBody = () => JSON.stringify({ remote: probe.remote === true, capability: "full", sharedServer, ...(probe.person ? { person: probe.person } : {}), ...(probe.signOut ? { signOut: probe.signOut } : {}) });
	await context.route("**/api/remote/client-context", async (route) => {
		// Never answered: the page's own deadline has to end it.
		if (probe.stall) return;
		// The edge refuses the person the page names.
		if (probe.refuse) return route.fulfill({ status: 409, contentType: "application/json", body: JSON.stringify(PERSON_CHANGED) });
		// The next question: its answer is fixed now (who is signed in at this moment) but sent only when released,
		// or it fails then: an answer or a failure that comes late, once the page has moved on.
		if (probe.holdNext) {
			probe.holdNext = false;
			const body = answerBody();
			probe.holding = true;
			const fail = await new Promise<boolean>((resolve) => { probe.release = (failed = false) => resolve(failed); });
			probe.holding = false;
			probe.released += 1;
			return fail ? route.abort() : route.fulfill({ contentType: "application/json", body });
		}
		if (probe.fail) return route.abort();
		return route.fulfill({ contentType: "application/json", body: answerBody() });
	});
	if (prepare) await prepare(context);
	const page = await context.newPage();
	const asked: string[] = [];
	let reads = 0;
	let pending = 0;
	pendingOf.set(page, () => pending);
	let roomReadies = 0;
	roomReadyOf.set(page, () => roomReadies);
	page.on("websocket", (socket) => {
		if (!socket.url().includes("persistentAgentId=")) return;
		socket.on("framereceived", (frame) => { try { if (JSON.parse(String(frame.payload))?.type === "ready") roomReadies += 1; } catch {} });
	});
	page.on("request", () => { pending += 1; });
	page.on("requestfinished", () => { pending -= 1; });
	page.on("requestfailed", () => { pending -= 1; });
	page.on("request", (request) => {
		const { pathname } = new URL(request.url());
		if (pathname === "/api/remote/client-context") reads += 1;
		if (refusedOnSharedServer(request.method(), pathname, probe.person?.admin === true)) asked.push(`${request.method()} ${pathname}`);
	});
	await page.goto(`${baseUrl}/auth/session?token=${SMOKE_AUTH_TOKEN}`);
	await page.waitForLoadState("networkidle");
	const dismiss = page.locator(".whats-new-close");
	if (await dismiss.count()) await dismiss.click();
	await page.locator(".persistent-agent-card").first().waitFor({ timeout: 15000 });
	return { context, page, asked, probe, reads: () => reads, pending: () => pending };
}

// Each opened page's count of requests in flight, for the helpers that are handed only the page.
const pendingOf = new WeakMap<Page, () => number>();
// Each opened page's count of ready frames on its room sockets: a room counts as entered once its socket said ready,
// so a step that drops the connection next always lands on a ready room.
const roomReadyOf = new WeakMap<Page, () => number>();

/** settled() that leaves out a probe read the row holds on purpose. */
function besideHeld(opened: Opened): Pick<Opened, "page" | "pending"> {
	return { page: opened.page, pending: () => opened.pending() - (opened.probe.holding ? 1 : 0) };
}

/** settled() for a helper that has only the page. */
async function settledPage(page: Page): Promise<void> {
	await settled({ page, pending: pendingOf.get(page) ?? (() => 0) });
}

/** Polls until the condition holds, or fails with the message. */
async function until(condition: () => boolean | Promise<boolean>, message: string, timeoutMs = 15000): Promise<void> {
	const end = Date.now() + timeoutMs;
	while (Date.now() < end) {
		if (await condition()) return;
		await new Promise((resolve) => setTimeout(resolve, 50));
	}
	throw new Error(message);
}

/** Whether the condition comes true within the time; a wait for something that should NOT happen. */
async function appears(condition: () => boolean | Promise<boolean>, timeoutMs: number): Promise<boolean> {
	const end = Date.now() + timeoutMs;
	while (Date.now() < end) {
		if (await condition()) return true;
		await new Promise((resolve) => setTimeout(resolve, 50));
	}
	return false;
}

/** Nothing in flight and the page has drawn twice since: the point to assert that something did NOT happen. */
async function settled(opened: Pick<Opened, "page" | "pending">): Promise<void> {
	// A long-lived request (a stream) may never end: the wait is bounded.
	await appears(() => opened.pending() <= 0, 3000);
	await opened.page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
}

/** The rooms' names in the order Home draws their cards. */
async function cardOrder(page: Page): Promise<string[]> {
	const texts = await page.locator(".persistent-agent-card").allInnerTexts();
	return texts.map((text) => ROOMS.find((name) => text.includes(name)) ?? "?");
}

async function openSettings(page: Page): Promise<void> {
	await page.locator(".product-sidebar-footer button").first().click();
	await page.locator(".sidebar-config-menu button, .sidebar-config-menu a").filter({ hasText: /Settings/ }).first().click();
	await page.waitForSelector(".settings-overlay", { timeout: 10000 });
}

async function openTab(page: Page, tab: string): Promise<void> {
	await page.locator(".settings-dialog-nav button").filter({ hasText: tab }).first().click();
	await settledPage(page);
}

async function tabCount(page: Page, tab: string): Promise<number> {
	return page.locator(".settings-dialog-nav button").filter({ hasText: tab }).count();
}

async function closeSettings(page: Page): Promise<void> {
	const overlay = page.locator(".settings-overlay");
	await page.keyboard.press("Escape");
	if (!(await appears(async () => (await overlay.count()) === 0, 1000))) {
		await page.locator(".settings-dialog-close").first().click();
		await overlay.waitFor({ state: "detached", timeout: 5000 });
	}
}

async function enterRoom(page: Page, name: string): Promise<void> {
	await page.goto(`${baseUrl}/`);
	await page.waitForLoadState("networkidle");
	// "Enter" the first time, "Resume" once the room has a conversation.
	await openRoomFromHome(page, name);
	await settledPage(page);
}

// A prompt on unsaved work that holds the reload: the page stays, so what it still does is seen.
async function holdReload(page: Page): Promise<void> {
	await page.evaluate(() => window.addEventListener("beforeunload", (event) => { event.preventDefault(); event.returnValue = ""; }));
	page.on("dialog", (dialog) => void dialog.dismiss());
}

/** Into a room from Home, and back to Home from a room, without reloading the page. In a room means its socket said ready. */
async function openRoomFromHome(page: Page, name: string): Promise<void> {
	const readies = roomReadyOf.get(page);
	assert(readies, "a page not opened by openApp has no ready count");
	const before = readies();
	await page.locator(".persistent-agent-card").filter({ hasText: name }).locator(".persistent-agent-primary-actions .landing-action").first().click();
	await page.locator('button.icon-btn[aria-label="Room settings"]').waitFor({ timeout: 15000 });
	await until(() => readies() > before, `${name}: the room's live connection did not say ready`);
}

async function leaveRoomToHome(page: Page): Promise<void> {
	await page.locator(".sidebar-home-btn").click();
	await page.locator(".persistent-agent-card").first().waitFor({ timeout: 15000 });
}

async function openRoomWorkspace(page: Page): Promise<void> {
	await page.locator('button.icon-btn[aria-label="Room settings"]').click();
	await page.locator(".settings-dialog-nav button").filter({ hasText: "Folder" }).first().click();
	await page.locator(".room-workspace-section").waitFor({ timeout: 10000 });
	await settledPage(page);
}

async function openShelfFile(page: Page): Promise<void> {
	// The panel names a shelf file without its extension.
	await page.locator(".attachments-entry").click();
	await page.locator(".att-card").filter({ hasText: SHELF_FILE.replace(/\.txt$/, "") }).first().locator(".att-open").click();
	await page.locator(".artifact-viewer-quiet").filter({ hasText: "Download" }).first().waitFor({ timeout: 10000 });
}

async function countText(page: Page, scope: string, text: string): Promise<number> {
	return page.locator(scope).getByText(text, { exact: true }).count();
}

/**
 * Home with its live connection passed through to the server until drop(),
 * after which every connection is closed at once: the server is still there,
 * but the page cannot reach it live, as when a sign-in runs out.
 */
async function openWithDroppableConnection(browser: Browser, sharedServer: boolean, signedOut: boolean, setUp?: (context: BrowserContext) => Promise<unknown>): Promise<{ opened: Opened; drop: () => void; isLive: () => boolean }> {
	let dropped = false;
	const live: WebSocketRoute[] = [];
	const opened = await openApp(browser, sharedServer, async (context) => {
		await setUp?.(context);
		await context.routeWebSocket(/\/ws(\?|$)/, (ws) => {
			if (dropped) {
				void ws.close();
				return;
			}
			ws.connectToServer();
			live.push(ws);
		});
		if (signedOut) {
			await context.route("**/api/auth/status", (route) =>
				dropped
					? route.fulfill({ status: 401, contentType: "application/json", body: JSON.stringify({ error: "Not signed in.", code: "auth_required" }) })
					: route.continue());
		}
	});
	return {
		opened,
		isLive: () => live.length > 0,
		drop: () => {
			dropped = true;
			for (const ws of live.splice(0)) void ws.close();
		},
	};
}

try {
	server = spawn("npx", ["tsx", "src/index.ts"], {
		shell: process.platform === "win32",
		...SMOKE_SERVER_SPAWN_TREE_OPTIONS,
		cwd: webServerDir,
		env: { ...process.env, PORT: String(port), ...SMOKE_SERVER_AUTH_ENV },
		stdio: ["ignore", "pipe", "pipe"],
	}) as unknown as ChildProcessWithoutNullStreams;
	await waitForServer(server, baseUrl, { tries: 200 });

	const ids: Record<string, string> = {};
	for (const name of ROOMS) {
		const created = await api("POST", "/api/persistent-agents", { displayName: name, userName: "Synthetic User", preferredUserAddress: "Synthetic User" });
		ids[name] = created.agentId ?? created.id ?? created.agent?.id;
		assert(typeof ids[name] === "string", `room create answered no id: ${JSON.stringify(created)}`);
	}
	// A saved order the shared page must not use: Z to A here, A to Z there.
	await api("PUT", "/api/settings/room-order", { mode: "name-desc" });
	// A room with a folder and commands on: its chip, Edit and Clear.
	await api("PUT", `/api/persistent-agents/${encodeURIComponent(ids["Bash Room"])}/workspace-default`, { root: workspaceRoot, displayLabel: "Bash Room Folder", workspaceAccessMode: "localFiles", bashEnabled: true });
	// A file on Alpha Room's shelf: its viewer offers Save….
	await api("POST", `/api/persistent-agents/${encodeURIComponent(ids["Alpha Room"])}/files`, { filename: SHELF_FILE, contentBase64: Buffer.from("shared server smoke\n").toString("base64") });

	const browser = await chromium.launch();
	try {
		// --- the first read failed, then a later one answered: on a shared server who it is can't be told, on this computer nothing changes ---
		for (const sharedServer of [true, false]) {
			const where = sharedServer ? "shared" : "this computer";
			const opened = await openApp(browser, sharedServer, undefined, { fail: true });
			const { context, page, probe, reads } = opened;
			await holdReload(page);
			// Someone is signed in by now, and the page cannot know whether it is whom it was opened for.
			if (sharedServer) probe.person = OTHER;
			probe.fail = false;
			const before = reads();
			await page.evaluate(() => window.dispatchEvent(new Event("focus")));
			await until(() => reads() > before, `${where}: a focus did not read again`);
			if (sharedServer) {
				const cover = page.locator(".person-changed-cover");
				await cover.waitFor({ timeout: 15000 });
				const words = await cover.innerText();
				assert(!/Someone else/.test(words), `shared: the page claims another person when it may be the same one: ${JSON.stringify(words)}`);
				assert((await page.locator(".product-sidebar-footer .signed-in-as").count()) === 0, "shared: the page adopted whoever is signed in now");
				pass("shared: a failed first read and a later answer with a person: the page is ended (Reload held), not adopted, and its words do not say another person");
			} else {
				await settled(opened);
				assert((await page.locator(".person-changed-cover").count()) === 0, "this computer: a failed first read and a desktop answer ended the page");
				assert((await page.locator(".room-sort").count()) === 1, "this computer: the page is not as the desktop's after the answer");
				pass("this computer: a failed first read and a later desktop answer is adopted quietly");
			}
			await closeContext(context);
		}

		// --- sharedServer: true, a read held across the second person's sign-in: a refresh does not take its old answer ---
		{
			const live: WebSocketRoute[] = [];
			const opened = await openApp(browser, true, async (ctx) => {
				await ctx.routeWebSocket(/\/ws(\?|$)/, (ws) => {
					ws.connectToServer();
					live.push(ws);
				});
			}, { person: MEMBER });
			const { context, page, probe } = opened;
			const threadRequests: string[] = [];
			let watching = false;
			page.on("request", (request) => {
				if (watching && /\/api\/persistent-agents\/[^/]+\/threads\//.test(new URL(request.url()).pathname)) threadRequests.push(`${request.method()} ${new URL(request.url()).pathname}`);
			});
			await enterRoom(page, "Beta Room");
			await page.evaluate(() => window.addEventListener("beforeunload", (event) => { event.preventDefault(); event.returnValue = ""; }));
			page.on("dialog", (dialog) => void dialog.dismiss());
			// The room drops; its retry's question is sent and held, answered by the first person.
			probe.holdNext = true;
			for (const ws of live.splice(0)) void ws.close();
			await until(() => probe.holding, "held read: the room never retried", 30000);
			// The second person signs in; the page gets the focus back while that read is still out.
			probe.person = OTHER;
			watching = true;
			await page.evaluate(() => window.dispatchEvent(new Event("focus")));
			probe.release();
			// A reconnect that went on from the first answer would read the thread before the fresh read ends the page.
			await page.locator(".person-changed-cover").waitFor({ timeout: 15000 });
			await settled(opened);
			assert(threadRequests.length === 0, `held read: the reconnect went on from the first person's answer and read or saved a room as the second: ${threadRequests.join(", ")}`);
			pass("shared: a read held across the second person's sign-in: the refresh takes a fresh read, the page ends, and no thread is read or saved");
			await closeContext(context);
		}

		// --- sharedServer: true, a room's retry whose first question fails late, after the person went to another room ---
		{
			const live: WebSocketRoute[] = [];
			let droppedRoom: string | null = null;
			const opened = await openApp(browser, true, async (ctx) => {
				await ctx.clock.install();
				await ctx.routeWebSocket(/\/ws(\?|$)/, (ws) => {
					if (droppedRoom && ws.url().includes(droppedRoom)) {
						void ws.close();
						return;
					}
					ws.connectToServer();
					live.push(ws);
				});
			}, { person: MEMBER });
			const { context, page, probe } = opened;
			const otherRoomThread: string[] = [];
			page.on("request", (request) => {
				if (new URL(request.url()).pathname.includes(`/api/persistent-agents/${ids["Alpha Room"]}/threads/`)) otherRoomThread.push(`${request.method()} ${new URL(request.url()).pathname}`);
			});
			await enterRoom(page, "Beta Room");
			// Beta Room loses its connection; its retry's first question is held, to fail once the person has moved on.
			droppedRoom = ids["Beta Room"];
			probe.holdNext = true;
			for (const ws of live.splice(0)) void ws.close();
			await until(() => probe.holding, "late preflight: the room never retried", 30000);
			// The person leaves for another room while that question is out.
			await leaveRoomToHome(page);
			await openRoomFromHome(page, "Alpha Room");
			// What the other room's entry set off on a timer (its first save) is done before the window opens.
			await page.clock.runFor(5000);
			await settled(besideHeld(opened));
			const windowStart = otherRoomThread.length;
			// It fails now, and the server answers from here: a retry wrongly scheduled for the other room would get as far as its
			// thread within the ladder's next delays, which the clock runs through.
			probe.release(true);
			for (let second = 0; second < 10; second += 1) {
				await page.clock.runFor(1000);
				await settled(opened);
			}
			assert(otherRoomThread.length === windowStart, `late preflight: the first room's late failure made the other room read or save its thread: ${otherRoomThread.slice(windowStart).join(", ")}`);
			await settled(opened);
			assert((await page.locator(".composer-reconnect-btn").count()) === 0, "late preflight: the other room shows Reconnect");
			pass("shared: a room's retry that fails late, after the person went to another room, does nothing to that other room");
			await closeContext(context);
		}

		// --- sharedServer: true, an admin demoted, then Settings opened for the first time ---
		{
			// A component that is mounted after the role went asks the answer anew: it must get the newest one, not the first.
			const opened = await openApp(browser, true, undefined, { person: ADMIN, signOut: SIGN_OUT_LINK });
			const { context, page, probe } = opened;
			assert((await page.locator(".product-sidebar-footer .signed-in-as-tag").count()) === 1, "demoted admin: the Admin tag is missing at the start");
			probe.person = { ...ADMIN, admin: false };
			await page.evaluate(() => window.dispatchEvent(new Event("focus")));
			await until(async () => (await page.locator(".product-sidebar-footer .signed-in-as-tag").count()) === 0, "demoted admin: the footer still shows the Admin tag after the read");
			await openSettings(page);
			await openTab(page, "AI setup");
			await until(async () => (await countText(page, ".settings-overlay", ADMIN_HINT)) === 2, "demoted admin: Settings opened afterwards shows the old role (the setup is still open)");
			assert((await page.locator(".settings-overlay .add-provider-toggle").count()) === 0, "demoted admin: Settings opened afterwards offers Add provider");
			assert((await page.locator(".settings-overlay .ai-defaults-group .room-model-pick:not(:disabled)").count()) === 0, "demoted admin: Settings opened afterwards lets the default models be changed");
			pass("shared: after an admin is demoted, Settings opened for the first time shows the new role");
			await closeContext(context);
		}

		// --- sharedServer: true, a member ---
		{
			const { context, page, asked } = await openApp(browser, true, undefined, { person: MEMBER, signOut: SIGN_OUT_LINK });
			const footer = page.locator(".product-sidebar-footer .signed-in-as");
			assert((await footer.innerText()).replace(/\s+/g, " ").trim() === "Signed in as <i>Sample</i> Member Sign out", `shared Home: the footer does not read as the member signed in, got ${JSON.stringify(await footer.innerText())}`);
			assert((await footer.locator("i, b, script").count()) === 0, "shared Home: the name was read as markup");
			assert((await footer.locator(".signed-in-as-tag").count()) === 0, "shared Home: a member carries the Admin tag");
			assert((await footer.locator("a").getAttribute("href")) === SIGN_OUT_LINK, "shared Home: Sign out does not go to the server's link");

			assert(JSON.stringify(await cardOrder(page)) === JSON.stringify(A_TO_Z), `shared Home: rooms not A to Z: ${await cardOrder(page)}`);
			assert((await page.locator(".room-sort").count()) === 0, "shared Home: the sort control is on the page");
			assert((await page.getByText(ORDER_NOT_LOADED).count()) === 0, "shared Home: the order-not-loaded sentence is on the page");
			assert((await page.locator(".product-nav button").filter({ hasText: "Wallet" }).count()) === 0, "shared Home: the Wallet button is on the page");
			assert((await page.locator(".remote-on-pill").count()) === 0, "shared Home: the remote pill is on the page");
			pass("shared: Home lists the rooms A to Z with no sort control, no order sentence, no Wallet and no remote pill, and the footer says who is signed in, as text, with the server's Sign out link");

			await openSettings(page);
			assert((await tabCount(page, "Remote access")) === 0, "shared Settings: Remote access is offered");
			assert((await tabCount(page, "Profiles")) === 0, "shared Settings: Profiles is offered");

			await openTab(page, "AI setup");
			assert((await countText(page, ".settings-overlay .ai-defaults-group", SHARED_LINE)) === 1, "shared AI setup: the default models have no shared-server line");
			assert((await countText(page, ".settings-overlay", SHARED_LINE)) === 2, "shared AI setup: expected the line under the default models and under the providers");
			assert((await countText(page, ".settings-overlay", ADMIN_HINT)) === 2, "shared AI setup: a member does not get the new admin's hint beside both lines");
			for (const selector of [".add-provider-toggle", ".ai-profile-signin", ".ai-profile-menu-btn", ".ai-defaults-group .room-model-pick:not(:disabled)"]) {
				assert((await page.locator(`.settings-overlay ${selector}`).count()) === 0, `shared AI setup: ${selector} is operable`);
			}
			assert((await page.locator(".settings-overlay .ai-defaults-group .room-model-pick").count()) === 2, "shared AI setup: the two default models are not shown");

			await openTab(page, "Web search");
			assert((await countText(page, ".settings-overlay", SHARED_LINE)) === 1, "shared Web search: no shared-server line");
			for (const selector of ['input[type="checkbox"]', 'input[type="radio"]', "select"]) {
				assert((await page.locator(`.settings-overlay ${selector}`).count()) === 0, `shared Web search: ${selector} is operable`);
			}

			await openTab(page, "Instructions");
			assert((await countText(page, ".settings-overlay", SHARED_LINE)) === 1, "shared Instructions: no shared-server line");
			assert((await page.locator(".settings-overlay .room-instructions-textarea[readonly]").count()) === 1, "shared Instructions: the text can be edited");
			assert((await page.locator(".settings-overlay .room-instructions-section button").filter({ hasText: /^Save$/ }).count()) === 0, "shared Instructions: Save is offered");

			await openTab(page, "Connectors");
			assert((await countText(page, ".settings-overlay", SHARED_LINE)) === 1, "shared Connectors: no shared-server line");
			for (const selector of [".connector-dir-search", ".connector-dir-row button", ".connector-row-actions button"]) {
				assert((await page.locator(`.settings-overlay ${selector}`).count()) === 0, `shared Connectors: ${selector} is on the page`);
			}

			await openTab(page, "Skills");
			assert((await countText(page, ".settings-overlay", SHARED_LINE)) === 1, "shared Skills: no shared-server line");
			assert((await page.locator(".settings-overlay .pane-head-actions button").count()) === 0, "shared Skills: Browse featured or Add skill is offered");
			await closeSettings(page);
			pass("shared: Settings has no Remote access or Profiles; AI setup, its default models, web search, instructions, connectors and skills are read-only with the line");
			assert(asked.length === 0, `shared start, Home and Settings: the page asked for what a shared server refuses: ${asked.join(", ")}`);
			pass("shared start, Home and Settings: the page never asked for a refused route (the clean-up read at start included)");

			await enterRoom(page, "Bash Room");
			const railFooter = page.locator(".sidebar-footer .signed-in-as");
			assert((await railFooter.innerText()).replace(/\s+/g, " ").trim() === "Signed in as <i>Sample</i> Member Sign out", `shared room: the rail's footer does not say who is signed in, got ${JSON.stringify(await railFooter.innerText())}`);
			assert((await railFooter.locator("a").getAttribute("href")) === SIGN_OUT_LINK, "shared room: the rail's Sign out does not go to the server's link");
			assert((await page.locator(".bash-mode-chip").count()) === 0, "shared room: the Bash chip is on the page");
			await openRoomWorkspace(page);
			for (const label of ["Edit", "Clear", "Choose folder"]) {
				assert((await page.locator(".room-workspace-section button").filter({ hasText: label }).count()) === 0, `shared room with a folder: ${label} is offered`);
			}
			await closeSettings(page);

			await enterRoom(page, "Alpha Room");
			await openRoomWorkspace(page);
			assert((await page.locator(".room-workspace-section button").filter({ hasText: "Choose folder" }).count()) === 0, "shared room without a folder: Choose folder is offered");
			assert((await countText(page, ".room-workspace-section", NO_FOLDER_LINE)) === 1, "shared room without a folder: no shared-server line");
			await closeSettings(page);
			await openShelfFile(page);
			assert((await page.locator(".artifact-viewer-quiet").filter({ hasText: "Save…" }).count()) === 0, "shared room: Save… is offered for a shelf file");
			pass("shared: rooms offer no Bash chip, no folder editor, no Choose folder and no Save…");

			assert(asked.length === 0, `shared rooms and room settings: the page asked for what a shared server refuses: ${asked.join(", ")}`);
			pass("shared rooms and room settings: the page never asked for a refused route");
			await closeContext(context);
		}

		// --- sharedServer: true, the organisation's admin ---
		{
			const { context, page, asked, probe } = await openApp(browser, true, undefined, { person: ADMIN, signOut: SIGN_OUT_LINK });
			const footer = page.locator(".product-sidebar-footer .signed-in-as");
			assert((await footer.locator(".signed-in-as-tag").innerText()) === "Admin", "admin Home: the Admin tag is missing");
			await openSettings(page);
			await openTab(page, "AI setup");
			assert((await countText(page, ".settings-overlay", SHARED_LINE)) === 0 && (await countText(page, ".settings-overlay", ADMIN_HINT)) === 0, "admin AI setup: the read-only line is shown");
			assert((await page.locator(".settings-overlay .add-provider-toggle").count()) === 1, "admin AI setup: Add provider is missing");
			assert((await page.locator(".settings-overlay .ai-defaults-group .room-model-pick:not(:disabled)").count()) === 2, "admin AI setup: the default models cannot be changed");
			// A write the admin may make goes through.
			const saved = page.waitForResponse((res) => new URL(res.url()).pathname === "/api/ai/defaults" && res.request().method() === "PUT", { timeout: 10000 });
			await page.locator(".settings-overlay .ai-defaults-group .room-model-pick").first().click();
			await page.locator('.room-model-menu [role="option"][aria-selected="false"]:not(.unpickable)').first().click();
			assert((await saved).status() === 200, "admin AI setup: the default model was refused");
			// Provider sign-in and sign-out are not offered, in a row's menu or in the list to add from.
			await page.locator(".settings-overlay .ai-profile-menu-btn").first().click();
			const menuItems = (await page.locator(".ai-profile-menu [role=menuitem], [role=menuitem].ai-profile-menu-item").allInnerTexts()).map((text) => text.trim());
			assert(menuItems.length > 0, "admin AI setup: a provider's menu has no items");
			assert(!menuItems.some((text) => /^Sign (in again|out)$/.test(text)), `admin AI setup: a provider's menu offers sign-in or sign-out: ${menuItems.join("|")}`);
			await page.keyboard.press("Escape");
			await page.locator(".settings-overlay .add-provider-toggle").click();
			await page.locator(".add-provider-block").getByRole("button", { name: "Add key" }).first().waitFor({ timeout: 10000 });
			const adding = await page.locator(".add-provider-block").innerText();
			assert(!/Subscription|Sign in|Remove key|Keys stay on this device/.test(adding), `admin AI setup: the list to add from offers a sign-in, a key removal or a device line: ${adding}`);
			assert(/Add gateway/.test(adding) && /Add key/.test(adding), "admin AI setup: a gateway and a key can't be added");
			// A read that takes the admin's role away closes what is open (a row's key form too) and locks the setup.
			const addKey = page.locator(".settings-overlay .ai-profile-signin").filter({ hasText: "Add API key" });
			assert((await addKey.count()) >= 1, `admin AI setup: no row offers Add API key: ${(await page.locator(".settings-overlay .ai-profile-signin").allInnerTexts()).join("|")}`);
			await addKey.first().click();
			await page.locator(".settings-overlay .ai-profile-key-form").waitFor({ timeout: 10000 });
			// A default-model menu left open must close too: it is portaled, and would still take a pick.
			await page.locator(".settings-overlay .ai-defaults-group .room-model-pick").first().click();
			await page.locator(".room-model-menu").waitFor({ timeout: 10000 });
			probe.person = { ...ADMIN, admin: false };
			await page.evaluate(() => window.dispatchEvent(new Event("focus")));
			await until(async () => (await countText(page, ".settings-overlay", ADMIN_HINT)) === 2, "admin AI setup: the setup stayed open after the admin's role was taken away");
			await until(async () => (await page.locator(".room-model-menu").count()) === 0, "admin AI setup: a default-model menu stayed open after the admin's role was taken away");
			assert((await page.locator(".settings-overlay .ai-profile-key-form, .settings-overlay .add-provider-key-form").count()) === 0, "admin AI setup: a key form stayed open after the admin's role was taken away");
			assert((await page.locator(".settings-overlay .add-provider-toggle").count()) === 0, "admin AI setup: Add provider stayed after the admin's role was taken away");
			await closeSettings(page);
			assert(asked.length === 0, `admin: the page asked for what a shared server refuses even for its admin: ${asked.join(", ")}`);
			pass("shared admin: Admin tag, the AI setup open (a default model saved), no sign-in or sign-out or key removal anywhere, and the page asked for nothing refused");
			await closeContext(context);
		}

		// --- sharedServer: true, no sign-out link and no name; then the person changing ---
		{
			const bare = await openApp(browser, true, undefined, { person: { ...MEMBER, name: "" } });
			assert((await bare.page.locator(".product-sidebar-footer .signed-in-as").count()) === 0, "shared without a name or link: the footer shows something");
			await closeContext(bare.context);
			const noLink = await openApp(browser, true, undefined, { person: MEMBER });
			assert((await noLink.page.locator(".product-sidebar-footer .signed-in-as").innerText()).includes("Signed in as"), "shared without a link: the name is missing");
			assert((await noLink.page.locator(".product-sidebar-footer .signed-in-as a").count()) === 0, "shared without a link: a Sign out item is offered");
			await closeContext(noLink.context);
			pass("shared: no Sign out item without the server's link, and nothing at all without a name or a link");

			const opened = await openApp(browser, true, undefined, { person: MEMBER, signOut: SIGN_OUT_LINK });
			const { context, page, probe, reads } = opened;
			const footer = page.locator(".product-sidebar-footer .signed-in-as");
			const focusPage = () => page.evaluate(() => window.dispatchEvent(new Event("focus")));
			const showPage = (persisted: boolean) => page.evaluate((flag) => window.dispatchEvent(new PageTransitionEvent("pageshow", { persisted: flag })), persisted);
			// A read that fails never turns a shared server into the desktop.
			probe.fail = true;
			let before = reads();
			await focusPage();
			await until(() => reads() > before, "shared: focus did not read the person again");
			await settled(opened);
			assert((await footer.count()) === 1 && (await page.locator(".product-nav button").filter({ hasText: "Wallet" }).count()) === 0, "shared: a failed read turned the page into the desktop");
			probe.fail = false;
			// A page shown again from the back-forward cache reads; an ordinary show does not.
			before = reads();
			await showPage(false);
			await settled(opened);
			assert(reads() === before, `shared: a pageshow that was not from the cache read the person (${reads() - before} reads)`);
			await showPage(true);
			await until(() => reads() > before, "shared: a pageshow from the cache did not read the person");
			// Its read has to be over before the next row starts one: a focus meanwhile would only wait behind it.
			await settled(opened);
			// A read that stalls ends at the page's own deadline and does not hold later ones behind it;
			// then another person on a read reloads the page.
			probe.stall = true;
			before = reads();
			await focusPage();
			await until(() => reads() > before, "shared: a focus did not start a read");
			probe.stall = false;
			probe.person = OTHER;
			let reloaded = false;
			page.once("load", () => { reloaded = true; });
			await until(async () => {
				if (!reloaded) await focusPage().catch(() => {});
				return reloaded;
			}, "shared: a stalled read held every later read, so the page never saw the other person", 40000);
			await page.locator(".persistent-agent-card").first().waitFor({ timeout: 15000 });
			assert((await footer.innerText()).includes("Sample Other"), "shared: the page reloaded but does not show the other person");
			pass("shared: focus and a pageshow from the cache read the person again, a failed read keeps the shared view, a stalled read ends at its deadline, and another person reloads the page");
			await closeContext(context);

			const local = await openApp(browser, false);
			before = local.reads();
			await local.page.evaluate(() => window.dispatchEvent(new Event("focus")));
			await settled(local);
			assert(local.reads() === before, "this computer: focus read the person again");
			assert((await local.page.locator(".signed-in-as").count()) === 0, "this computer: the footer says who is signed in");
			pass("this computer: nothing reads the person again and the footer says nothing");
			await closeContext(local.context);
		}

		// --- The page names its person: on every request and its socket on a shared server, nowhere on this computer ---
		for (const sharedServer of [true, false]) {
			const where = sharedServer ? "shared" : "this computer";
			const opened = await openApp(browser, sharedServer, (ctx) => ctx.addInitScript(() => {
				// Each socket's constructor arguments, and the protocol the server answered.
				const sockets: Array<{ url: string; protocols: unknown; answered?: string }> = [];
				Object.assign(window, { smokeSockets: sockets });
				window.WebSocket = new Proxy(window.WebSocket, {
					construct(target, args) {
						const socket = Reflect.construct(target, args) as WebSocket;
						const entry: { url: string; protocols: unknown; answered?: string } = { url: String(args[0]), protocols: args[1] ?? null };
						sockets.push(entry);
						socket.addEventListener("open", () => { entry.answered = socket.protocol; });
						return socket;
					},
				});
			}), sharedServer ? { person: MEMBER } : {});
			const { context, page } = opened;
			const named: Array<{ request: string; person: string | undefined }> = [];
			page.on("request", (request) => {
				const { pathname } = new URL(request.url());
				if (["fetch", "xhr"].includes(request.resourceType()) && pathname.startsWith("/api/")) named.push({ request: `${request.method()} ${pathname}`, person: request.headers()[PAGE_PERSON_HEADER] });
			});
			await page.evaluate(() => window.dispatchEvent(new Event("focus")));
			await openRoomFromHome(page, "Beta Room");
			await settled(opened);
			const expected = sharedServer ? MEMBER.id : undefined;
			assert(named.length > 0, `${where}: no request was seen`);
			const wrong = named.filter((entry) => entry.person !== expected);
			assert(wrong.length === 0, `${where}: requests that do not name ${expected ?? "no one"}: ${JSON.stringify(wrong)}`);
			const roomSocket = () => page.evaluate(() => (window as unknown as { smokeSockets: Array<{ url: string; protocols: unknown; answered?: string }> }).smokeSockets.filter((entry) => entry.url.includes("persistentAgentId=")).pop());
			await until(async () => (await roomSocket())?.answered !== undefined, `${where}: the room's socket never opened`);
			const room = await roomSocket();
			assert(JSON.stringify(room?.protocols) === JSON.stringify(sharedServer ? PAGE_PERSON_PROTOCOLS(MEMBER) : null), `${where}: the room's socket offered ${JSON.stringify(room?.protocols)}`);
			assert(room?.answered === (sharedServer ? "exxperts" : ""), `${where}: the server answered the protocol ${JSON.stringify(room?.answered)}`);
			pass(sharedServer
				? `shared: ${named.length} requests name the page's person in ${PAGE_PERSON_HEADER}, and the room's socket offers exxperts then exxperts-person.<id>, answered with exxperts`
				: `this computer: ${named.length} requests and the room's socket name no person and offer no protocol`);
			await closeContext(context);
		}

		// --- sharedServer: true, the server refuses the person the page names: the page ends and sends nothing more ---
		{
			let refusing = false;
			let socketsAfter = 0;
			const opened = await openApp(browser, true, async (ctx) => {
				await ctx.routeWebSocket(/\/ws(\?|$)/, (ws) => {
					if (refusing) {
						socketsAfter += 1;
						void ws.close();
						return;
					}
					ws.connectToServer();
				});
				// Every request from here on, as the edge answers once another person is signed in.
				await ctx.route("**/api/**", (route) => refusing
					? route.fulfill({ status: 409, contentType: "application/json", body: JSON.stringify(PERSON_CHANGED) })
					: route.fallback());
			}, { person: MEMBER });
			const { context, page } = opened;
			await holdReload(page);
			let sentAfter = 0;
			let ended = false;
			page.on("request", (request) => { if (ended && ["fetch", "xhr"].includes(request.resourceType())) sentAfter += 1; });
			refusing = true;
			await page.locator(".persistent-agent-card").filter({ hasText: "Beta Room" }).locator(".persistent-agent-primary-actions .landing-action").first().click();
			const cover = page.locator(".person-changed-cover");
			await cover.waitFor({ timeout: 15000 });
			assert((await cover.innerText()).includes("Someone else is now signed in on this server."), `refused person: the cover does not say another person, got ${JSON.stringify(await cover.innerText())}`);
			await settled(opened);
			ended = true;
			const socketsThen = socketsAfter;
			await page.evaluate(() => window.dispatchEvent(new Event("focus")));
			const more = await appears(() => sentAfter > 0 || socketsAfter > socketsThen, 3000);
			assert(!more, `refused person: the ended page sent ${sentAfter} request(s) and opened ${socketsAfter - socketsThen} socket(s)`);
			pass("shared: a request answered 409 person_changed ends the page with the person-changed cover (reload held) and nothing is sent after it");
			await closeContext(context);
		}

		// --- Home's dropped socket: on a shared server each try asks client-context before the rebuild; on this computer as today ---
		for (const sharedServer of [true, false]) {
			const where = sharedServer ? "shared" : "this computer";
			const live: WebSocketRoute[] = [];
			let refused = false;
			let tries = 0;
			const opened = await openApp(browser, sharedServer, async (ctx) => {
				await ctx.clock.install();
				await ctx.routeWebSocket(/\/ws(\?|$)/, (ws) => {
					if (refused) {
						tries += 1;
						void ws.close();
						return;
					}
					ws.connectToServer();
					live.push(ws);
				});
			}, sharedServer ? { person: MEMBER } : {});
			const { context, page, probe, reads } = opened;
			await holdReload(page);
			const lines: string[] = [];
			page.on("console", (message) => { if (message.type() === "warning" || message.type() === "error") lines.push(message.text()); });
			// The ladder's clock runs on a second at a time until the condition holds.
			const runUntil = async (condition: () => boolean | Promise<boolean>, message: string, seconds = 60) => {
				for (let step = 0; step < seconds; step += 1) {
					if (await condition()) return;
					await page.clock.runFor(1000);
					await settled(opened);
				}
				throw new Error(message);
			};
			await until(() => live.length > 0, `${where} ladder: Home's socket never opened`);
			refused = true;
			const readsBefore = reads();
			if (sharedServer) probe.fail = true;
			for (const ws of live.splice(0)) void ws.close();
			if (sharedServer) {
				// No answer: each try asks again later and rebuilds nothing.
				await runUntil(() => reads() >= readsBefore + 2, "shared ladder: the ladder did not ask client-context before its tries");
				// A server that answers nothing is an outage: the lost-connection line comes, as when each rebuild failed.
				await runUntil(async () => (await page.getByText(LOST_SHARED_LINE, { exact: true }).count()) === 1, "shared ladder: client-context answering nothing never brought the lost-connection line");
				assert(tries === 0, `shared ladder: ${tries} socket(s) rebuilt while client-context did not answer`);
				// An answer: the next try rebuilds.
				probe.fail = false;
				await runUntil(() => tries > 0, "shared ladder: no rebuild once client-context answered");
				// Refused: the next question ends the page, with no rebuild after it.
				probe.refuse = true;
				const triesThen = tries;
				await runUntil(async () => (await page.locator(".person-changed-cover").count()) === 1, "shared ladder: a 409 person_changed on client-context did not end the page");
				assert(tries === triesThen, `shared ladder: the socket was rebuilt ${tries - triesThen} time(s) after client-context answered 409`);
				const readsThen = reads();
				const linesThen = lines.length;
				await page.clock.runFor(60_000);
				await settled(opened);
				assert(tries === triesThen && reads() === readsThen && lines.length === linesThen, `shared ladder: the ended page went on (${tries - triesThen} sockets, ${reads() - readsThen} reads, lines ${JSON.stringify(lines.slice(linesThen))})`);
				pass(`shared: Home's dropped socket asks client-context first; no answer rebuilds nothing and brings the lost-connection line, an answer rebuilds, and its 409 person_changed ends the page with no rebuild and no further line (${lines.length} warning lines in all)`);
			} else {
				await runUntil(() => tries >= 2, "this computer ladder: Home's socket was not rebuilt");
				assert(reads() === readsBefore, `this computer ladder: the ladder read client-context ${reads() - readsBefore} time(s)`);
				pass(`this computer: Home's dropped socket is rebuilt as today (${tries} tries), with no client-context question`);
			}
			await closeContext(context);
		}

		// --- A remote device on this computer keeps its rule for the default models ---
		{
			const { context, page } = await openApp(browser, false, undefined, { remote: true });
			await openSettings(page);
			await openTab(page, "AI setup");
			assert((await page.locator(".settings-overlay .ai-defaults-group .room-model-pick:not(:disabled)").count()) === 2, "remote device with full access: the default models are read-only");
			pass("this computer, remote device with full access: the default models can still be changed");
			await closeContext(context);
		}

		// --- sharedServer: true, a long name on a phone ---
		{
			const longName = "Sample Person With A Very Long Name That Keeps Going ".repeat(4).trim();
			const { context, page } = await openApp(browser, true, undefined, { person: { ...MEMBER, name: longName }, signOut: SIGN_OUT_LINK });
			await page.setViewportSize({ width: 390, height: 800 });
			const gear = page.locator(".product-sidebar-footer .sidebar-config-gear");
			await gear.waitFor({ timeout: 10000 });
			await until(async () => {
				const box = await gear.boundingBox();
				return box !== null && box.x >= 0 && box.x + box.width <= 390;
			}, "shared phone: a long name pushed Settings off the screen");
			assert((await page.evaluate(() => document.documentElement.scrollWidth)) <= 390, "shared phone: a long name made the page scroll sideways");
			assert((await page.locator(".product-sidebar-footer .signed-in-as-name").evaluate((node) => node.scrollWidth > node.clientWidth)), "shared phone: the long name was not cut");
			pass("shared phone: a long name is cut with an ellipsis and Settings stays on screen");
			await closeContext(context);
		}

		// --- sharedServer: true, another person while a room's retry waits: nothing of the old page is saved ---
		{
			const saves: string[] = [];
			const live: WebSocketRoute[] = [];
			let down = false;
			let connectsAfterChange = 0;
			let changed = false;
			const opened = await openApp(browser, true, async (ctx) => {
				await ctx.routeWebSocket(/\/ws(\?|$)/, (ws) => {
					if (changed) connectsAfterChange += 1;
					if (down) {
						void ws.close();
						return;
					}
					ws.connectToServer();
					live.push(ws);
				});
			}, { person: MEMBER });
			const { page, probe, reads } = opened;
			page.on("request", (request) => {
				if (changed && request.method() !== "GET" && /\/api\/persistent-agents\/[^/]+\/threads\//.test(new URL(request.url()).pathname)) saves.push(`${request.method()} ${new URL(request.url()).pathname}`);
			});
			await enterRoom(page, "Beta Room");
			await holdReload(page);
			// Every retry fails at the first question until the server answers as someone else.
			down = true;
			probe.fail = true;
			const asked = reads();
			for (const ws of live.splice(0)) void ws.close();
			await until(() => reads() > asked, "person change: the room never retried");
			probe.person = OTHER;
			probe.fail = false;
			down = false;
			changed = true;
			await page.locator(".person-changed-cover").waitFor({ timeout: 30000 });
			await settled(opened);
			assert(saves.length === 0, `person change: the old page saved a thread as the new person: ${saves.join(", ")}`);
			assert(connectsAfterChange === 0, `person change: the old page opened ${connectsAfterChange} connection(s) after the change`);
			// The cover is what a click on the old composer would hit.
			// A hit that is null (off the screen) is not a cover: it needs a real element with the cover above it.
			const covered = await page.evaluate(() => {
				const box = document.querySelector("textarea")?.getBoundingClientRect();
				if (!box) return false;
				const hit = document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2);
				return hit !== null && hit.closest(".person-changed-cover") !== null;
			});
			assert(covered, "person change: the old room's composer is still usable");
			pass("shared: another person signing in while a room's retry waits blanks the page and saves and reconnects nothing, even when the reload is held");
			await closeContext(opened.context);
		}

		// --- sharedServer: true, another person while a reconnect waits on its save ---
		{
			const live: WebSocketRoute[] = [];
			let holdPut = false;
			let held: Route | null = null;
			let changed = false;
			let connectsAfterChange = 0;
			const opened = await openApp(browser, true, async (ctx) => {
				await ctx.routeWebSocket(/\/ws(\?|$)/, (ws) => {
					if (changed) connectsAfterChange += 1;
					ws.connectToServer();
					live.push(ws);
				});
				await ctx.route(/\/api\/persistent-agents\/[^/]+\/threads\//, (route) => {
					if (holdPut && route.request().method() === "PUT") {
						held = route;
						return;
					}
					return route.continue();
				});
			}, { person: MEMBER });
			const { page, probe } = opened;
			await enterRoom(page, "Beta Room");
			await holdReload(page);
			// The room drops; its retry gets as far as saving the thread, and the save is held.
			holdPut = true;
			for (const ws of live.splice(0)) void ws.close();
			await until(() => held !== null, "reconnect on save: the retry never reached its save", 30000);
			// While it waits, the server answers as someone else.
			probe.person = OTHER;
			changed = true;
			await page.evaluate(() => window.dispatchEvent(new Event("focus")));
			await page.locator(".person-changed-cover").waitFor({ timeout: 15000 });
			// The cover is all that can be reached or read: the page under it is inert, and focus is inside it.
			const access = await page.evaluate(() => {
				const cover = document.querySelector(".person-changed-cover");
				const others = Array.from(document.body.children).filter((node) => node !== cover && !node.contains(cover) && !cover?.contains(node));
				return {
					unreachable: others.every((node) => (node as HTMLElement).inert === true),
					hidden: others.every((node) => node.getAttribute("aria-hidden") === "true"),
					focusInCover: !!document.activeElement?.closest(".person-changed-cover"),
				};
			});
			assert(access.unreachable && access.hidden, `person change: the page under the cover is still reachable (${JSON.stringify(access)})`);
			assert(access.focusInCover, "person change: focus was not moved into the cover");
			for (let tab = 0; tab < 4; tab += 1) await page.keyboard.press("Tab");
			assert(await page.evaluate(() => !!document.activeElement?.closest(".person-changed-cover")), "person change: Tab left the cover");
			// The save now comes back; nothing may go on from it as the new person.
			const savedBack = page.waitForResponse((res) => res.request().method() === "PUT" && /\/threads\//.test(new URL(res.url()).pathname), { timeout: 15000 });
			await (held as unknown as Route).continue();
			await savedBack;
			await settled(opened);
			assert(connectsAfterChange === 0, `reconnect on save: the old page opened ${connectsAfterChange} connection(s) as the new person after its save came back`);
			pass("shared: another person while a reconnect waits on its save: the cover takes focus and the page under it is unreachable, and no connection opens as the new person");
			await closeContext(opened.context);
		}

		// --- sharedServer: true, a finished question for the room left behind does not touch the room the person is in ---
		{
			const live: WebSocketRoute[] = [];
			const droppedRooms = new Set<string>();
			const opened = await openApp(browser, true, async (ctx) => {
				await ctx.routeWebSocket(/\/ws(\?|$)/, (ws) => {
					if ([...droppedRooms].some((id) => ws.url().includes(id))) {
						void ws.close();
						return;
					}
					ws.connectToServer();
					live.push(ws);
				});
			}, { person: MEMBER });
			const { context, page, probe } = opened;
			await enterRoom(page, "Beta Room");
			// Beta Room drops; its retry's question is held, to be answered late. Every later question fails at once.
			droppedRooms.add(ids["Beta Room"]);
			probe.holdNext = true;
			for (const ws of live.splice(0)) void ws.close();
			await until(() => probe.holding, "obsolete retry: the room never retried", 30000);
			probe.fail = true;
			await leaveRoomToHome(page);
			await openRoomFromHome(page, "Alpha Room");
			await settled(besideHeld(opened));
			// Alpha Room drops too and is retrying.
			droppedRooms.add(ids["Alpha Room"]);
			for (const ws of live.splice(0)) void ws.close();
			await page.getByText("Reconnecting…", { exact: true }).waitFor({ timeout: 15000 });
			probe.release();
			await until(() => probe.released > 0, "obsolete retry: the first room's question was never answered");
			await settled(opened);
			// It has been answered: the room the person is in keeps reading as retrying, never as plain offline.
			for (let look = 0; look < 30; look += 1) {
				assert((await page.getByText("Offline", { exact: true }).count()) === 0, "obsolete retry: the first room's answer made the room the person is in read as offline");
				await new Promise((resolve) => setTimeout(resolve, 20));
			}
			pass("shared: a first room's question that finishes late leaves the room the person is in still retrying");
			await closeContext(context);
		}

		// --- sharedServer: true, an older sign-in check that comes back late does not undo a newer one ---
		{
			let dropped = false;
			let statusCalls = 0;
			let olderDone = 0;
			let releaseOlder = () => {};
			const olderHeld = new Promise<void>((resolve) => { releaseOlder = resolve; });
			const live: WebSocketRoute[] = [];
			const opened = await openApp(browser, true, async (ctx) => {
				await ctx.clock.install();
				// The page was sent to sign in a moment ago, so it will not go twice.
				await ctx.addInitScript(() => { if (!sessionStorage.getItem("exxperts-auth-redirect")) sessionStorage.setItem("exxperts-auth-redirect", String(Date.now() + 120_000)); });
				await ctx.routeWebSocket(/\/ws(\?|$)/, (ws) => {
					if (dropped) {
						void ws.close();
						return;
					}
					ws.connectToServer();
					live.push(ws);
				});
				await ctx.route("**/api/auth/status", async (route) => {
					if (!dropped) return route.continue();
					statusCalls += 1;
					if (statusCalls === 1) {
						// The first check is held and finds the person still signed in; the second finds the session over.
						await olderHeld;
						olderDone += 1;
						return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ providers: [] }) });
					}
					return route.fulfill({ status: 401, contentType: "application/json", body: JSON.stringify({ error: "Not signed in.", code: "auth_required" }) });
				});
			}, { person: MEMBER });
			const { context, page } = opened;
			await until(() => live.length > 0, "stale check: the page's live connection never opened");
			dropped = true;
			for (const ws of live.splice(0)) void ws.close();
			const signedOutLine = page.getByText(SIGNED_OUT_LINE, { exact: true });
			// The older check, held on purpose, is not in flight for settling.
			const besideOlder = { page, pending: () => opened.pending() - (statusCalls > 0 && olderDone === 0 ? 1 : 0) };
			for (let second = 0; (await signedOutLine.count()) === 0; second += 1) {
				assert(second < 60, "stale check: the signed-out line never showed");
				await page.clock.runFor(1000);
				await settled(besideOlder);
			}
			releaseOlder();
			await until(() => olderDone > 0, "stale check: the older check never came back");
			for (let look = 0; look < 20; look += 1) {
				assert((await page.getByText(SIGNED_OUT_LINE, { exact: true }).count()) === 1, "stale check: an older answer that came back late replaced the signed-out line");
				await new Promise((resolve) => setTimeout(resolve, 100));
			}
			pass("shared: an older sign-in check that comes back late does not undo the newer one that found the session over");
			await closeContext(context);
		}

		// --- sharedServer: true, a start-up read refused ---
		{
			let refusedReads = 0;
			const opened = await openApp(browser, true, (ctx) =>
				ctx.route("**/api/persistent-agent-ai-profile", (route) => {
					if (route.request().method() !== "GET") return route.continue();
					refusedReads += 1;
					return route.fulfill({ status: 403, contentType: "application/json", body: JSON.stringify(REFUSAL) });
				}));
			const { context, page } = opened;
			await until(() => refusedReads > 0, "refused start-up read: the page never read the profiles");
			await settled(opened);
			assert((await page.getByText("Your rooms.", { exact: true }).count()) === 1, "refused start-up read: Home is not drawn");
			assert((await page.locator(".persistent-agent-card").count()) === ROOMS.length, "refused start-up read: the rooms are not listed");
			assert((await page.getByText(BOUNDARY_LINE).count()) === 0, "refused start-up read: the page fell back to the error boundary");
			assert((await page.getByText(REFUSAL.error).count()) === 0, "refused start-up read: the refusal's body is shown as data");
			await openSettings(page);
			await openTab(page, "Web search");
			assert((await countText(page, ".settings-overlay", SHARED_LINE)) === 1, "refused start-up read: Settings is not usable");
			await closeSettings(page);
			pass("shared: a start-up read answered 403 { error, code } leaves Home and Settings usable");
			await closeContext(context);
		}

		// --- The live connection drops: signed out, a real outage, and the same on this computer ---
		{
			const onClock = (context: BrowserContext) => context.clock.install();
			const signedOut = await openWithDroppableConnection(browser, true, true, onClock);
			const outage = await openWithDroppableConnection(browser, true, false, onClock);
			const local = await openWithDroppableConnection(browser, false, true, onClock);
			for (const { opened, isLive } of [signedOut, outage, local]) {
				await until(isLive, "dropped connection: a page's live connection never opened");
				await settled(opened);
			}
			let toSignIn = false;
			signedOut.opened.page.on("request", (request) => { if (request.isNavigationRequest() && new URL(request.url()).pathname === "/") toSignIn = true; });
			let localLeft = false;
			local.opened.page.on("request", (request) => { if (request.isNavigationRequest()) localLeft = true; });
			let outageLeft = false;
			outage.opened.page.on("request", (request) => { if (request.isNavigationRequest()) outageLeft = true; });
			for (const { drop } of [signedOut, outage, local]) drop();
			const outageLine = outage.opened.page.getByText(LOST_SHARED_LINE, { exact: true });
			const localLine = local.opened.page.getByText(LOST_LINE);
			let waited = 0;
			while (!toSignIn || (await outageLine.count()) === 0 || (await localLine.count()) === 0) {
				assert(waited < OUTAGE_LIMIT_MS, `dropped connection: within a minute, sent to sign in ${toSignIn}, the shared line ${await outageLine.count()}, this computer's line ${await localLine.count()}`);
				for (const { opened } of [outage, local, ...(toSignIn ? [] : [signedOut])]) await opened.page.clock.runFor(1000);
				for (const { opened } of [outage, local]) await settled(opened);
				waited += 1000;
			}
			assert(!outageLeft, "shared outage: the page left although the person is signed in");
			assert((await outage.opened.page.getByText(/Restarting the app/).count()) === 0, "shared outage: the line tells the person to restart the app");
			assert(!localLeft, "this computer: the page left instead of saying the connection is lost");
			pass(`a dropped connection: on a shared server a 401 sends the page to sign in, a signed-in person sees the lost-connection line in the shared words, and this computer shows the line as today (${waited / 1000}s on the pages' clock)`);
			for (const { opened } of [signedOut, outage, local]) await closeContext(opened.context);

			// A sign-in that ended, with the page already sent to sign in a moment ago (it does not go twice
			// within 15 s): the first failed attempt says so at once, with a way to sign in, and the lost line never shows.
			const again = await openWithDroppableConnection(browser, true, true, async (context) => {
				await context.addInitScript(() => { if (!sessionStorage.getItem("exxperts-auth-redirect")) sessionStorage.setItem("exxperts-auth-redirect", String(Date.now() + 60_000)); });
			});
			await until(() => again.isLive(), "signed out: the page's live connection never opened");
			again.drop();
			await again.opened.page.getByText(SIGNED_OUT_LINE, { exact: true }).waitFor({ timeout: 8000 });
			assert((await again.opened.page.locator(".connection-lost-banner a").getAttribute("href")) === "/", "signed out: the line has no way to sign in");
			assert((await again.opened.page.getByText(/lost its connection/).count()) === 0, "signed out: the lost-connection line shows beside it");
			pass("a sign-in that ended inside the no-second-redirect window: the page says it, at the first failed attempt, with a link to sign in");
			await closeContext(again.opened.context);
		}

		// --- A room's connection lost for longer than two minutes (the clock runs on, so it takes seconds) ---
		for (const sharedServer of [true, false]) {
			const live: WebSocketRoute[] = [];
			let down = false;
			let threadReads = 0;
			const opened = await openApp(browser, sharedServer, async (context) => {
				await context.clock.install();
				await context.routeWebSocket(/\/ws(\?|$)/, (ws) => {
					if (down) {
						void ws.close();
						return;
					}
					ws.connectToServer();
					live.push(ws);
				});
				await context.route(/\/api\/persistent-agents\/[^/]+\/threads\//, (route) => {
					if (!down) return route.continue();
					threadReads += 1;
					return route.abort();
				});
			}, sharedServer ? { person: MEMBER } : {});
			const { page, probe, reads } = opened;
			const where = sharedServer ? "shared" : "this computer";
			const runFor = async (seconds: number) => {
				for (let step = 0; step < seconds / 5; step += 1) {
					await page.clock.runFor(5000);
					await settled(opened);
				}
			};
			await enterRoom(page, "Beta Room");
			// What the room's entry set off on a timer (its first save) is done before the drop.
			await runFor(5);
			down = true;
			probe.fail = true;
			for (const ws of live.splice(0)) void ws.close();
			await runFor(130);
			const reconnect = page.locator(".composer-reconnect-btn");
			if (sharedServer) {
				assert((await reconnect.count()) === 0, `${where}: the room gave up after two minutes`);
				assert((await page.locator(`[title="${PILL_SHARED}"]`).count()) >= 1, `${where}: the pill does not say the room keeps trying`);
				assert(threadReads === 0, `${where}: the room read its thread (${threadReads}) while the server did not answer client-context`);
				// The server answers client-context again but the thread not yet: only then is the thread asked for.
				probe.fail = false;
				const readsBefore = reads();
				await runFor(30);
				assert(reads() > readsBefore, `${where}: a retry did not read client-context first`);
				assert(threadReads > 0, `${where}: a retry never read the thread once client-context answered`);
				assert((await reconnect.count()) === 0, `${where}: the room gave up while the server was coming back`);
				// And back: the next retry brings the room up with no button and no reload.
				down = false;
				await runFor(30);
				await page.locator('[title="Context and model details"]').first().waitFor({ timeout: 10000 });
				assert((await page.locator(`[title="${PILL_SHARED}"]`).count()) === 0, `${where}: the pill still says the room lost its connection`);
				pass(`${where}: past two minutes the room keeps trying, asks client-context before its thread, and is back once the server is (${threadReads} thread reads)`);
			} else {
				await reconnect.waitFor({ timeout: 10000 });
				assert((await reconnect.getAttribute("title")) === RECONNECT_DESKTOP, `${where}: the Reconnect tooltip is not the desktop's`);
				assert((await page.locator(`[title="${PILL_DESKTOP_FAILED}"]`).count()) >= 1, `${where}: the pill is not the desktop's words`);
				pass(`${where}: the room gives up after two minutes with Reconnect and the desktop's words`);
			}
			await closeContext(opened.context);
		}

		// --- A room that is still finishing an answer stands down, on a shared server and on this computer ---
		for (const sharedServer of [true, false]) {
			const live: WebSocketRoute[] = [];
			let cooking = false;
			const { context, page } = await openApp(browser, sharedServer, async (ctx) => {
				await ctx.routeWebSocket(/\/ws(\?|$)/, (ws) => {
					if (cooking) {
						ws.send(JSON.stringify({ type: "error", code: "room_cooking", error: "This room is still finishing an answer." }));
						void ws.close();
						return;
					}
					ws.connectToServer();
					live.push(ws);
				});
			}, sharedServer ? { person: MEMBER } : {});
			const where = sharedServer ? "shared" : "this computer";
			await enterRoom(page, "Beta Room");
			cooking = true;
			for (const ws of live.splice(0)) void ws.close();
			const reconnect = page.locator(".composer-reconnect-btn");
			await reconnect.waitFor({ timeout: 20000 });
			assert((await reconnect.getAttribute("title")) === (sharedServer ? RECONNECT_SHARED : RECONNECT_DESKTOP), `${where} stand-down: the Reconnect tooltip is not that edition's words, got ${JSON.stringify(await reconnect.getAttribute("title"))}`);
			pass(`${where}: a room still finishing an answer stands down with Reconnect and that edition's words${sharedServer ? ", not the keep-trying ladder" : ""}`);
			await closeContext(context);
		}

		// --- A gateway's bare 403, handed back the way the server hands a failed message back ---
		for (const sharedServer of [true, false]) {
			let roomSocket: WebSocketRoute | undefined;
			const opened = await openApp(browser, sharedServer, (ctx) =>
				ctx.routeWebSocket(/\/ws(\?|$)/, (ws) => {
					ws.connectToServer();
					if (ws.url().includes("persistentAgentId=")) roomSocket = ws;
				}));
			const { context, page } = opened;
			const where = sharedServer ? "shared" : "this computer";
			await enterRoom(page, "Beta Room");
			assert(roomSocket, `${where}: the room's live connection is open`);
			// A room without a folder: the hint to connect one, never on a shared server, where there is no folder to set.
			const folderHint = page.locator(".room-workspace-nudge:not(.room-model-notice)");
			// The hint waits for the room's folder to be read: once the room's reads are done it would show.
			if (sharedServer) {
				await settled(opened);
				assert((await folderHint.count()) === 0, `${where}: the hint to connect a folder shows`);
			}
			else await folderHint.waitFor({ timeout: 10000 });
			roomSocket.send(JSON.stringify({ type: "prompt_returned", text: "A question for the gateway.", failure: "gateway-refused", model: { provider: "acme-gw", model: "acme-model" } }));
			const line = page.locator(".failure-line:not(.is-folded)");
			await line.waitFor({ timeout: 10000 });
			const shown = (await line.locator(".system-line-text").innerText()).replace(/\s+/g, " ").trim();
			const buttons = (await line.locator(".failure-actions .rs-btn").allInnerTexts()).map((text) => text.trim()).join("|");
			if (sharedServer) {
				assert(shown.endsWith("Tell your admin, or choose another model."), `${where}: the gateway's 403 sends the person to the admin, got ${JSON.stringify(shown)}`);
				assert(buttons === "Choose another model", `${where}: no button for telling the admin and no Replace key, only Choose another model, got ${JSON.stringify(buttons)}`);
			} else {
				assert(shown.endsWith("Replace the gateway's key, or choose another model."), `${where}: the gateway's 403 names the key, its button in place of where it is replaced, got ${JSON.stringify(shown)}`);
				assert(buttons === "Choose another model|Replace key", `${where}: Replace key and Choose another model, got ${JSON.stringify(buttons)}`);
				await line.getByRole("button", { name: "Replace key" }).click();
				await page.locator(".settings-overlay").waitFor({ timeout: 10000 });
				const activeTab = (await page.locator(".settings-dialog-nav [aria-current='page']").allInnerTexts()).join("|");
				assert(activeTab.includes("AI setup"), `${where}: Replace key opens Settings at AI setup, got ${JSON.stringify(activeTab)}`);
				await closeSettings(page);
			}
			pass(`${where}: a gateway's bare 403 offers ${buttons.replace("|", " and ")}${sharedServer ? ", never a button for telling the admin, and no hint to connect a folder" : ", and the hint to connect a folder shows"}`);
			// A gateway's bare 404 handed back before its model list was read: the gateway is checked in AI setup, which on a shared server is the admin's.
			await page.locator("textarea").first().fill("");
			roomSocket.send(JSON.stringify({ type: "prompt_returned", text: "A question the gateway cannot find.", failure: "gateway-not-found", model: { provider: "acme-gw", model: "acme-model" } }));
			await line.locator(".system-line-text", { hasText: "could not find" }).waitFor({ timeout: 10000 });
			const notFound = (await line.locator(".system-line-text").innerText()).replace(/\s+/g, " ").trim();
			const notFoundButtons = (await line.locator(".failure-actions .rs-btn").allInnerTexts()).map((text) => text.trim()).join("|");
			if (sharedServer) {
				assert(notFound.endsWith("Tell your admin."), `${where}: the gateway's 404 sends the person to the admin, got ${JSON.stringify(notFound)}`);
				assert(notFoundButtons === "", `${where}: no button for a gateway's 404, got ${JSON.stringify(notFoundButtons)}`);
			} else {
				assert(notFound.endsWith("Check the gateway."), `${where}: the gateway's 404 names what to check, its button in place of where, got ${JSON.stringify(notFound)}`);
				assert(notFoundButtons === "Open AI setup", `${where}: AI setup's button only, got ${JSON.stringify(notFoundButtons)}`);
				await line.getByRole("button", { name: "Open AI setup" }).click();
				await page.locator(".settings-overlay").waitFor({ timeout: 10000 });
				const activeTab = (await page.locator(".settings-dialog-nav [aria-current='page']").allInnerTexts()).join("|");
				assert(activeTab.includes("AI setup"), `${where}: Open AI setup opens Settings at AI setup, got ${JSON.stringify(activeTab)}`);
				await closeSettings(page);
			}
			pass(`${where}: a gateway's bare 404 ${sharedServer ? "tells the person to tell the admin, with no button" : "names what to check, with AI setup's button"}`);
			await closeContext(context);
		}

		// --- The words for a missing or gone model: a member and the admin on a shared server, and this computer as today ---
		for (const who of [MEMBER, ADMIN, null]) {
			const where = who === null ? "this computer" : who.admin ? "shared admin" : "shared member";
			const words = who === null ? MODEL_WORDS.computer : who.admin ? MODEL_WORDS.admin : MODEL_WORDS.member;
			let roomSocket: WebSocketRoute | undefined;
			// No model at all: every room's row has none, and no provider is ready. The rooms read as never opened, so
			// their cards offer Enter, whose tooltip names what is missing, not Resume.
			let noModels = false;
			let noProviders = false;
			// The room's folder cannot be read: Delete names no folder rather than guessing.
			let noFolderRead = false;
			const { context, page } = await openApp(browser, who !== null, async (ctx) => {
				await ctx.routeWebSocket(/\/ws(\?|$)/, (ws) => {
					ws.connectToServer();
					if (ws.url().includes("persistentAgentId=")) roomSocket = ws;
				});
				await ctx.route("**/api/persistent-agents", async (route) => {
					if (!noModels || route.request().method() !== "GET") return route.fallback();
					const statuses = await (await route.fetch()).json();
					return route.fulfill({ json: statuses.map((status: any) => ({ ...status, runtime: { ...status.runtime, activeThreadId: null }, models: { ...status.models, conversation: { ...status.models?.conversation, chosen: null, effective: null, reason: undefined, refusal: undefined } } })) });
				});
				await ctx.route("**/api/persistent-agents/*/workspace-default", (route) => noFolderRead && route.request().method() === "GET" ? route.abort() : route.fallback());
				await ctx.route("**/api/persistent-agent-room/model-status", async (route) => {
					if (!noProviders) return route.fallback();
					const status = await (await route.fetch()).json();
					return route.fulfill({ json: { ...status, providers: (status.providers ?? []).map((provider: any) => ({ ...provider, ready: false })) } });
				});
			}, who ? { person: who } : {});

			await page.locator(".product-sidebar-footer button").first().click();
			await page.locator(".sidebar-config-menu").getByRole("menuitem", { name: /^Help/ }).click();
			await page.locator(".sidebar-config-menu").getByRole("menuitem", { name: "How it works" }).click();
			const firstStep = (await page.locator(".help-steps p").first().innerText()).replace(/\s+/g, " ").trim();
			assert(firstStep === words.help, `${where}: Help's first step reads ${JSON.stringify(firstStep)}`);
			await page.keyboard.press("Escape");
			pass(`${where}: Help's first step says who sets up the models`);

			// The room stopped on its key: one message handed back with the notice, in a page opened afresh for each state.
			for (const gone of words.stopped) {
				roomSocket = undefined;
				await enterRoom(page, "Beta Room");
				assert(roomSocket, `${where}: the room's live connection is open`);
				(roomSocket as WebSocketRoute).send(JSON.stringify({ type: "prompt_returned", text: "A question for the model.", notice: true, model: { provider: gone.provider, model: gone.model }, ...(gone.key ? { key: gone.key } : {}) }));
				const notice = page.locator(".room-model-notice");
				await notice.waitFor({ timeout: 10000 });
				const line = (await notice.locator(".room-workspace-nudge-text").innerText()).replace(/\s+/g, " ").trim();
				const buttons = (await notice.locator(".room-workspace-nudge-actions button").allInnerTexts()).map((text) => text.trim()).join("|");
				assert(line === gone.line, `${where}, ${gone.state}: the stopped notice reads ${JSON.stringify(line)}`);
				assert(buttons === gone.buttons, `${where}, ${gone.state}: the stopped notice offers ${JSON.stringify(buttons)}, not ${JSON.stringify(gone.buttons)}`);
			}
			pass(`${where}: the room's stopped notice for a gone key says the way on and offers ${words.stopped.map((gone) => gone.buttons).join(", then ")}`);

			// Room settings, Model, with no provider ready.
			noProviders = true;
			await enterRoom(page, "Beta Room");
			await page.locator('button.icon-btn[aria-label="Room settings"]').click();
			await page.locator(".settings-dialog-nav button").filter({ hasText: "Model" }).first().click();
			await page.locator(".room-model-pick:not(:disabled)").first().click();
			const empty = (await page.locator(".room-model-menu-empty").innerText()).trim();
			assert(empty === words.picker, `${where}: the empty Model picker reads ${JSON.stringify(empty)}`);
			await page.keyboard.press("Escape");
			pass(`${where}: the empty Model picker says how a model comes`);

			// Archive or delete names this machine only on this computer, and the folder only for a room with a linked one,
			// the same in the pane and in the Delete question.
			const deleteReads = async (room: string, failRead: boolean, linked: boolean): Promise<void> => {
				await closeSettings(page);
				await enterRoom(page, room);
				noFolderRead = failRead;
				await page.locator('button.icon-btn[aria-label="Room settings"]').click();
				await page.locator(".settings-dialog-nav button").filter({ hasText: "Archive or delete" }).first().click();
				const dangerZone = page.locator(".room-danger-zone");
				const said = linked ? "are deleted. The folder you linked is not touched. This cannot be undone." : "are deleted. This cannot be undone.";
				await until(async () => (await dangerZone.innerText()).includes("This room holds"), `${where}, ${room}: Archive or delete never showed its counts`);
				if (linked) await until(async () => (await dangerZone.innerText()).includes(said), `${where}, ${room}: Delete never named the folder you linked: ${JSON.stringify(await dangerZone.innerText())}`);
				await settledPage(page);
				const pane = (await dangerZone.innerText()).replace(/\s+/g, " ");
				await dangerZone.getByRole("button", { name: "Delete room", exact: true }).click();
				const dialog = page.getByRole("alertdialog");
				await dialog.waitFor({ timeout: 5000 });
				const question = (await dialog.innerText()).replace(/\s+/g, " ");
				await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
				await dialog.waitFor({ state: "detached", timeout: 5000 });
				noFolderRead = false;
				for (const [part, text] of [["pane", pane], ["question", question]]) {
					assert(text.includes(said) && !text.includes("Your folder on disk") && (linked || !text.includes("folder")), `${where}, ${room}${failRead ? " with its folder unread" : ""}: Delete's ${part} reads ${JSON.stringify(text)}`);
				}
				assert(pane.includes("on this machine") === (who === null), `${where}, ${room}: the pane ${who === null ? "does not name" : "names"} this machine: ${JSON.stringify(pane)}`);
			};
			await deleteReads("Beta Room", false, false);
			await deleteReads("Bash Room", false, who === null);
			if (who === null) await deleteReads("Bash Room", true, false);
			await closeSettings(page);
			pass(`${where}: Archive or delete ${who === null ? "names this machine, and the folder you linked only once it is read and the room has one" : "names no machine or folder of the person's"}`);

			// Home with no model at all: Enter's tooltip, then a room opened by its address.
			noModels = true;
			await page.goto(`${baseUrl}/`);
			await page.waitForLoadState("networkidle");
			const enter = page.locator(".persistent-agent-card").filter({ hasText: "Alpha Room" }).locator("button.landing-action", { hasText: "Enter" });
			await until(async () => (await enter.getAttribute("title")) === words.enter, `${where}: Enter's tooltip reads ${JSON.stringify(await enter.getAttribute("title"))}`);
			await page.goto(`${baseUrl}/#/room/${encodeURIComponent(ids["Alpha Room"])}`);
			await page.reload();
			const opening = page.locator(".home-resume-error");
			await opening.waitFor({ timeout: 10000 });
			assert((await opening.innerText()).trim() === words.opening, `${where}: a room opened by its address reads ${JSON.stringify(await opening.innerText())}`);
			pass(`${where}: with no model, Enter's tooltip and a room opened by its address say how a model comes`);
			await closeContext(context);
		}

		// --- sharedServer: false, every control as today ---
		{
			const { context, page } = await openApp(browser, false);
			assert(JSON.stringify(await cardOrder(page)) === JSON.stringify(Z_TO_A), `this computer: Home does not use the saved order: ${await cardOrder(page)}`);
			assert((await page.locator(".room-sort").count()) === 1, "this computer: the sort control is missing");
			assert((await page.locator(".product-nav button").filter({ hasText: "Wallet" }).count()) === 1, "this computer: the Wallet button is missing");

			await openSettings(page);
			assert((await tabCount(page, "Remote access")) === 1, "this computer: Remote access is missing");
			assert((await tabCount(page, "Profiles")) === 1, "this computer: Profiles is missing");
			await openTab(page, "AI setup");
			assert((await page.locator(".settings-overlay .add-provider-toggle").count()) === 1, "this computer: Add provider is missing");
			assert((await page.locator(".settings-overlay .ai-defaults-group .room-model-pick:not(:disabled)").count()) === 2, "this computer: the default models cannot be changed");
			await openTab(page, "Web search");
			assert((await page.locator('.settings-overlay input[type="checkbox"]').count()) > 0, "this computer: web search cannot be changed");
			await openTab(page, "Instructions");
			assert((await page.locator(".settings-overlay .room-instructions-textarea[readonly]").count()) === 0, "this computer: the instructions are read-only");
			// Save and Discard appear once the text changes; Discard puts the box back.
			const instructionsBox = page.locator(".settings-overlay .room-instructions-textarea");
			await instructionsBox.fill(`${await instructionsBox.inputValue()} Edited.`);
			const instructionsButton = (name: string) => page.locator(".settings-overlay .room-instructions-section button").filter({ hasText: new RegExp(`^${name}$`) });
			await instructionsButton("Save").waitFor({ timeout: 5_000 }).catch(() => {});
			assert((await instructionsButton("Save").count()) === 1 && (await instructionsButton("Discard").count()) === 1, "this computer: Save is missing");
			await instructionsButton("Discard").click();
			await instructionsButton("Save").waitFor({ state: "detached", timeout: 5_000 });
			await openTab(page, "Connectors");
			assert((await page.locator(".settings-overlay .connector-dir-search").count()) === 1, "this computer: the connector directory is missing");
			await openTab(page, "Skills");
			assert((await page.locator(".settings-overlay .pane-head-actions button").filter({ hasText: "Browse featured" }).count()) === 1, "this computer: Browse featured is missing");
			assert((await page.locator(".settings-overlay").getByText(SHARED_LINE, { exact: true }).count()) === 0, "this computer: the shared-server line is shown");
			await closeSettings(page);
			pass("this computer: the sort control, Wallet, Remote access, Profiles and every setting control are there, with no shared-server line");

			await enterRoom(page, "Bash Room");
			assert((await page.locator(".bash-mode-chip").count()) === 1, "this computer: the Bash chip is missing");
			await openRoomWorkspace(page);
			for (const label of ["Edit", "Clear"]) {
				assert((await page.locator(".room-workspace-section button").filter({ hasText: label }).count()) === 1, `this computer: ${label} is missing`);
			}
			await closeSettings(page);
			await enterRoom(page, "Alpha Room");
			await openRoomWorkspace(page);
			assert((await page.locator(".room-workspace-section button").filter({ hasText: "Choose folder" }).count()) === 1, "this computer: Choose folder is missing");
			assert((await countText(page, ".room-workspace-section", NO_FOLDER_LINE)) === 0, "this computer: the shared-server folder line is shown");
			await closeSettings(page);
			await openShelfFile(page);
			assert((await page.locator(".artifact-viewer-quiet").filter({ hasText: "Save…" }).count()) === 1, "this computer: Save… is missing");
			pass("this computer: rooms offer the Bash chip, the folder editor, Choose folder and Save…");
			await closeContext(context);
		}
	} finally {
		await closeBrowser(browser);
	}

	console.log("shared-server-page smoke: ok");
} finally {
	await stopSmokeServer(server);
	fs.rmSync(tempHome, { recursive: true, force: true });
}
