// Settings, Skills looking for new versions by itself as it opens, in the page:
// the list is on screen before the check answers and nothing shows while it
// runs; what it found shows in the rows and nothing else moves; opening again
// within the hour asks nothing, after it again; coming back to the window, the
// minute's read and a skill's own page ask nothing; a repository that doesn't
// answer says nothing on the list and its skill's page names the host. Beside
// it the person's Check now: with one of three repositories down, what the two
// gave and the third named; the internet only when nothing answered. Update in
// one press once the version is no longer held. The page's top with Add skill
// alone, Browse featured in its menu and on the empty page. From a phone and on
// a shared server: no check at all.
// The repositories are served by git's own http-backend on this machine;
// throwaway HOME.
//
// Run: node scripts/run-smokes.mjs skills-quiet-check-ui

import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, type Browser, type Locator, type Page, type Request } from "playwright";
import { ADD_SKILL_WAYS, CHECK_NOW, CHECKING_NOW, UPDATE_ALL, UPDATE_SKILL } from "../../web-ui/src/skill-source-copy.js";
import { authedFetch, freePort, smokeHomeEnv, SMOKE_AUTH_TOKEN, SMOKE_SERVER_AUTH_ENV, SMOKE_SERVER_SPAWN_TREE_OPTIONS, stopSmokeServer, waitForServer } from "./smoke-server-process.js";
import { gitServesHttp, startStandInGitServer, writeSkill, type StandInRepo } from "./stand-in-git-server.js";

function assert(condition: unknown, message: string): asserts condition {
	if (!condition) throw new Error(message);
}

{
	const executable = typeof chromium?.executablePath === "function" ? chromium.executablePath() : "";
	if (!executable || !fs.existsSync(executable)) {
		console.log("skills-quiet-check-ui smoke skipped (Chromium not installed)");
		process.exit(0);
	}
	if (!gitServesHttp()) {
		console.log("SKIPPED: this git has no http-backend to serve the stand-in repositories");
		process.exit(0);
	}
}

const webServerDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = path.resolve(webServerDir, "..", "..");
const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "exxperts-skills-quiet-check-ui-"));
const home = path.join(tempRoot, "home");
const store = path.join(home, ".exxperts", "agent", "skills");
const resultsFile = path.join(home, ".exxperts", "app", "skill-updates.json");
const serveRoot = path.join(tempRoot, "serve");
const workRoot = path.join(tempRoot, "work");
for (const dir of [store, path.dirname(resultsFile), serveRoot, workRoot]) fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
const standIn = await startStandInGitServer(serveRoot, workRoot);

const port = await freePort();
const baseUrl = `http://127.0.0.1:${port}`;
let server: ChildProcessWithoutNullStreams | null = null;
async function startServer(): Promise<void> {
	server = spawn("npx", ["tsx", "src/index.ts"], {
		shell: process.platform === "win32",
		...SMOKE_SERVER_SPAWN_TREE_OPTIONS,
		cwd: webServerDir,
		env: smokeHomeEnv(home, { PORT: String(port), ...SMOKE_SERVER_AUTH_ENV, EXXETA_HOME: repoRoot }) as NodeJS.ProcessEnv,
		stdio: ["ignore", "pipe", "pipe"],
	}) as unknown as ChildProcessWithoutNullStreams;
	await waitForServer(server, baseUrl, { tries: 100 });
}
async function api(method: string, pathname: string, body?: unknown): Promise<{ status: number; body: any }> {
	const response = await authedFetch(`${baseUrl}${pathname}`, { method, ...(body === undefined ? {} : { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }) });
	const text = await response.text();
	return { status: response.status, body: text ? JSON.parse(text) : null };
}
/** A repository of its own for each skill, and the skill added from it. */
const repos = new Map<string, StandInRepo>();
async function addSkill(name: string): Promise<void> {
	const repo = standIn.makeRepo(name);
	repos.set(name, repo);
	writeSkill(repo.work, `skills/${name}`, name, `The ${name} instructions, first.`);
	repo.commit("first");
	repo.push();
	const scan = await api("POST", "/api/skills/repo/scan", { source: repo.url });
	assert((await api("POST", "/api/skills/repo/import", { token: scan.body.token, path: `skills/${name}` })).status === 201, `${name} added`);
}
function newVersion(name: string, body: string): void {
	const repo = repos.get(name)!;
	writeSkill(repo.work, `skills/${name}`, name, body);
	repo.commit(body);
	repo.push();
}
/** A skill whose repository is at a port that answers nothing. */
function handMade(name: string, address: string): void {
	writeSkill(store, name, name, `The ${name} instructions.`);
	fs.writeFileSync(path.join(store, name, "provenance.json"), JSON.stringify({ source: address, importedAt: new Date().toISOString(), license: null, sha256: "0".repeat(64), repository: { address, refKind: "default", path: `skills/${name}`, commit: "1".repeat(40), filesSha256: "0".repeat(64) } }));
}
/** Moves every stored check's time back, as if `minutes` had passed. */
function pass(minutes: number): void {
	const stored = JSON.parse(fs.readFileSync(resultsFile, "utf-8"));
	const back = (at: string) => new Date(Date.parse(at) - minutes * 60_000).toISOString();
	for (const entry of Object.values(stored.skills) as any[]) {
		if (entry.checkedAt) entry.checkedAt = back(entry.checkedAt);
		if (entry.missed) entry.missed.at = back(entry.missed.at);
	}
	fs.writeFileSync(resultsFile, JSON.stringify(stored));
}

// --- The page ---------------------------------------------------------------------

interface App { page: Page; checks: any[]; pending: Set<Request> }
/** A signed-in page, and the bodies of the checks it asked for. `probe` stands in for a phone's or a shared server's client-context answer. */
async function openApp(browser: Browser, options: { probe?: Record<string, unknown>; clock?: boolean; phoneWidth?: boolean } = {}): Promise<App> {
	const context = await browser.newContext(options.phoneWidth ? { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true } : { viewport: { width: 1280, height: 900 } });
	await context.addInitScript(() => localStorage.setItem("exxperts.first-run-guide-seen", "1"));
	const page = await context.newPage();
	if (options.clock) await page.clock.install();
	const checks: any[] = [];
	const pending = new Set<Request>();
	page.on("requestfinished", (request) => { pending.delete(request); });
	page.on("requestfailed", (request) => { pending.delete(request); });
	page.on("request", (request) => {
		if (request.url().includes("/api/")) pending.add(request);
		if (new URL(request.url()).pathname === "/api/skills/updates/check") checks.push(JSON.parse(request.postData() ?? "{}"));
	});
	if (options.probe) await page.route("**/api/remote/client-context", (route) => route.fulfill({ contentType: "application/json", body: JSON.stringify(options.probe) }));
	// Never a real source: Browse featured's answer is this one.
	await page.route("**/api/skills/featured", (route) => route.fulfill({ contentType: "application/json", body: JSON.stringify({ sources: [] }) }));
	await page.goto(`${baseUrl}/auth/session?token=${SMOKE_AUTH_TOKEN}`);
	await page.waitForLoadState("networkidle");
	const dismiss = page.locator(".whats-new-close");
	if (await dismiss.count()) await dismiss.click();
	return { page, checks, pending };
}
async function showSkills(page: Page): Promise<void> {
	await page.locator(".product-sidebar-footer button").first().click();
	await page.locator(".sidebar-config-menu button, .sidebar-config-menu a").filter({ hasText: /Settings/ }).first().click();
	await page.waitForSelector(".settings-overlay", { timeout: 10_000 });
	await page.locator(".settings-dialog-nav button").filter({ hasText: "Skills" }).first().click();
	await page.locator(".skills-page :is(.skill-table, .settings-empty)").first().waitFor({ timeout: 10_000 });
}
async function closeSettings(page: Page): Promise<void> {
	await page.keyboard.press("Escape");
	await page.locator(".settings-overlay").waitFor({ state: "detached", timeout: 10_000 });
}
async function waitUntil(check: () => boolean, label: string, timeoutMs = 30_000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (!check()) {
		assert(Date.now() < deadline, `timed out waiting until ${label}`);
		await new Promise((resolve) => setTimeout(resolve, 25));
	}
}
/** The page's list read, as its focus asks for, has come back twice after everything it asked for before: a check it has not asked for by then it was not going to ask for. */
async function answered({ page, pending }: App): Promise<void> {
	for (let reads = 0; reads < 2; reads += 1) {
		await waitUntil(() => pending.size === 0, "the page's requests are answered");
		const reread = page.waitForResponse((response) => new URL(response.url()).pathname === "/api/skills");
		await page.evaluate(() => window.dispatchEvent(new Event("focus")));
		await reread;
	}
	await waitUntil(() => pending.size === 0, "the page's requests are answered");
	await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
}
/** The page's one check was asked for and answered, and the list read after it. */
async function checkedQuietly(app: App): Promise<void> {
	await waitUntil(() => app.checks.length > 0, "the page asks for its check");
	await answered(app);
	assert(JSON.stringify(app.checks) === JSON.stringify([{ quiet: true }]), `one quiet check, got ${JSON.stringify(app.checks)}`);
}
const CHECKED = ".skill-updates-checked";
const lines = async (page: Page) => (await page.locator(".skill-updates-line:not(.skill-updates-checked), .skills-page [role=status], .skills-page [role=alert], .skills-page .checkpoint-proposal-error").allInnerTexts()).map((line) => line.trim());
const rowUpdate = (page: Page, name: string) => page.getByRole("button", { name: `${UPDATE_SKILL} ${name}`, exact: true });
const checkNow = (page: Page) => page.locator(CHECKED).getByRole("button");
const menuItems = async (page: Page) => (await page.locator(".skill-add-menu [role=menuitem]").allInnerTexts()).map((item) => item.trim());
async function openSkillPage(page: Page, name: string): Promise<void> {
	await page.locator(".skill-table-row").filter({ has: page.locator(".skill-table-name-text").getByText(name, { exact: true }) }).click();
	await page.waitForSelector(".skill-detail", { timeout: 10_000 });
}
/** Where the page's parts are, and what they say but for the updates' own marks. */
const placed = (page: Page) => page.evaluate(() => JSON.stringify([...document.querySelectorAll(".skills-page .pane-head, .skills-page .skill-updates-checked, .skills-page .skill-table-row .skill-table-name-text")].map((one) => {
	const box = one.getBoundingClientRect();
	return [one.className, Math.round(box.left), Math.round(box.top), one.textContent];
})));

const failed: string[] = [];
async function row(name: string, run: () => Promise<void>): Promise<void> {
	try {
		await run();
		console.log(`ok ${name}`);
	} catch (error) {
		failed.push(`row ${name}: ${(error as Error).message}`);
		console.log(`FAIL ${name}: ${(error as Error).message}`);
	}
}

let browser: Browser | null = null;
try {
	await startServer();
	browser = await chromium.launch();
	const open = async (options: Parameters<typeof openApp>[1] = {}) => {
		const app = await openApp(browser!, options);
		await showSkills(app.page);
		return app;
	};

	await row("1 the empty page: Browse featured on it and in the Add skill menu, Add skill alone in the top, no check", async () => {
		const { page, checks } = await open();
		try {
			const empty = page.locator(".settings-empty");
			const featured = empty.getByRole("button", { name: "browse featured skills", exact: true });
			await featured.waitFor();
			assert((await empty.innerText()).trim() === "No skills yet. Use Add skill to write, upload, or import one, or browse featured skills.", `the empty page's line, got ${JSON.stringify(await empty.innerText())}`);
			assert((await page.locator(CHECKED).count()) === 0, "nothing to check, so no line");
			await featured.click();
			await page.locator(".skill-browse-directory").waitFor({ state: "attached", timeout: 10_000 });
			await page.locator(".pane-head-back").click();
			const top = page.locator(".pane-head-actions button");
			await top.first().waitFor();
			assert((await top.count()) === 1 && (await top.innerText()).trim().startsWith("Add skill"), `only Add skill in the top, got ${JSON.stringify(await top.allInnerTexts())}`);
			await top.click();
			assert(JSON.stringify(await menuItems(page)) === JSON.stringify([ADD_SKILL_WAYS.write, ADD_SKILL_WAYS.upload, ADD_SKILL_WAYS.repository, ADD_SKILL_WAYS.featured]), `the menu, Browse featured last, got ${JSON.stringify(await menuItems(page))}`);
			await page.getByRole("menuitem", { name: ADD_SKILL_WAYS.featured, exact: true }).click();
			await page.locator(".skill-browse-directory").waitFor({ state: "attached", timeout: 10_000 });
			assert(checks.length === 0, "nothing to check, so no check");
		} finally {
			await page.context().close();
		}
	});

	await row("1b a library with no skill from a repository: no line, no Check now, no check", async () => {
		assert((await api("POST", "/api/skills", { id: "by-hand", displayName: "by-hand", description: "Written here.", instructions: "Write it." })).status === 201, "a skill written here");
		const app = await open();
		const { page, checks } = app;
		try {
			await answered(app);
			assert((await page.locator(".skill-table-row").count()) === 1 && (await page.locator(CHECKED).count()) === 0 && (await page.locator(".skill-check-now").count()) === 0, "its row alone, with nothing to check");
			assert(checks.length === 0, `no check, got ${JSON.stringify(checks)}`);
		} finally {
			await page.context().close();
			fs.rmSync(path.join(store, "by-hand"), { recursive: true, force: true });
		}
	});

	for (const name of ["alpha", "beta", "gamma"]) await addSkill(name);
	assert((await api("POST", "/api/skills/updates/check", {})).status === 200, "a first check, so the page has a time to say");
	pass(61);
	newVersion("alpha", "The alpha instructions, second.");

	await row("2 the list is on screen before the check answers, nothing shows while it runs, and the answer shows in the rows alone", async () => {
		const app = await openApp(browser!);
		const { page, checks } = app;
		try {
			let release = () => {};
			const released = new Promise<void>((resolve) => { release = resolve; });
			let landed = false;
			await page.route("**/api/skills/updates/check", async (route) => {
				const answer = await route.fetch();
				await released;
				await route.fulfill({ response: answer });
				landed = true;
			});
			await showSkills(page);
			await page.waitForFunction(() => document.querySelectorAll(".skill-table-row").length === 3);
			await waitUntil(() => checks.length > 0, "the page asks for its check");
			assert(JSON.stringify(checks) === JSON.stringify([{ quiet: true }]), `one quiet check, got ${JSON.stringify(checks)}`);
			assert(!landed && (await rowUpdate(page, "alpha").count()) === 0, "the check hasn't answered");
			assert((await lines(page)).length === 0, `no line while it runs, got ${JSON.stringify(await lines(page))}`);
			assert((await checkNow(page).innerText()) === CHECK_NOW && (await checkNow(page).getAttribute("aria-busy")) === "false", "Check now is not the one running");
			assert((await page.locator(".skills-page .spinner, .skills-page [aria-busy=true]").count()) === 0, "no spinner");
			const before = await placed(page);
			const words = JSON.parse(before).filter(([, , , text]: string[]) => !text.startsWith("Last checked"));
			// The server has asked: the release lets its answer reach the page.
			release();
			await rowUpdate(page, "alpha").waitFor({ timeout: 10_000 });
			await answered(app);
			const after = JSON.parse(await placed(page)).filter(([, , , text]: string[]) => !text.startsWith("Last checked"));
			assert(JSON.stringify(after) === JSON.stringify(words), `nothing else moved: ${JSON.stringify(words)}, then ${JSON.stringify(after)}`);
			assert((await lines(page)).length === 0, `and no line, got ${JSON.stringify(await lines(page))}`);
			assert((await rowUpdate(page, "beta").count()) === 0 && (await rowUpdate(page, "gamma").count()) === 0, "only alpha has an update");
		} finally {
			await page.context().close();
		}
	});

	await row("3 opened again within the hour it asks nothing, after the hour again; nothing on focus, on the minute's read, on coming back from a skill's page, or on opening a skill's page", async () => {
		const app = await open({ clock: true });
		const { page, checks } = app;
		try {
			await answered(app);
			assert(JSON.stringify(checks) === "[]", `within the hour of row 2's check, nothing, got ${JSON.stringify(checks)}`);
			await closeSettings(page);
			pass(61);
			await showSkills(page);
			await checkedQuietly(app);
			// Due again, with the page still open: only opening it asks.
			pass(61);
			const reread = page.waitForResponse((response) => new URL(response.url()).pathname === "/api/skills");
			await page.evaluate(() => window.dispatchEvent(new Event("focus")));
			await reread;
			const minute = page.waitForResponse((response) => new URL(response.url()).pathname === "/api/skills");
			await page.clock.fastForward(60_000);
			await minute;
			await openSkillPage(page, "beta");
			await page.locator(".pane-head-back").click();
			await page.locator(".skill-table").waitFor();
			await answered(app);
			assert(checks.length === 1, `nothing more, got ${JSON.stringify(checks)}`);
		} finally {
			await page.context().close();
		}
	});

	await row("4 a skill's page opened from a room asks nothing, and going from it to the list does", async () => {
		const room = await api("POST", "/api/persistent-agents", { displayName: "Quiet Room", userName: "Synthetic User", preferredUserAddress: "Synthetic User" });
		assert(room.status === 201, `a room, got ${room.status}`);
		// A room's way to a skill's page is the one beside a skill it can't use: one whose files can't be opened.
		writeSkill(store, "scans", "scans", "Sort scanned letters.");
		fs.linkSync(path.join(store, "scans", "SKILL.md"), path.join(store, "scans", "elsewhere.md"));
		const app = await openApp(browser!);
		const { page, checks } = app;
		try {
			await page.locator(".persistent-agent-card").filter({ hasText: "Quiet Room" }).locator(".card-gear-btn").click();
			await page.locator(".rs-shell").waitFor({ timeout: 10_000 });
			await page.locator(".rs-shell .settings-dialog-nav button").filter({ hasText: /^Skills/ }).first().click();
			await page.locator(".room-skill-open").filter({ hasText: /^scans/ }).click();
			await page.locator(".skill-detail").waitFor({ timeout: 10_000 });
			await answered(app);
			assert(JSON.stringify(checks) === "[]", `on the skill's page nothing, got ${JSON.stringify(checks)}`);
			await page.locator(".pane-head-back").click();
			await page.locator(".skill-table").waitFor();
			await checkedQuietly(app);
		} finally {
			await page.context().close();
			fs.rmSync(path.join(store, "scans"), { recursive: true, force: true });
		}
	});

	await row("5 two pages opened at once make one check at the server", async () => {
		pass(61);
		standIn.requests.length = 0;
		let release = () => {};
		standIn.held.set("beta", new Promise<void>((resolve) => { release = resolve; }));
		const apps = [await openApp(browser!), await openApp(browser!)];
		try {
			for (const { page } of apps) await showSkills(page);
			for (const { checks } of apps) await waitUntil(() => checks.length > 0, "each page asks");
			await waitUntil(() => standIn.countFor("beta").asks > 0, "the check asks beta's repository");
			standIn.held.delete("beta");
			release();
			for (const app of apps) await answered(app);
			assert(standIn.countFor("beta").asks === 1, `one ask of beta's repository, got ${JSON.stringify(standIn.countFor("beta"))}`);
		} finally {
			for (const { page } of apps) await page.context().close();
		}
	});

	await row("6 the check failing as a whole says nothing", async () => {
		pass(61);
		const app = await openApp(browser!);
		const { page } = app;
		try {
			await page.route("**/api/skills/updates/check", (route) => route.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ error: "The check failed." }) }));
			await showSkills(page);
			await checkedQuietly(app);
			assert((await lines(page)).length === 0, `nothing, got ${JSON.stringify(await lines(page))}`);
		} finally {
			await page.context().close();
		}
	});

	const closed = `127.0.0.1:${await freePort()}`;
	await row("7 a repository that doesn't answer: nothing on the list, its earlier update kept, and its skill's page names the host", async () => {
		// alpha's repository moves to a port that answers nothing, with its update found before.
		const recordFile = path.join(store, "alpha", "provenance.json");
		const record = JSON.parse(fs.readFileSync(recordFile, "utf-8"));
		const stored = JSON.parse(fs.readFileSync(resultsFile, "utf-8"));
		const address = record.repository.address;
		const repoint = (to: string) => {
			record.repository.address = to;
			fs.writeFileSync(recordFile, JSON.stringify(record));
			const now = JSON.parse(fs.readFileSync(resultsFile, "utf-8"));
			now.skills.alpha.repository.address = to;
			fs.writeFileSync(resultsFile, JSON.stringify(now));
		};
		assert(stored.skills.alpha.state === "available", "alpha has an update");
		repoint(`http://${closed}/team/alpha.git`);
		handMade("delta", `http://${closed}/team/delta.git`);
		const app = await open();
		const { page } = app;
		try {
			await checkedQuietly(app);
			assert((await lines(page)).length === 0, `nothing on the list, got ${JSON.stringify(await lines(page))}`);
			assert((await rowUpdate(page, "alpha").count()) === 1, "alpha keeps its update");
			await openSkillPage(page, "alpha");
			assert((await page.locator(".skill-update-missed").innerText()).trim() === `Couldn't check for a new version: ${closed} didn't answer.`, `alpha's page, got ${await page.locator(".skill-update-group").innerText()}`);
			await page.locator(".pane-head-back").click();
			await openSkillPage(page, "delta");
			assert((await page.locator(".skill-update-state").innerText()).trim() === `Couldn't check for a new version: ${closed} didn't answer.`, `delta's page, got ${await page.locator(".skill-update-group").innerText()}`);
			await page.locator(".pane-head-back").click();
			await openSkillPage(page, "beta");
			assert((await page.locator(".skill-update-missed").count()) === 0, "beta's page says nothing of it");
		} finally {
			await page.context().close();
			fs.rmSync(path.join(store, "delta"), { recursive: true, force: true });
			repoint(address);
		}
	});

	await row("8 Check now with one of three repositories down: running it shows, then the two's result and the third named; pressed again while it runs, nothing more", async () => {
		newVersion("beta", "The beta instructions, second.");
		fs.rmSync(path.join(store, "gamma"), { recursive: true, force: true });
		handMade("gamma", `http://${closed}/team/gamma.git`);
		const app = await open();
		const { page, checks } = app;
		try {
			await answered(app);
			const gapUnder = () => page.evaluate((check) => document.querySelector(".skills-page .skill-table")!.getBoundingClientRect().top - document.querySelector(check)!.getBoundingClientRect().bottom, `${CHECKED} button`);
			const gapAlone = await gapUnder();
			checks.length = 0;
			let release = () => {};
			const released = new Promise<void>((resolve) => { release = resolve; });
			await page.route("**/api/skills/updates/check", async (route) => {
				await released;
				await route.continue();
			});
			await checkNow(page).focus();
			await page.keyboard.press("Enter");
			await page.locator(`${CHECKED} [aria-busy=true]`).waitFor({ timeout: 5_000 });
			assert((await checkNow(page).innerText()) === CHECKING_NOW, `it says it is running, got ${await checkNow(page).innerText()}`);
			await page.keyboard.press("Enter");
			assert(await checkNow(page).evaluate((one) => one === document.activeElement), "the keyboard stays on it");
			release();
			await page.locator(`${CHECKED} [aria-busy=false]`).waitFor({ timeout: 30_000 });
			await answered(app);
			const wanted = ["Updates are available for 2 skills.", `Couldn't check “gamma”: ${closed} didn't answer.`];
			const shown = await lines(page);
			assert(JSON.stringify([...new Set(shown)]) === JSON.stringify(wanted), `the lines: ${JSON.stringify(wanted)}, got ${JSON.stringify(shown)}`);
			assert(Math.abs((await gapUnder()) - gapAlone) < 1, `the line keeps its gap to the list under the messages, ${gapAlone} px alone, got ${await gapUnder()}`);
			assert(JSON.stringify(checks) === JSON.stringify([{}]), `one check, got ${JSON.stringify(checks)}`);
			assert((await rowUpdate(page, "alpha").count()) === 1 && (await rowUpdate(page, "beta").count()) === 1 && (await page.getByRole("button", { name: UPDATE_ALL, exact: true }).count()) === 1, "both updates show, and Update all");
			assert(await checkNow(page).evaluate((one) => one === document.activeElement), "and the keyboard is still on Check now");
		} finally {
			await page.context().close();
		}
	});

	await row("8b at phone width the list stays where it is when Update all shows, and Check now keeps its words on one line", async () => {
		const app = await openApp(browser!, { phoneWidth: true });
		const { page } = app;
		try {
			let two = false;
			await page.route("**/api/skills", async (route) => {
				const answer = await route.fetch();
				const skills = await answer.json();
				await route.fulfill({ response: answer, json: two ? skills : skills.map(({ update, ...skill }: any) => ({ ...skill, ...(update ? { update: { state: "current", checkedAt: update.checkedAt } } : {}) })) });
			});
			await showSkills(page);
			await answered(app);
			const top = () => page.locator(".skills-page .skill-table").evaluate((list) => list.getBoundingClientRect().top);
			const all = page.getByRole("button", { name: UPDATE_ALL, exact: true });
			assert((await all.count()) === 0, "no update yet");
			const alone = await top();
			two = true;
			await page.evaluate(() => window.dispatchEvent(new Event("focus")));
			await all.waitFor({ timeout: 10_000 });
			assert(Math.abs((await top()) - alone) < 1, `the list stays where it is, ${alone} px down, got ${await top()}`);
			const linesOf = (one: Locator) => one.evaluate((node) => {
				const range = document.createRange();
				range.selectNodeContents(node.firstChild!);
				return new Set([...range.getClientRects()].map((rect) => Math.round(rect.top))).size;
			});
			assert((await linesOf(page.locator(CHECKED))) === 1 && (await linesOf(checkNow(page))) === 1, `the time is on one line and Check now on one, got ${await linesOf(page.locator(CHECKED))} and ${await linesOf(checkNow(page))}`);
		} finally {
			await page.context().close();
		}
	});

	await row("9 Update in one press from the list, once the server no longer holds the version", async () => {
		await stopSmokeServer(server);
		await startServer();
		const app = await open();
		const { page } = app;
		try {
			await answered(app);
			await rowUpdate(page, "alpha").click();
			await page.locator("p[role=status]").filter({ hasText: "alpha" }).waitFor({ timeout: 30_000 });
			assert(fs.readFileSync(path.join(store, "alpha", "SKILL.md"), "utf-8").includes("second"), "alpha has the new version");
			// beta's version came from another repository; now that one wants a sign-in.
			standIn.signedOut.add("beta");
			await rowUpdate(page, "beta").click();
			await page.locator(".skills-page").getByText(/^Couldn't update “beta”\./).first().waitFor({ timeout: 30_000 });
			assert((await rowUpdate(page, "beta").count()) === 1, "beta keeps its Update");
		} finally {
			standIn.signedOut.delete("beta");
			await page.context().close();
		}
	});

	await row("10 Check now when nothing answers speaks of the person's internet, and only then", async () => {
		for (const name of ["alpha", "beta"]) fs.rmSync(path.join(store, name), { recursive: true, force: true });
		handMade("delta", `http://${closed}/team/delta.git`);
		const app = await open();
		const { page } = app;
		try {
			await answered(app);
			assert((await lines(page)).length === 0, "opening it says nothing");
			assert((await page.locator(CHECKED).innerText()).trim() === `Not checked yet. ${CHECK_NOW}`, `no check has answered, got ${JSON.stringify(await page.locator(CHECKED).innerText())}`);
			await checkNow(page).click();
			await page.locator(".skill-updates-line:not(.skill-updates-checked)").first().waitFor({ timeout: 30_000 });
			assert(JSON.stringify([...new Set(await lines(page))]) === JSON.stringify(["Couldn't check for updates. Check your internet connection, then try again."]), `got ${JSON.stringify(await lines(page))}`);
			assert((await page.locator(CHECKED).innerText()).trim() === `Not checked yet. ${CHECK_NOW}`, `and none has after the press, got ${JSON.stringify(await page.locator(CHECKED).innerText())}`);
			// One skill alone, offline, reads the same on its page as its host's own line.
			await openSkillPage(page, "delta");
			assert((await page.locator(".skill-update-state").innerText()).trim() === `Couldn't check for a new version: ${closed} didn't answer.`, "its page names the host");
		} finally {
			await page.context().close();
		}
	});

	await row("10b a press nothing answers keeps the time of the last check that answered", async () => {
		const stored = JSON.parse(fs.readFileSync(resultsFile, "utf-8"));
		stored.skills.delta.checkedAt = new Date(Date.now() - 3 * 60 * 60_000).toISOString();
		fs.writeFileSync(resultsFile, JSON.stringify(stored));
		const app = await open();
		const { page } = app;
		try {
			await answered(app);
			const line = (await page.locator(CHECKED).innerText()).trim();
			assert(line.startsWith("Last checked ") && line.endsWith(CHECK_NOW), `its time, got ${JSON.stringify(line)}`);
			await checkNow(page).click();
			await page.locator(".skill-updates-line:not(.skill-updates-checked)").first().waitFor({ timeout: 30_000 });
			await answered(app);
			assert((await page.locator(CHECKED).innerText()).trim() === line, `the same after it, ${JSON.stringify(line)}, got ${JSON.stringify(await page.locator(CHECKED).innerText())}`);
		} finally {
			await page.context().close();
		}
	});

	// Due each time, so on this computer opening the page would check.
	const nothingChecked = () => fs.writeFileSync(resultsFile, JSON.stringify({ skills: {} }));
	for (const [label, probe] of [
		["a phone", { remote: true, capability: "full" }],
		["a shared server's admin", { remote: false, capability: "full", sharedServer: true, person: { id: "22222222-2222-4222-8222-222222222222", name: "Sample Admin", admin: true } }],
		["a shared server's member", { remote: false, capability: "full", sharedServer: true, person: { id: "11111111-1111-4111-8111-111111111111", name: "Sample Member", admin: false } }],
	] as const) {
		await row(`11 ${label}: no check as the page opens, no Check now, no Browse featured`, async () => {
			nothingChecked();
			const app = await open({ probe });
			const { page, checks } = app;
			try {
				await answered(app);
				assert(checks.length === 0, `no check, got ${JSON.stringify(checks)}`);
				assert((await page.locator(CHECKED).count()) === 0 && (await page.getByRole("button", { name: CHECK_NOW, exact: true }).count()) === 0, "no Check now and no time");
				const add = page.locator(".pane-head-actions button");
				if ((await add.count()) === 0) return;
				await add.click();
				assert(!(await menuItems(page)).includes(ADD_SKILL_WAYS.featured), `no Browse featured, got ${JSON.stringify(await menuItems(page))}`);
			} finally {
				await page.context().close();
			}
		});
	}
	await row("12 on this computer, the same library then: the check, so row 11's silence was the place's", async () => {
		nothingChecked();
		const app = await open();
		const { page } = app;
		try {
			await checkedQuietly(app);
		} finally {
			await page.context().close();
		}
	});
} catch (error) {
	failed.push((error as Error).stack ?? String(error));
} finally {
	await browser?.close();
	try { standIn.close(); } catch {}
	await stopSmokeServer(server);
	if (failed.length > 0) {
		console.error(failed.join("\n"));
		console.error(`temp folder kept for inspection: ${tempRoot}`);
		process.exitCode = 1;
	} else {
		fs.rmSync(tempRoot, { recursive: true, force: true });
		console.log("skills-quiet-check-ui smoke: ok");
	}
}
