// The page's reconnect ladders end with the app. When a render error puts the
// error boundary's screen in place of the app, nothing of the app goes on
// trying to reach the server: not a try the app's own teardown would start
// (closing its live connection), not a try whose question was already out,
// and not a try already waiting on its timer. Both ladders are covered: a
// room's, and the one Home's live connection has. Every case is paired with
// the same steps without the crash, where the try does come in the same time.
// The crash is the real boundary, set failed through React's own tree:
// nothing in the app throws on demand.
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, type Browser, type BrowserContext, type Page, type WebSocketRoute } from "playwright";
import { authedFetch, SMOKE_AUTH_TOKEN, SMOKE_SERVER_AUTH_ENV, SMOKE_SERVER_SPAWN_TREE_OPTIONS, smokeHomeEnv, stopSmokeServer, freePort, waitForServer } from "./smoke-server-process.js";

const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), "exxperts-app-unmount-reconnect-"));
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

const BOUNDARY_LINE = "Something went wrong on this page. Reloading usually fixes it.";
const ROOM = "Unmount Room";
// Longer than any ladder's first wait (a room's at most one and a half seconds, Home's second try two):
// the paired case without the crash shows the try comes inside it.
const TRY_WINDOW_MS = 6000;

// Environments without an installed Chromium (the Linux Docker gate sets
// EXXETA_SKIP_BROWSER_INSTALL=1) cannot run a browser assertion at all; skip
// whole, as the other browser smokes do.
{
	const p = typeof chromium?.executablePath === "function" ? chromium.executablePath() : "";
	if (!p || !fs.existsSync(p)) {
		console.log("app unmount reconnect smoke skipped (Chromium not installed)");
		fs.rmSync(tempHome, { recursive: true, force: true });
		process.exit(0);
	}
}

// A signed-in provider, so the room has a model and can be entered.
const agentDir = path.join(tempHome, ".exxperts", "agent");
fs.mkdirSync(agentDir, { recursive: true, mode: 0o700 });
fs.writeFileSync(path.join(agentDir, "auth.json"), JSON.stringify({ "openai-codex": { type: "api_key", key: "sk-smoke" } }), { mode: 0o600 });

let server: ChildProcessWithoutNullStreams | null = null;

async function until(condition: () => boolean | Promise<boolean>, message: string, timeoutMs = 15000): Promise<void> {
	const end = Date.now() + timeoutMs;
	while (Date.now() < end) {
		if (await condition()) return;
		await new Promise((resolve) => setTimeout(resolve, 50));
	}
	throw new Error(message);
}

/** Whether the condition comes true within the time; a wait for something that should NOT happen. */
async function appears(condition: () => boolean, timeoutMs: number): Promise<boolean> {
	const end = Date.now() + timeoutMs;
	while (Date.now() < end) {
		if (condition()) return true;
		await new Promise((resolve) => setTimeout(resolve, 50));
	}
	return false;
}

/**
 * One page whose live connections pass through to the server until drop(),
 * and whose client-context reads can be held, failed, or answered with
 * sharedServer. What the ladders do shows as requests: a room's try reads its
 * thread (after client-context on a shared server), Home's try on a shared
 * server reads client-context, and every rebuild opens a socket.
 */
type Watched = {
	context: BrowserContext;
	page: Page;
	/** Client-context reads, thread reads and sockets opened so far: a try is any of them. */
	tries: () => number;
	failedThreadReads: () => number;
	failedContextReads: () => number;
	roomReady: () => number;
	drop: () => void;
	failContextReads: () => void;
	failThreadReads: () => void;
	holdNextContext: () => void;
	holding: () => boolean;
	release: (fail: boolean) => void;
};

async function openWatched(browser: Browser, sharedServer: boolean): Promise<Watched> {
	const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
	let dropped = false;
	let contextFails = false;
	let threadFails = false;
	let holdNext = false;
	let holding = false;
	let release: (fail: boolean) => void = () => {};
	let sockets = 0;
	let roomReady = 0;
	const live: WebSocketRoute[] = [];
	await context.route("**/api/remote/client-context", async (route) => {
		const body = JSON.stringify({ remote: false, capability: "full", sharedServer });
		if (holdNext) {
			holdNext = false;
			holding = true;
			const fail = await new Promise<boolean>((resolve) => { release = resolve; });
			holding = false;
			return fail ? route.abort() : route.fulfill({ contentType: "application/json", body });
		}
		if (contextFails) return route.abort();
		return route.fulfill({ contentType: "application/json", body });
	});
	await context.route(/\/api\/persistent-agents\/[^/]+\/threads\/[^/?]+$/, (route) =>
		threadFails && route.request().method() === "GET" ? route.abort() : route.continue());
	await context.routeWebSocket(/\/ws(\?|$)/, (ws) => {
		sockets += 1;
		if (dropped) {
			void ws.close();
			return;
		}
		const toServer = ws.connectToServer();
		const isRoom = ws.url().includes("persistentAgentId=");
		toServer.onMessage((message) => {
			if (isRoom) {
				try { if (JSON.parse(String(message))?.type === "ready") roomReady += 1; } catch {}
			}
			ws.send(message);
		});
		live.push(ws);
	});
	const page = await context.newPage();
	let threadReads = 0;
	let failedThreadReads = 0;
	let contextReads = 0;
	let failedContextReads = 0;
	const isThreadRead = (url: string, method: string) => method === "GET" && /^\/api\/persistent-agents\/[^/]+\/threads\/[^/]+$/.test(new URL(url).pathname);
	const isContextRead = (url: string) => new URL(url).pathname === "/api/remote/client-context";
	page.on("request", (request) => {
		if (isThreadRead(request.url(), request.method())) threadReads += 1;
		if (isContextRead(request.url())) contextReads += 1;
	});
	page.on("requestfailed", (request) => {
		if (isThreadRead(request.url(), request.method())) failedThreadReads += 1;
		if (isContextRead(request.url())) failedContextReads += 1;
	});
	await page.goto(`${baseUrl}/auth/session?token=${SMOKE_AUTH_TOKEN}`);
	await page.waitForLoadState("networkidle");
	const dismiss = page.locator(".whats-new-close");
	if (await dismiss.count()) await dismiss.click();
	await page.locator(".persistent-agent-card").first().waitFor({ timeout: 15000 });
	await until(() => live.length > 0, "Home's live connection opened");
	return {
		context,
		page,
		tries: () => threadReads + contextReads + sockets,
		failedThreadReads: () => failedThreadReads,
		failedContextReads: () => failedContextReads,
		roomReady: () => roomReady,
		drop: () => {
			dropped = true;
			for (const ws of live.splice(0)) void ws.close();
		},
		failContextReads: () => { contextFails = true; },
		failThreadReads: () => { threadFails = true; },
		holdNextContext: () => { holdNext = true; },
		holding: () => holding,
		release: (fail) => release(fail),
	};
}

/** Into the room from Home, once its live connection has said ready. */
async function enterRoom(watched: Watched): Promise<void> {
	const before = watched.roomReady();
	await watched.page.locator(".persistent-agent-card").filter({ hasText: ROOM }).locator(".persistent-agent-primary-actions .landing-action").first().click();
	await watched.page.locator('button.icon-btn[aria-label="Room settings"]').waitFor({ timeout: 15000 });
	await until(() => watched.roomReady() > before, "the room's live connection said ready");
}

/** The render error the boundary catches: its own state set from its own getDerivedStateFromError, found in React's tree. */
async function crash(page: Page): Promise<void> {
	await page.evaluate(() => {
		const root = document.getElementById("root") as unknown as Record<string, unknown>;
		const key = Object.keys(root).find((name) => name.startsWith("__reactContainer$"));
		type Fiber = { type?: { getDerivedStateFromError?: (error: Error) => object }; stateNode?: { setState: (state: object) => void }; child?: Fiber | null; sibling?: Fiber | null };
		const stack: Array<Fiber | null | undefined> = [key ? (root[key] as Fiber) : null];
		while (stack.length > 0) {
			const fiber = stack.pop();
			if (!fiber) continue;
			const derive = fiber.type?.getDerivedStateFromError;
			if (typeof derive === "function" && fiber.stateNode) {
				fiber.stateNode.setState(derive(new Error("smoke crash")));
				return;
			}
			stack.push(fiber.sibling, fiber.child);
		}
		throw new Error("no error boundary in the page");
	});
	await page.getByText(BOUNDARY_LINE).waitFor({ timeout: 10000 });
	assert((await page.locator(".persistent-agent-card, button.icon-btn[aria-label=\"Room settings\"]").count()) === 0, "the crash screen shows, but the app is still drawn");
}

/**
 * Runs a case twice, without the crash and with it: without, a try comes within the window; with, none does.
 * dropWithout ends the connection in the run without the crash, as the app's teardown does in the one with it.
 */
async function pairOf(browser: Browser, label: string, sharedServer: boolean, steps: (watched: Watched) => Promise<void>, options: { dropWithout?: boolean; then?: (watched: Watched) => void } = {}): Promise<void> {
	for (const crashes of [false, true]) {
		const watched = await openWatched(browser, sharedServer);
		try {
			await steps(watched);
			const before = watched.tries();
			if (crashes) await crash(watched.page);
			else if (options.dropWithout) watched.drop();
			options.then?.(watched);
			const tried = await appears(() => watched.tries() > before, TRY_WINDOW_MS);
			if (crashes) assert(!tried, `${label}: the app tried to reconnect after the crash screen replaced it`);
			else assert(tried, `${label}: without the crash no try came within ${TRY_WINDOW_MS} ms, so the window proves nothing`);
		} finally {
			await watched.context.close();
		}
	}
	pass(label);
}

try {
	server = spawn("npx", ["tsx", "src/index.ts"], {
		shell: process.platform === "win32",
		...SMOKE_SERVER_SPAWN_TREE_OPTIONS,
		cwd: webServerDir,
		env: { ...smokeHomeEnv(tempHome), PORT: String(port), ...SMOKE_SERVER_AUTH_ENV },
		stdio: ["ignore", "pipe", "pipe"],
	}) as unknown as ChildProcessWithoutNullStreams;
	await waitForServer(server, baseUrl, { tries: 200 });
	const created = await authedFetch(`${baseUrl}/api/persistent-agents`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ displayName: ROOM, userName: "Synthetic User", preferredUserAddress: "Synthetic User" }),
	});
	assert(created.ok, `room create: ${created.status} ${await created.text()}`);

	const browser = await chromium.launch();
	try {
		// The app's own teardown closes the live connection; its close arrives once the app is gone.
		await pairOf(browser, "a room connected when the app ends: no try follows", false, (watched) => enterRoom(watched), { dropWithout: true });
		await pairOf(browser, "Home connected on a shared server when the app ends: no try follows", true, async () => {}, { dropWithout: true });

		// A try whose question is out when the app ends: it never goes on.
		await pairOf(browser, "a room's try with its question out on a shared server: it does not go on to read the thread", true, async (watched) => {
			await enterRoom(watched);
			watched.holdNextContext();
			watched.drop();
			await until(() => watched.holding(), "the room's try asked client-context");
		}, { then: (watched) => watched.release(false) });
		await pairOf(browser, "Home's try with its question out on a shared server: a failed answer schedules no next try", true, async (watched) => {
			watched.holdNextContext();
			watched.drop();
			await until(() => watched.holding(), "Home's try asked client-context");
		}, { then: (watched) => watched.release(true) });

		// A try already waiting on its timer when the app ends: the timer never fires. The socket effect's
		// cleanup already clears such a timer; these two guard that it stays so.
		await pairOf(browser, "a room's next try waiting on its timer: it never fires", false, async (watched) => {
			await enterRoom(watched);
			watched.failThreadReads();
			watched.drop();
			await until(() => watched.failedThreadReads() > 0, "the room's first try failed");
		});
		await pairOf(browser, "Home's next try waiting on its timer on a shared server: it never fires", true, async (watched) => {
			watched.failContextReads();
			watched.drop();
			await until(() => watched.failedContextReads() > 0, "Home's first try failed");
		});
	} finally {
		await browser.close();
	}

	console.log("app-unmount-reconnect smoke: ok");
} finally {
	await stopSmokeServer(server);
	fs.rmSync(tempHome, { recursive: true, force: true });
}
