// The guide on a first run, in the browser against a real spawned server with
// no model. "How exxperts works" is flow, steps by when, numbered, and tiles,
// at desktop and phone width, with a shared server's first step for a member
// and an admin, neither sent to what a shared server does not offer. It opens
// by itself once, for a person with no rooms, the first time Home shows: the
// X, Esc or a click outside marks it seen, and neither a reload nor a restart
// brings it back, while the gear still offers it. It never opens for someone with rooms, archived ones included, and that person
// keeps not getting it after emptying Home. It never opens over What's new, on
// the computer or on a shared server: it opens as that window closes, and only
// for someone it is still due for. A failed read of the rooms opens nothing and
// is not remembered.
// Run: npm run smokes -- first-run-guide   (or tsx this file)
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, type Browser, type BrowserContext, type BrowserContextOptions, type Page } from "playwright";
import { authedFetch, SMOKE_AUTH_TOKEN, SMOKE_SERVER_AUTH_ENV, SMOKE_SERVER_SPAWN_TREE_OPTIONS, smokeHomeEnv, stopSmokeServer, freePort } from "./smoke-server-process.js";
import { waitEvery } from "./smoke-wait.js";

const waitUntil = waitEvery(150);

// What a person sees is checked to the end of the run; every miss is listed at once.
const misses: string[] = [];
function check(condition: unknown, message: string): void {
	if (!condition) misses.push(message);
}

{
	const p = typeof chromium?.executablePath === "function" ? chromium.executablePath() : "";
	if (!p || !fs.existsSync(p)) {
		console.log("first run guide ui smoke skipped (Chromium not installed)");
		process.exit(0);
	}
}

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const webServerDir = path.resolve(scriptDir, "..");
const repoRoot = path.resolve(webServerDir, "..", "..");
const port = await freePort();
const baseUrl = `http://127.0.0.1:${port}`;

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "exxperts-first-run-guide-"));
const tempHome = path.join(tempRoot, "home");
const appState = path.join(tempHome, ".exxperts", "app");
const agentsRoot = path.join(appState, "personalized-agents");
const agentDir = path.join(tempHome, ".exxperts", "agent");
for (const dir of [agentsRoot, agentDir]) fs.mkdirSync(dir, { recursive: true, mode: 0o700 });

let server: ChildProcessWithoutNullStreams | undefined;
const serverOutput: string[] = [];
// A provider key in the shell that runs the smoke would connect an AI.
const PROVIDER_CREDENTIAL = /_API_KEY$|_OAUTH_TOKEN$|^(COPILOT_GITHUB_TOKEN|GH_TOKEN|GITHUB_TOKEN|HF_TOKEN|GOOGLE_APPLICATION_CREDENTIALS|GOOGLE_CLOUD_PROJECT|GCLOUD_PROJECT|AWS_ACCESS_KEY_ID|AWS_SECRET_ACCESS_KEY|AWS_PROFILE|AWS_BEARER_TOKEN_BEDROCK)$/;

const SEEN_KEY = "exxperts.first-run-guide-seen";
const DESKTOP: BrowserContextOptions = { viewport: { width: 1440, height: 900 } };
const PHONE: BrowserContextOptions = { viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true };

const guide = (page: Page) => page.getByRole("dialog", { name: "How exxperts works" });
const seen = (page: Page): Promise<boolean> => page.evaluate((key) => localStorage.getItem(key) !== null, SEEN_KEY);
const opensByItself = async (page: Page, what: string): Promise<void> => guide(page).waitFor({ timeout: 15000 }).catch(() => { throw new Error(`${what}: the guide did not open by itself`); });

async function openApp(context: BrowserContext): Promise<Page> {
	const page = await context.newPage();
	await page.goto(`${baseUrl}/auth/session?token=${SMOKE_AUTH_TOKEN}`);
	return page;
}

/** Home is drawn and its reads have settled: whatever was going to open has opened. */
async function homeSettled(page: Page): Promise<void> {
	await page.getByRole("heading", { name: "Your rooms." }).waitFor({ timeout: 15000 });
	await page.waitForLoadState("networkidle");
	await page.evaluate(() => new Promise(requestAnimationFrame));
}

/**
 * Closes What's new once Home has settled, so whatever waits for it is waiting.
 * Settling comes first because the page never reads the answer to its seen
 * POST, which keeps that request open and the network from ever going idle.
 */
async function closeWhatsNewOnSettledHome(page: Page): Promise<void> {
	const close = page.locator(".whats-new-close");
	await close.waitFor({ timeout: 15000 });
	await homeSettled(page);
	await close.click();
	await close.waitFor({ state: "detached" });
	await page.evaluate(() => new Promise(requestAnimationFrame));
}

async function asSharedServer(context: BrowserContext, role: "member" | "admin"): Promise<void> {
	const body = JSON.stringify({ remote: false, capability: "full", sharedServer: true, person: { id: `${role}-1`, name: role, admin: role === "admin" } });
	await context.route("**/api/remote/client-context", (route) => route.fulfill({ contentType: "application/json", body }));
}

/** The next load finds releases this machine has not acknowledged. */
function whatsNewDueNext(): void {
	fs.writeFileSync(path.join(appState, "whats-new.json"), JSON.stringify({ acknowledgedVersion: "0.0.1", rule: "every-release" }));
}

type Read = { lede: string; flow: string[]; headings: string[]; numbers: string[]; steps: string[]; tiles: string[]; flowTops: number[]; tileLefts: number[]; sideways: boolean };
async function readGuide(page: Page): Promise<Read> {
	const texts = async (selector: string) => (await page.locator(`.help-body ${selector}`).allTextContents()).map((text) => text.trim());
	const stages = await page.locator(".help-flow li").all();
	return {
		lede: (await texts(".help-lede"))[0] ?? "",
		flow: await Promise.all(stages.map(async (stage) => `${await stage.locator("strong").textContent()}: ${await stage.locator("span").textContent()}`)),
		headings: await texts("h3"),
		numbers: await texts(".help-step-number"),
		steps: await texts(".help-steps p"),
		tiles: await texts(".help-tiles li"),
		flowTops: await page.locator(".help-flow li").evaluateAll((items) => items.map((item) => Math.round(item.getBoundingClientRect().top))),
		tileLefts: await page.locator(".help-tiles li").evaluateAll((items) => items.map((item) => Math.round(item.getBoundingClientRect().left))),
		sideways: await page.locator(".help-body").evaluate((body) => body.scrollWidth > body.clientWidth),
	};
}

const FIRST_STEP = "Connect your AI. Open the gear, then Settings, AI setup. Sign in with a subscription, add an API key, or connect your company gateway. Set the default models for your rooms there.";
const DESKTOP_TILES = [
	"Each room can have its own model: Room settings, Model.",
	"Sort your rooms on Home by last used, by name, or drag them into your own order.",
	"A room is open in one place at a time. If it's open in another window, close it there first.",
	"The Memory page shows what your rooms remember. The Wallet shows what you spend.",
];
// No Wallet and no choice of order there.
const SHARED_TILES = [DESKTOP_TILES[0], DESKTOP_TILES[2], "The Memory page shows what your rooms remember."];

function checkWords(read: Read, what: string, firstStep: string, tiles: string[]): void {
	const same = (got: unknown, want: unknown, name: string) => check(JSON.stringify(got) === JSON.stringify(want), `${what}: ${name}, got ${JSON.stringify(got)}`);
	same(read.lede, "Your rooms remember your work, and you decide what they keep.", "the opening line");
	same(read.flow, ["Talk: in a room", "Remember: keeps what matters", "Memorize: turns it into notes", "Review: tidies the notes"], "the flow strip");
	same(read.headings, ["Set up once", "Every conversation", "Now and then", "Good to know"], "the groups by when");
	same(read.numbers, ["1", "2", "3", "4", "5"], "the steps are numbered straight through the groups");
	same(read.steps, [
		firstStep,
		"Create a room. One room per project or topic. Press New room on Home, give it a name and start talking: ask questions, share files, work things through.",
		"Remember what matters. When a conversation is worth keeping, press Remember. You see what the room will keep before anything is saved, unless you switched that preview off in Room settings, Memory. Forget closes a conversation without keeping it.",
		"Come back any time. A room rests fully saved. Press Resume to continue where you left off.",
		"Keep the memory tidy. When conversations pile up, press Maintain on the room's card. Memorize turns them into notes, and Review tidies the notes. Nothing changes without your approval, unless you let Memorize apply by itself in Room settings, Memory.",
	], "the steps");
	same(read.tiles, tiles, "the Good to know tiles");
	check(!read.sideways, `${what}: the guide does not scroll sideways`);
}

try {
	const serverEnv = smokeHomeEnv(tempHome, { PORT: String(port), ...SMOKE_SERVER_AUTH_ENV, EXXETA_HOME: repoRoot, EXXPERTS_CODING_AGENT_DIR: agentDir, EXXETA_PERSISTENT_AGENTS_ROOT: agentsRoot });
	for (const key of Object.keys(serverEnv)) if (PROVIDER_CREDENTIAL.test(key)) delete serverEnv[key];
	server = spawn("npx", ["tsx", "src/index.ts"], {
		shell: process.platform === "win32",
		...SMOKE_SERVER_SPAWN_TREE_OPTIONS,
		cwd: webServerDir,
		env: serverEnv as NodeJS.ProcessEnv,
	});
	server.stdout.on("data", (chunk) => serverOutput.push(String(chunk)));
	server.stderr.on("data", (chunk) => serverOutput.push(String(chunk)));
	await waitUntil(() => fetch(`${baseUrl}/healthz`).then((r) => r.ok).catch(() => false), "server ready");

	const browser: Browser = await chromium.launch();
	try {
		// 1. A fresh install: no What's new, and the guide opens with no click.
		{
			const context = await browser.newContext(DESKTOP);
			const page = await openApp(context);
			await opensByItself(page, "a first run");
			check(!(await page.locator(".whats-new-close").count()), "a fresh install shows no What's new");
			const read = await readGuide(page);
			checkWords(read, "desktop", FIRST_STEP, DESKTOP_TILES);
			check(new Set(read.flowTops).size === 1, `desktop: the flow is one row, got ${JSON.stringify(read.flowTops)}`);
			const edges = await page.evaluate(() => ({ title: document.querySelector(".help-head h2")!.getBoundingClientRect().left, body: document.querySelector(".help-lede")!.getBoundingClientRect().left }));
			check(edges.title === edges.body, `desktop: the title starts on the body's edge, got ${JSON.stringify(edges)}`);
			check(new Set(read.tileLefts).size === 2, `desktop: the tiles are two columns, got ${JSON.stringify(read.tileLefts)}`);
			check(await page.evaluate(() => document.querySelector(".help-modal")?.contains(document.activeElement)), "the focus is inside the guide, for a screen reader and the arrow keys");
			await page.keyboard.press("PageDown");
			await waitUntil(async () => (await page.locator(".help-body").evaluate((body) => body.scrollTop)) > 0, "PageDown scrolls the guide", 3000).catch(() => check(false, "the keyboard scrolls the guide with no click first"));
			await page.locator(".help-body").evaluate((body) => { body.scrollTop = body.scrollHeight; });
			await page.locator(".help-tiles li").last().waitFor();
			check(await page.locator(".help-tiles li").last().evaluate((tile) => tile.getBoundingClientRect().bottom <= tile.closest(".help-body")!.getBoundingClientRect().bottom), "the guide scrolls to its last tile");

			// Only closing it marks it seen.
			check(!(await seen(page)), "an open guide is not seen yet");
			await page.reload();
			await opensByItself(page, "a reload before it was closed");

			await guide(page).getByRole("button", { name: "Close" }).click();
			await guide(page).waitFor({ state: "detached" });
			check(await seen(page), "the X marks it seen");
			await homeSettled(page);
			check((await page.locator(".home-connect-card").count()) === 1, "Home is under the guide");
			await page.reload();
			await homeSettled(page);
			check(!(await guide(page).count()), "a reload does not bring it back");

			// A restart: everything the browser kept, in a new browser session.
			const restarted = await browser.newContext({ ...DESKTOP, storageState: await context.storageState() });
			await context.close();
			const again = await openApp(restarted);
			await homeSettled(again);
			check(!(await guide(again).count()), "a restart does not bring it back");

			// One click away in the gear menu, as before.
			await again.locator("button.sidebar-config-gear").click();
			await again.getByRole("menuitem", { name: "Help" }).hover();
			await again.getByRole("menuitem", { name: "How it works" }).click();
			await guide(again).waitFor({ timeout: 5000 });
			await restarted.close();
		}

		// 2. Esc and a click outside mark it seen too; a click inside closes nothing.
		for (const way of ["Esc", "a click outside"] as const) {
			const context = await browser.newContext(DESKTOP);
			const page = await openApp(context);
			await opensByItself(page, way);
			if (way === "Esc") await page.keyboard.press("Escape");
			else {
				await page.locator(".help-lede").click();
				check((await guide(page).count()) === 1, "a click inside the guide leaves it open");
				await page.mouse.click(20, 450);
			}
			await guide(page).waitFor({ state: "detached" });
			check(await seen(page), `${way} marks it seen`);
			await page.reload();
			await homeSettled(page);
			check(!(await guide(page).count()), `after ${way}, a reload does not bring it back`);
			await context.close();
		}

		// 3. On a phone, dark: one sequence, one column, nothing sideways.
		{
			const context = await browser.newContext({ ...PHONE, colorScheme: "dark" });
			const page = await openApp(context);
			await opensByItself(page, "a phone");
			const read = await readGuide(page);
			checkWords(read, "phone", FIRST_STEP, DESKTOP_TILES);
			check(new Set(read.flowTops).size === 4, `phone: the flow runs top to bottom, got ${JSON.stringify(read.flowTops)}`);
			check(new Set(read.tileLefts).size === 1, `phone: the tiles are one column, got ${JSON.stringify(read.tileLefts)}`);
			// The first tap the guide asks of a new person: the corners of a 44 px square still land on Close.
			const closeTap = await guide(page).getByRole("button", { name: "Close" }).evaluate((button) => {
				const box = button.getBoundingClientRect();
				const [x, y] = [box.left + box.width / 2, box.top + box.height / 2];
				return [[-21, -21], [21, -21], [-21, 21], [21, 21]].map(([dx, dy]) => button.contains(document.elementFromPoint(x + dx, y + dy)));
			});
			check(closeTap.every(Boolean), `phone: Close takes a 44 px tap, corners ${JSON.stringify(closeTap)}`);
			await guide(page).getByRole("button", { name: "Close" }).tap();
			await guide(page).waitFor({ state: "detached" });
			check(await seen(page), "the X marks it seen on a phone");
			await context.close();
		}

		// 4. A shared server's first step, and no Wallet.
		for (const [role, firstStep] of [
			["member", "Your AI. Your admin sets up the models for this server. Each room picks one in Room settings, Model."],
			["admin", "Connect your AI. Open the gear, then Settings, AI setup. Add an API key or connect your company gateway. Set the default models for your rooms there."],
		] as const) {
			const context = await browser.newContext(DESKTOP);
			await asSharedServer(context, role);
			const page = await openApp(context);
			await opensByItself(page, `a shared server's ${role}`);
			await waitUntil(async () => (await readGuide(page)).steps[0] === firstStep, `a shared server's ${role} reads their own first step`);
			checkWords(await readGuide(page), role, firstStep, SHARED_TILES);
			check(role === "admin" || !(await page.locator(".help-body").getByText("AI setup").count()), "a member is not sent to AI setup");
			await context.close();
		}

		// 5. Rooms that could not be read are not "no rooms": nothing opens, nothing is remembered, and the next arrival asks again.
		{
			const context = await browser.newContext(DESKTOP);
			await context.route("**/api/persistent-agents", (route) => route.fulfill({ status: 500, body: "{}" }));
			const page = await openApp(context);
			await homeSettled(page);
			check(!(await guide(page).count()), "a failed read of the rooms opens no guide");
			check(!(await seen(page)), "a failed read of the rooms marks nothing");
			await context.unroute("**/api/persistent-agents");
			await page.reload();
			await opensByItself(page, "the arrival after a failed read");
			await context.close();
		}

		// 5b. Read through the gear before it could open by itself: that close counts too.
		{
			const context = await browser.newContext(DESKTOP);
			await context.route("**/api/persistent-agents", (route) => route.fulfill({ status: 500, body: "{}" }));
			const page = await openApp(context);
			await homeSettled(page);
			await page.locator("button.sidebar-config-gear").click();
			await page.getByRole("menuitem", { name: "Help" }).hover();
			await page.getByRole("menuitem", { name: "How it works" }).click();
			await guide(page).waitFor({ timeout: 5000 });
			await page.keyboard.press("Escape");
			await guide(page).waitFor({ state: "detached" });
			check(await seen(page), "closing the guide opened from the gear marks it seen");
			await context.unroute("**/api/persistent-agents");
			await page.reload();
			await homeSettled(page);
			check(!(await guide(page).count()), "a guide read through the gear does not open by itself later");
			await context.close();
		}

		// 6. What's new goes first and the guide never opens over it: it opens as that window closes, by every way out.
		for (const role of [null, "member"] as const) {
			const what = role ? "a shared server's member" : "this computer";
			whatsNewDueNext();
			const context = await browser.newContext(DESKTOP);
			if (role) await asSharedServer(context, role);
			const page = await openApp(context);
			const close = page.locator(".whats-new-close");
			await close.waitFor({ timeout: 15000 });
			await homeSettled(page);
			check(!(await guide(page).count()), `${what}: the guide does not open over What's new`);
			check(!(await seen(page)), `${what}: giving way marks nothing`);
			await close.click();
			await opensByItself(page, `${what}, as What's new closes`);
			check(!(await close.count()), `${what}: the guide comes after What's new, not with it`);
			check(!(await seen(page)), `${what}: the guide is not seen until it is closed`);
			await page.keyboard.press("Escape");
			await guide(page).waitFor({ state: "detached" });
			check(await seen(page), `${what}: closing the guide marks it seen`);
			await page.reload();
			await homeSettled(page);
			check(!(await guide(page).count()) && !(await close.count()), `${what}: a reload brings neither back`);
			await context.close();
			assertOk((await authedFetch(`${baseUrl}/api/whats-new/seen`, { method: "POST" })).ok, "What's new is acknowledged");
		}

		// 6b. One Esc closes What's new alone: the guide that follows it stays.
		{
			whatsNewDueNext();
			const context = await browser.newContext(DESKTOP);
			const page = await openApp(context);
			await page.locator(".whats-new-close").waitFor({ timeout: 15000 });
			await homeSettled(page);
			await page.keyboard.press("Escape");
			await opensByItself(page, "Esc on What's new");
			await context.close();
			assertOk((await authedFetch(`${baseUrl}/api/whats-new/seen`, { method: "POST" })).ok, "What's new is acknowledged");
		}

		// 6c. Someone who has seen the guide closes What's new with Home empty: it stays closed.
		{
			const context = await browser.newContext(DESKTOP);
			await context.addInitScript((key) => localStorage.setItem(key, "1"), SEEN_KEY);
			whatsNewDueNext();
			const page = await openApp(context);
			await closeWhatsNewOnSettledHome(page);
			check(!(await guide(page).count()), "someone who has seen the guide does not get it after What's new");
			await context.close();
			assertOk((await authedFetch(`${baseUrl}/api/whats-new/seen`, { method: "POST" })).ok, "What's new is acknowledged");
		}

		// 7. Someone with rooms never gets it, and keeps not getting it once Home is empty.
		{
			const created = await authedFetch(`${baseUrl}/api/persistent-agents`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ displayName: "Existing Room", userName: "Synthetic User", preferredUserAddress: "Synthetic User" }) });
			assertOk(created.ok, `the room is created, got ${created.status} ${await created.clone().text()}`);
			const room = (await created.json() as { agent: { id: string } }).agent;

			const context = await browser.newContext(DESKTOP);
			const page = await openApp(context);
			await page.getByRole("heading", { name: "Existing Room" }).waitFor({ timeout: 15000 });
			await waitUntil(() => seen(page), "someone with rooms is marked seen");
			await homeSettled(page);
			check(!(await guide(page).count()), "someone with rooms is not given the guide");
			await context.close();

			// What's new due as well: closing it brings no guide for someone with rooms.
			whatsNewDueNext();
			const updating = await browser.newContext(DESKTOP);
			const updated = await openApp(updating);
			await closeWhatsNewOnSettledHome(updated);
			check(!(await guide(updated).count()), "someone with rooms is not given the guide after What's new");

			const archived = await authedFetch(`${baseUrl}/api/persistent-agents/${encodeURIComponent(room.id)}/archive`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ confirmation: `DELETE ${room.id}` }) });
			assertOk(archived.ok, `the room is archived, got ${archived.status} ${await archived.clone().text()}`);
			await updated.reload();
			await homeSettled(updated);
			check(!(await guide(updated).count()), "emptying Home later does not bring the guide");
			await updating.close();

			// A new browser, the only room archived: its owner is no newcomer.
			const other = await browser.newContext(DESKTOP);
			const fresh = await openApp(other);
			await waitUntil(() => seen(fresh), "the owner of an archived room is marked seen");
			await homeSettled(fresh);
			check(!(await guide(fresh).count()), "the owner of an archived room is not given the guide");
			await other.close();
		}
	} finally {
		await browser.close();
	}

	if (misses.length > 0) throw new Error(`first-run-guide-ui smoke:\n- ${misses.join("\n- ")}`);
	console.log("first-run-guide-ui smoke: ok");
} catch (error) {
	console.error(serverOutput.join("").slice(-6000));
	throw error;
} finally {
	await stopSmokeServer(server);
	fs.rmSync(tempRoot, { recursive: true, force: true });
}

function assertOk(condition: unknown, message: string): asserts condition {
	if (!condition) throw new Error(message);
}
