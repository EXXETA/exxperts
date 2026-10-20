// The page on a shared server: when the client-context probe says
// sharedServer, the controls that only work on someone's own computer are not
// on the page, the settings only an admin may change are read-only with one
// line, Home lists the rooms A to Z with no sort control, the page never asks
// for what such a server refuses, a refused start-up read leaves the page
// usable, and a signed-out person is sent to sign in instead of being told the
// connection is lost. With sharedServer false every control is there as today.
// The probe is intercepted in the page, so one ordinary server serves both.
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, type Browser, type BrowserContext, type Page, type WebSocketRoute } from "playwright";
import { authedFetch, SMOKE_AUTH_TOKEN, SMOKE_SERVER_AUTH_ENV, SMOKE_SERVER_SPAWN_TREE_OPTIONS, stopSmokeServer, freePort } from "./smoke-server-process.js";

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
const ORDER_NOT_LOADED = "The saved order could not be loaded";
const BOUNDARY_LINE = "Something went wrong on this page. Reloading usually fixes it.";
const REFUSAL = { error: "Refused by the shared server smoke.", code: "smoke_refused" };
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

/** Whether a shared server refuses this request (method and path, no query). */
function refusedOnSharedServer(method: string, pathname: string): boolean {
	if (ALWAYS_ASKED.includes(pathname)) return false;
	if (NEVER_ASKED.some((prefix) => pathname === prefix.replace(/\/$/, "") || pathname.startsWith(prefix.endsWith("/") ? prefix : `${prefix}/`))) return true;
	if (NEVER_READ.some((pattern) => pattern.test(pathname))) return true;
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

async function waitForServer(): Promise<void> {
	for (let attempt = 0; attempt < 200; attempt += 1) {
		if (server?.exitCode != null) throw new Error(`server exited before startup with code ${server.exitCode}`);
		try {
			const res = await fetch(`${baseUrl}/healthz`);
			if (res.ok) return;
		} catch { /* not up yet */ }
		await new Promise((resolve) => setTimeout(resolve, 150));
	}
	throw new Error("server did not come up");
}

async function api(method: string, url: string, body?: unknown): Promise<any> {
	const res = await authedFetch(`${baseUrl}${url}`, { method, headers: { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
	const text = await res.text();
	assert(res.ok, `${method} ${url}: ${res.status} ${text}`);
	return text ? JSON.parse(text) : null;
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

type Opened = { context: BrowserContext; page: Page; asked: string[] };

/** A signed-in page whose client-context probe answers sharedServer as given. */
async function openApp(browser: Browser, sharedServer: boolean, prepare?: (context: BrowserContext) => Promise<unknown>): Promise<Opened> {
	const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
	await context.route("**/api/remote/client-context", (route) =>
		route.fulfill({ contentType: "application/json", body: JSON.stringify({ remote: false, capability: "full", sharedServer }) }));
	if (prepare) await prepare(context);
	const page = await context.newPage();
	const asked: string[] = [];
	page.on("request", (request) => {
		const { pathname } = new URL(request.url());
		if (refusedOnSharedServer(request.method(), pathname)) asked.push(`${request.method()} ${pathname}`);
	});
	await page.goto(`${baseUrl}/auth/session?token=${SMOKE_AUTH_TOKEN}`);
	await page.waitForLoadState("networkidle");
	const dismiss = page.locator(".whats-new-close");
	if (await dismiss.count()) await dismiss.click();
	await page.locator(".persistent-agent-card").first().waitFor({ timeout: 15000 });
	return { context, page, asked };
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
	await page.waitForTimeout(700);
}

async function tabCount(page: Page, tab: string): Promise<number> {
	return page.locator(".settings-dialog-nav button").filter({ hasText: tab }).count();
}

async function closeSettings(page: Page): Promise<void> {
	await page.keyboard.press("Escape");
	await page.waitForTimeout(300);
	if (await page.locator(".settings-overlay").count()) {
		await page.locator(".settings-dialog-close").first().click();
		await page.waitForTimeout(300);
	}
}

async function enterRoom(page: Page, name: string): Promise<void> {
	await page.goto(`${baseUrl}/`);
	await page.waitForLoadState("networkidle");
	// "Enter →" the first time, "Resume →" once the room has a conversation.
	await page.locator(".persistent-agent-card").filter({ hasText: name }).locator(".persistent-agent-primary-actions .landing-action").first().click();
	await page.locator('button.icon-btn[aria-label="Room settings"]').waitFor({ timeout: 15000 });
	await page.waitForTimeout(700);
}

async function openRoomWorkspace(page: Page): Promise<void> {
	await page.locator('button.icon-btn[aria-label="Room settings"]').click();
	await page.locator(".settings-dialog-nav button").filter({ hasText: "Workspace" }).first().click();
	await page.locator(".room-workspace-section").waitFor({ timeout: 10000 });
	await page.waitForTimeout(700);
}

async function openShelfFile(page: Page): Promise<void> {
	// The panel names a shelf file without its extension.
	await page.locator(".sidebar-assets .assets-row").filter({ hasText: SHELF_FILE.replace(/\.txt$/, "") }).first().click();
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
async function openWithDroppableConnection(browser: Browser, sharedServer: boolean, signedOut: boolean): Promise<{ opened: Opened; drop: () => void }> {
	let dropped = false;
	const live: WebSocketRoute[] = [];
	const opened = await openApp(browser, sharedServer, async (context) => {
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
	await waitForServer();

	const ids: Record<string, string> = {};
	for (const name of ROOMS) {
		const created = await api("POST", "/api/persistent-agents", { displayName: name, userName: "Synthetic User", preferredUserAddress: "Synthetic User" });
		ids[name] = created.agentId ?? created.id ?? created.agent?.id;
		assert(typeof ids[name] === "string", `room create answered no id: ${JSON.stringify(created)}`);
	}
	// A saved order the shared page must not use: Z to A here, A to Z there.
	await api("PUT", "/api/settings/room-order", { mode: "name-desc" });
	// A room with a folder and commands on: its chip, Edit workspace and Clear.
	await api("PUT", `/api/persistent-agents/${encodeURIComponent(ids["Bash Room"])}/workspace-default`, { root: workspaceRoot, displayLabel: "Bash Room Folder", workspaceAccessMode: "localFiles", bashEnabled: true });
	// A file on Alpha Room's shelf: its viewer offers Save….
	await api("POST", `/api/persistent-agents/${encodeURIComponent(ids["Alpha Room"])}/files`, { filename: SHELF_FILE, contentBase64: Buffer.from("shared server smoke\n").toString("base64") });

	const browser = await chromium.launch();
	try {
		// --- sharedServer: true ---
		{
			const { context, page, asked } = await openApp(browser, true);

			assert(JSON.stringify(await cardOrder(page)) === JSON.stringify(A_TO_Z), `shared Home: rooms not A to Z: ${await cardOrder(page)}`);
			assert((await page.locator(".room-sort").count()) === 0, "shared Home: the sort control is on the page");
			assert((await page.getByText(ORDER_NOT_LOADED).count()) === 0, "shared Home: the order-not-loaded sentence is on the page");
			assert((await page.locator(".product-nav button").filter({ hasText: "Wallet" }).count()) === 0, "shared Home: the Wallet button is on the page");
			assert((await page.locator(".remote-on-pill").count()) === 0, "shared Home: the remote pill is on the page");
			pass("shared: Home lists the rooms A to Z with no sort control, no order sentence, no Wallet and no remote pill");

			await openSettings(page);
			assert((await tabCount(page, "Remote access")) === 0, "shared Settings: Remote access is offered");
			assert((await tabCount(page, "Profiles")) === 0, "shared Settings: Profiles is offered");

			await openTab(page, "AI setup");
			assert((await countText(page, ".settings-overlay .ai-defaults-group", SHARED_LINE)) === 1, "shared AI setup: the default models have no shared-server line");
			assert((await countText(page, ".settings-overlay", SHARED_LINE)) === 2, "shared AI setup: expected the line under the default models and under the providers");
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
			for (const name of ["Repository libraries", "Add skill"]) {
				assert((await page.locator(".settings-overlay").getByRole("button", { name, exact: true }).count()) === 0, `shared Skills: ${name} is offered`);
			}
			await closeSettings(page);
			pass("shared: Settings has no Remote access or Profiles; AI setup, its default models, web search, instructions, connectors and skills are read-only with the line");
			assert(asked.length === 0, `shared start, Home and Settings: the page asked for what a shared server refuses: ${asked.join(", ")}`);
			pass("shared start, Home and Settings: the page never asked for a refused route (the clean-up read at start included)");

			await enterRoom(page, "Bash Room");
			assert((await page.locator(".bash-mode-chip").count()) === 0, "shared room: the Bash chip is on the page");
			await openRoomWorkspace(page);
			for (const label of ["Edit workspace", "Clear", "Set workspace"]) {
				assert((await page.locator(".room-workspace-section button").filter({ hasText: label }).count()) === 0, `shared room with a folder: ${label} is offered`);
			}
			await closeSettings(page);

			await enterRoom(page, "Alpha Room");
			await openRoomWorkspace(page);
			assert((await page.locator(".room-workspace-section button").filter({ hasText: "Set workspace" }).count()) === 0, "shared room without a folder: Set workspace is offered");
			assert((await countText(page, ".room-workspace-section", NO_FOLDER_LINE)) === 1, "shared room without a folder: no shared-server line");
			await closeSettings(page);
			await openShelfFile(page);
			assert((await page.locator(".artifact-viewer-quiet").filter({ hasText: "Save…" }).count()) === 0, "shared room: Save… is offered for a shelf file");
			pass("shared: rooms offer no Bash chip, no workspace editor, no Set workspace and no Save…");

			assert(asked.length === 0, `shared rooms and room settings: the page asked for what a shared server refuses: ${asked.join(", ")}`);
			pass("shared rooms and room settings: the page never asked for a refused route");
			await context.close();
		}

		// --- sharedServer: true, a start-up read refused ---
		{
			const { context, page } = await openApp(browser, true, (ctx) =>
				ctx.route("**/api/persistent-agent-ai-profile", (route) =>
					route.request().method() === "GET"
						? route.fulfill({ status: 403, contentType: "application/json", body: JSON.stringify(REFUSAL) })
						: route.continue()));
			await page.waitForTimeout(1500);
			assert((await page.getByText("Your rooms.", { exact: true }).count()) === 1, "refused start-up read: Home is not drawn");
			assert((await page.locator(".persistent-agent-card").count()) === ROOMS.length, "refused start-up read: the rooms are not listed");
			assert((await page.getByText(BOUNDARY_LINE).count()) === 0, "refused start-up read: the page fell back to the error boundary");
			assert((await page.getByText(REFUSAL.error).count()) === 0, "refused start-up read: the refusal's body is shown as data");
			await openSettings(page);
			await openTab(page, "Web search");
			assert((await countText(page, ".settings-overlay", SHARED_LINE)) === 1, "refused start-up read: Settings is not usable");
			await closeSettings(page);
			pass("shared: a start-up read answered 403 { error, code } leaves Home and Settings usable");
			await context.close();
		}

		// --- The live connection drops: signed out, a real outage, and the same on this computer ---
		{
			const signedOut = await openWithDroppableConnection(browser, true, true);
			const outage = await openWithDroppableConnection(browser, true, false);
			const local = await openWithDroppableConnection(browser, false, true);
			for (const { opened } of [signedOut, outage, local]) await opened.page.waitForTimeout(3000);
			const started = Date.now();
			const toSignIn = signedOut.opened.page.waitForRequest((request) => request.isNavigationRequest() && new URL(request.url()).pathname === "/", { timeout: OUTAGE_LIMIT_MS });
			let localLeft = false;
			local.opened.page.on("request", (request) => { if (request.isNavigationRequest()) localLeft = true; });
			let outageLeft = false;
			outage.opened.page.on("request", (request) => { if (request.isNavigationRequest()) outageLeft = true; });
			for (const { drop } of [signedOut, outage, local]) drop();
			await Promise.all([
				toSignIn,
				outage.opened.page.getByText(LOST_LINE).waitFor({ timeout: OUTAGE_LIMIT_MS }),
				local.opened.page.getByText(LOST_LINE).waitFor({ timeout: OUTAGE_LIMIT_MS }),
			]);
			assert(!outageLeft, "shared outage: the page left although the person is signed in");
			assert(!localLeft, "this computer: the page left instead of saying the connection is lost");
			pass(`a dropped connection: on a shared server a 401 sends the page to sign in, a signed-in person sees the lost-connection line, and this computer shows the line as today (${Math.round((Date.now() - started) / 1000)}s)`);
			for (const { opened } of [signedOut, outage, local]) await opened.context.close();
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
			assert((await page.locator(".settings-overlay .room-instructions-section button").filter({ hasText: /^Save$/ }).count()) === 1, "this computer: Save is missing");
			await openTab(page, "Connectors");
			assert((await page.locator(".settings-overlay .connector-dir-search").count()) === 1, "this computer: the connector directory is missing");
			await openTab(page, "Skills");
			for (const name of ["Repository libraries", "Add skill"]) {
				assert((await page.locator(".settings-overlay").getByRole("button", { name, exact: true }).count()) === 1, `this computer: ${name} is missing`);
			}
			assert((await page.locator(".settings-overlay").getByText(SHARED_LINE, { exact: true }).count()) === 0, "this computer: the shared-server line is shown");
			await closeSettings(page);
			pass("this computer: the sort control, Wallet, Remote access, Profiles and every setting control are there, with no shared-server line");

			await enterRoom(page, "Bash Room");
			assert((await page.locator(".bash-mode-chip").count()) === 1, "this computer: the Bash chip is missing");
			await openRoomWorkspace(page);
			for (const label of ["Edit workspace", "Clear"]) {
				assert((await page.locator(".room-workspace-section button").filter({ hasText: label }).count()) === 1, `this computer: ${label} is missing`);
			}
			await closeSettings(page);
			await enterRoom(page, "Alpha Room");
			await openRoomWorkspace(page);
			assert((await page.locator(".room-workspace-section button").filter({ hasText: "Set workspace" }).count()) === 1, "this computer: Set workspace is missing");
			assert((await countText(page, ".room-workspace-section", NO_FOLDER_LINE)) === 0, "this computer: the shared-server folder line is shown");
			await closeSettings(page);
			await openShelfFile(page);
			assert((await page.locator(".artifact-viewer-quiet").filter({ hasText: "Save…" }).count()) === 1, "this computer: Save… is missing");
			pass("this computer: rooms offer the Bash chip, the workspace editor, Set workspace and Save…");
			await context.close();
		}
	} finally {
		await browser.close();
	}

	console.log("shared-server-page smoke: ok");
} finally {
	await stopSmokeServer(server);
	fs.rmSync(tempHome, { recursive: true, force: true });
}
