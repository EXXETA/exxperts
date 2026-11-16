// A tab nobody is looking at asks the server nothing. With the tab hidden the
// Memory page and the Wallet send no polls; shown again, each asks once at once
// and shows the news with no reload, then polls as before. A shown tab polls as
// it always did.
//
// Chromium under Playwright reports "visible" whatever happens to its window or
// tabs, so the smoke sets what the browser would say and fires the browser's
// event; the page's own code then runs for real, against the real server. The
// page's clock is paused, so a count is exact and nothing waits out a poll.
//
// Offline: no model is called.
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, type BrowserContext, type Locator, type Page, type Request } from "playwright";
import { SMOKE_AUTH_TOKEN, SMOKE_SERVER_AUTH_ENV, SMOKE_SERVER_SPAWN_TREE_OPTIONS, smokeHomeEnv, stopSmokeServer, freePort } from "./smoke-server-process.js";
import { waitEvery } from "./smoke-wait.js";

const waitUntil = waitEvery(150);

function assert(condition: unknown, message: string): asserts condition {
	if (!condition) throw new Error(message);
}

{
	const p = typeof chromium?.executablePath === "function" ? chromium.executablePath() : "";
	if (!p || !fs.existsSync(p)) {
		console.log("hidden tab polls smoke skipped (Chromium not installed)");
		process.exit(0);
	}
}

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const webServerDir = path.resolve(scriptDir, "..");
const repoRoot = path.resolve(webServerDir, "..", "..");
const port = await freePort();
const baseUrl = `http://127.0.0.1:${port}`;

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "exxperts-hidden-tab-polls-"));
const tempHome = path.join(tempRoot, "home");
const agentsRoot = path.join(tempHome, ".exxperts", "app", "personalized-agents");
const agentDir = path.join(tempHome, ".exxperts", "agent");
for (const dir of [agentsRoot, agentDir]) fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
process.env.HOME = tempHome;
process.env.USERPROFILE = tempHome;
// The app's state follows these before HOME: left set, the smoke would write into the profile they name.
delete process.env.EXXPERTS_DATA_DIR;
delete process.env.EXXPERTS_STATE_HOME;
process.env.EXXPERTS_CODING_AGENT_DIR = agentDir;
process.env.EXXETA_PERSISTENT_AGENTS_ROOT = agentsRoot;

let server: ChildProcessWithoutNullStreams | undefined;
const serverOutput: string[] = [];

interface PolledPage {
	label: string;
	address: string;
	pollPath: string;
	everyMs: number;
	shown: (page: Page) => Locator;
	news: (page: Page) => Locator;
	bringNews: () => void;
}

// The tab's state, set before the page's own scripts run so a tab can open
// hidden. Plain text: tsx wraps a passed function's inner functions in a helper
// the page does not have.
const hideControl = (startHidden: boolean): string => `
	let hidden = ${startHidden};
	Object.defineProperty(document, "hidden", { configurable: true, get: () => hidden });
	Object.defineProperty(document, "visibilityState", { configurable: true, get: () => (hidden ? "hidden" : "visible") });
	window.setTabHidden = (next) => {
		hidden = next;
		document.dispatchEvent(new Event("visibilitychange"));
	};
`;

async function setTabHidden(page: Page, hidden: boolean): Promise<void> {
	await page.evaluate((next) => (window as unknown as { setTabHidden: (next: boolean) => void }).setTabHidden(next), hidden);
}

// Opens a tab with its requests counted.
async function openTab(ctx: BrowserContext, target: PolledPage, startHidden = false): Promise<{ page: Page; asked: string[]; settled: () => Promise<number> }> {
	const page = await ctx.newPage();
	const asked: string[] = [];
	let answered = 0;
	const isPoll = (url: string) => new URL(url).pathname === target.pollPath;
	const countAnswer = (request: Request) => { if (isPoll(request.url())) answered += 1; };
	page.on("request", (request) => { if (isPoll(request.url())) asked.push(new URL(request.url()).search); });
	page.on("requestfinished", countAnswer);
	page.on("requestfailed", countAnswer);
	await page.addInitScript({ content: hideControl(startHidden) });
	await page.clock.install();
	await page.goto(`${baseUrl}${target.address}`);
	let marks = 0;
	// Requests reach the smoke in the order the page sent them, so everything
	// sent before this mark has been counted once the mark arrives. Waiting for
	// the answers too keeps a poll sent while shown from reading news brought
	// after the tab was hidden.
	const settled = async (): Promise<number> => {
		const mark = `/healthz?mark=${++marks}`;
		const arrived = page.waitForRequest((request) => request.url().endsWith(mark));
		await page.evaluate((url) => { void fetch(url); }, mark);
		await arrived;
		await waitUntil(() => answered === asked.length, `${target.label}'s polls are answered`);
		return asked.length;
	};
	return { page, asked, settled };
}

async function stopClock(page: Page): Promise<void> {
	await page.clock.pauseAt(Date.now() + 60_000);
}

async function checkHiddenAndBack(ctx: BrowserContext, target: PolledPage): Promise<void> {
	const { page, settled } = await openTab(ctx, target);
	await target.shown(page).first().waitFor({ timeout: 20000 });
	await stopClock(page);

	// Shown: as today, one ask each round.
	const atStart = await settled();
	await page.clock.runFor(target.everyMs * 3);
	const shownAsks = (await settled()) - atStart;
	assert(shownAsks === 3, `${target.label}: a shown tab asks once a round, got ${shownAsks} asks in 3 rounds`);
	console.log(`  ok  ${target.label}: a shown tab polls as before`);

	// Hidden: the server has news, and nobody asks for it.
	await page.evaluate(() => { (window as unknown as { sameDocument: boolean }).sameDocument = true; });
	await setTabHidden(page, true);
	const beforeHidden = await settled();
	target.bringNews();
	await page.clock.runFor(target.everyMs * 5);
	const hiddenAsks = (await settled()) - beforeHidden;
	assert(hiddenAsks === 0, `${target.label}: a hidden tab sends no polls, got ${hiddenAsks} in 5 rounds`);
	assert((await target.news(page).count()) === 0, `${target.label}: the news has not reached a hidden tab`);
	console.log(`  ok  ${target.label}: a hidden tab sends no polls`);

	// Shown again, with the clock still stopped: the ask and the news come from
	// the showing itself, never from a round coming due.
	await setTabHidden(page, false);
	await target.news(page).first().waitFor({ timeout: 10000 });
	const showAsks = (await settled()) - beforeHidden;
	assert(showAsks === 1, `${target.label}: shown again, the tab asks once, got ${showAsks}`);
	assert(await page.evaluate(() => (window as unknown as { sameDocument?: boolean }).sameDocument === true), `${target.label}: the news came with no reload`);
	console.log(`  ok  ${target.label}: shown again, the tab asks once at once and shows the news with no reload`);

	// And it polls as before: one ask a round, so hiding left no second timer.
	await page.clock.runFor(target.everyMs * 2);
	const roundAsks = (await settled()) - beforeHidden - showAsks;
	assert(roundAsks === 2, `${target.label}: after showing, one ask a round, got ${roundAsks} in 2 rounds`);
	console.log(`  ok  ${target.label}: back to one poll a round`);

	// Leaving the page ends it: a later hide and show asks nothing.
	await page.getByRole("button", { name: "Rooms", exact: true }).click();
	await target.shown(page).first().waitFor({ state: "detached", timeout: 10000 });
	const left = await settled();
	await setTabHidden(page, true);
	await setTabHidden(page, false);
	await page.clock.runFor(target.everyMs * 2);
	const leftAsks = (await settled()) - left;
	assert(leftAsks === 0, `${target.label}: a page that was left asks nothing, got ${leftAsks}`);
	console.log(`  ok  ${target.label}: a page that was left asks nothing on a hide and show`);
	await page.close();
}

async function checkOpenedHidden(ctx: BrowserContext, target: PolledPage): Promise<void> {
	const { page, settled } = await openTab(ctx, target, true);
	// The Wallet mounts only once the server has said what kind it is, so the
	// page's first requests must be over before the rounds below count for it.
	await page.locator(".product-nav").waitFor({ timeout: 20000 });
	await page.waitForLoadState("networkidle");
	await stopClock(page);
	await page.clock.runFor(target.everyMs * 3);
	const hiddenAsks = await settled();
	assert(hiddenAsks === 0, `${target.label}: a tab opened hidden sends no polls, got ${hiddenAsks}`);
	await setTabHidden(page, false);
	await target.shown(page).first().waitFor({ timeout: 20000 });
	const shownAsks = await settled();
	assert(shownAsks === 1, `${target.label}: a tab opened hidden asks once when shown, got ${shownAsks}`);
	console.log(`  ok  ${target.label}: a tab opened hidden waits, then fills in when shown`);
	await page.close();
}

try {
	const agents = await import("../src/persistent-agents.js");
	const { appendUsage } = await import("../src/usage-log.js");
	const newRoom = (displayName: string) => agents.createPersistentAgentFromScaffoldInput({ displayName, userName: "Synthetic User", preferredUserAddress: "Synthetic User" }).agent.agentId;
	const spend = (agent: string) => appendUsage({ ts: Date.now(), agent, persona: "synthetic", model: "claude-fake", provider: "fake-claude", kind: "chat", input: 100, output: 50, cacheRead: 0, cacheWrite: 0, cost: 0.25 });
	spend(newRoom("Kept Room"));
	const quietRoom = newRoom("Quiet Spender");

	server = spawn("npx", ["tsx", "src/index.ts"], {
		shell: process.platform === "win32",
		...SMOKE_SERVER_SPAWN_TREE_OPTIONS,
		cwd: webServerDir,
		env: smokeHomeEnv(tempHome, { PORT: String(port), ...SMOKE_SERVER_AUTH_ENV, EXXETA_HOME: repoRoot, EXXPERTS_CODING_AGENT_DIR: agentDir, EXXETA_PERSISTENT_AGENTS_ROOT: agentsRoot }) as NodeJS.ProcessEnv,
	});
	server.stdout.on("data", (chunk) => serverOutput.push(String(chunk)));
	server.stderr.on("data", (chunk) => serverOutput.push(String(chunk)));
	await waitUntil(() => fetch(`${baseUrl}/healthz`).then((r) => r.ok).catch(() => false), "server ready", 60_000);

	const memory: PolledPage = {
		label: "Memory",
		address: "/#/memory",
		pollPath: "/api/memory/overview",
		everyMs: 8000,
		shown: (page) => page.locator(".mem-card-name", { hasText: "Kept Room" }),
		news: (page) => page.locator(".mem-card-name", { hasText: "Fresh Room" }),
		bringNews: () => { newRoom("Fresh Room"); },
	};
	const wallet: PolledPage = {
		label: "Wallet",
		address: "/#/dashboard",
		pollPath: "/api/usage",
		everyMs: 5000,
		shown: (page) => page.locator(".dashboard").getByText("Kept Room"),
		news: (page) => page.locator(".dashboard").getByText("Quiet Spender"),
		bringNews: () => spend(quietRoom),
	};

	const browser = await chromium.launch();
	try {
		const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
		const signIn = await ctx.newPage();
		await signIn.goto(`${baseUrl}/auth/session?token=${SMOKE_AUTH_TOKEN}`);
		await signIn.close();

		await checkHiddenAndBack(ctx, memory);
		await checkHiddenAndBack(ctx, wallet);
		await checkOpenedHidden(ctx, memory);
		await checkOpenedHidden(ctx, wallet);

		// A filter picked before hiding is the one the tab asks with when shown.
		const { page, asked, settled } = await openTab(ctx, wallet);
		await wallet.shown(page).first().waitFor({ timeout: 20000 });
		await stopClock(page);
		await page.getByRole("button", { name: "7d", exact: true }).click();
		await waitUntil(() => asked.at(-1)?.includes("range=7d") === true, "the Wallet asks for the picked range");
		await setTabHidden(page, true);
		const beforeHidden = await settled();
		await page.clock.runFor(wallet.everyMs * 2);
		assert((await settled()) === beforeHidden, "a hidden Wallet sends no polls after a filter change");
		await setTabHidden(page, false);
		assert((await settled()) === beforeHidden + 1, "a shown Wallet asks once after a filter change");
		assert(asked.at(-1)?.includes("range=7d"), `shown again, the Wallet asks with the picked range, got ${asked.at(-1)}`);
		await page.clock.runFor(wallet.everyMs);
		assert((await settled()) === beforeHidden + 2, "a filter change leaves one poll a round");
		console.log("  ok  Wallet: a picked range holds through a hide and show, with one poll a round");
	} finally {
		await browser.close();
	}
	console.log("hidden tab polls smoke passed");
} catch (error) {
	console.error(serverOutput.join("").slice(-2000));
	throw error;
} finally {
	await stopSmokeServer(server);
	fs.rmSync(tempRoot, { recursive: true, force: true });
}
