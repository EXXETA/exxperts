// Settings, Skills: Check now and Update, in the page (the check the page makes by
// itself as it opens has its own smoke, skills-quiet-check-ui, and is answered
// here with nothing). On this computer: Check now only once a skill has a repository;
// the line after a check (all up to date, updates available, a repository that
// could not be asked); Update beside a row's open button; a skill's page with
// what an update changes, the two stops (hidden characters wait at the page's
// warning, changes made here are asked about once), what changed after an
// update, an update the page checks again because the skill changed since the
// check, the lines for a skill fixed to a commit, gone from its repository,
// renamed there and added before exxperts kept its repository, and From naming
// the branch. Update all, with two or more updates; a skill's Update
// automatically switch; after a pass of Update automatically (run here, in
// this process, on the same home), the notice of what it updated and left for
// the person until it is closed, the skill's page saying it was updated
// automatically, and an open page showing it on focus, after a reconnect and
// within a minute. From a phone, and on a shared server for its admin and a
// member: no Check, Update, Update all, switch or notice and no request to any
// of the four routes, while the version, the source and what an update changed
// stay readable.
// The repositories are folders on this machine; throwaway HOME.
//
// Run: node scripts/run-smokes.mjs skills-update-page-ui

import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright";
import {
	AUTO_UPDATE_LABEL,
	CHECK_NOW,
	CLOSE_NOTICE,
	SKILL_AUTO_SKIPPED_LINES,
	SKILL_UPDATE_CHANGE_GROUPS,
	SKILL_UPDATE_HEADING,
	SKILL_UPDATE_NEW_DESCRIPTION,
	SKILL_UPDATE_NEW_INSTRUCTIONS,
	SKILL_UPDATE_RECHECKED_LINE,
	SKILL_UPDATE_SCRIPTS_LINE,
	SKILL_UPDATE_STATE_LINES,
	skillChangedHereQuestion,
	skillRefText,
	skillPageCheckFailedLine,
	skillRenamedLine,
	skillUpdateAllLine,
	skillUpdatedHeading,
	skillUpdatedNotice,
	skillsLeftForYouLine,
	skillsUpdatedAutomaticallyLine,
	skillUpdatesFailedLine,
	skillUpdatesFoundLine,
	skillUpdateVersionsLine,
	UPDATE_ALL,
	UPDATE_SKILL,
	UPDATE_SKILL_ANYWAY,
} from "../../web-ui/src/skill-source-copy.js";
import { authedFetch, freePort, smokeHomeEnv, SMOKE_AUTH_TOKEN, SMOKE_SERVER_AUTH_ENV, SMOKE_SERVER_SPAWN_TREE_OPTIONS, stopSmokeServer, waitForServer } from "./smoke-server-process.js";

function assert(condition: unknown, message: string): asserts condition {
	if (!condition) throw new Error(message);
}

{
	const executable = typeof chromium?.executablePath === "function" ? chromium.executablePath() : "";
	if (!executable || !fs.existsSync(executable)) {
		console.log("skills-update-page-ui smoke skipped (Chromium not installed)");
		process.exit(0);
	}
}

const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), "exxperts-skills-update-page-"));
// Update automatically's pass runs here, in this process, on the server's home.
Object.assign(process.env, smokeHomeEnv(tempHome, { EXXETA_SKILLS_ALLOW_LOCAL_REPO: "1" }));
for (const name of ["EXXPERTS_DATA_DIR", "EXXPERTS_STATE_HOME", "EXXPERTS_CODING_AGENT_DIR"]) delete process.env[name];
const { runSkillAutoUpdatePass } = await import("../src/skill-updates.js");
/** A pass that first sees what changed, then one 13 hours on its own clock that takes it. */
async function passTwice(): Promise<void> {
	await runSkillAutoUpdatePass({ logger: { info: () => {}, warn: () => {} } });
	await runSkillAutoUpdatePass({ now: () => new Date(Date.now() + 13 * 60 * 60_000), logger: { info: () => {}, warn: () => {} } });
}
const store = path.join(tempHome, ".exxperts", "agent", "skills");
const repo = path.join(tempHome, "repo");
const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const webServerDir = path.resolve(scriptDir, "..");
const repoRoot = path.resolve(webServerDir, "..", "..");
const port = await freePort();
const baseUrl = `http://127.0.0.1:${port}`;

function git(args: string[]): string {
	const res = spawnSync("git", ["-c", "user.email=smoke@test", "-c", "user.name=Smoke", ...args], { cwd: repo, encoding: "utf-8" });
	if (res.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${res.stderr || res.stdout}`);
	return res.stdout.trim();
}
function writeSkill(root: string, rel: string, name: string, body: string, extra = "", description = `The ${name} skill.`): void {
	fs.mkdirSync(path.join(root, rel), { recursive: true });
	fs.writeFileSync(path.join(root, rel, "SKILL.md"), `---\nname: ${name}\ndescription: ${description}\n${extra}---\n\n${body}\n`);
}
async function api(method: string, pathname: string, body?: unknown): Promise<{ status: number; body: any }> {
	const response = await authedFetch(`${baseUrl}${pathname}`, { method, ...(body === undefined ? {} : { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }) });
	const text = await response.text();
	return { status: response.status, body: text ? JSON.parse(text) : null };
}
/** A skill written straight into the store with the record given: the records an add can't make from a folder. */
function handMade(name: string, record: Record<string, unknown>): void {
	writeSkill(store, name, name, `The ${name} instructions.`);
	fs.writeFileSync(path.join(store, name, "provenance.json"), JSON.stringify({ importedAt: new Date().toISOString(), license: null, sha256: "0".repeat(64), ...record }));
}

const UPDATE_ROUTES = /\/api\/skills\/(updates\/check|updates\/seen|[^/]+\/update|[^/]+\/auto-update)$/;
const PERSON = {
	admin: { id: "22222222-2222-4222-8222-222222222222", name: "Sample Admin", admin: true },
	member: { id: "11111111-1111-4111-8111-111111111111", name: "Sample Member", admin: false },
};

/** Settings, Skills in a fresh page; `probe` stands in for the client-context answer of a phone or a shared server. Every request to the two routes is kept. */
async function openSkills(browser: Browser, probe?: Record<string, unknown>, options: { clock?: boolean } = {}): Promise<{ ctx: BrowserContext; page: Page; updateRequests: Array<{ path: string; body: string }>; beforeSkills: number }> {
	const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
	await ctx.addInitScript(() => localStorage.setItem("exxperts.first-run-guide-seen", "1"));
	const page = await ctx.newPage();
	// A clock the row moves on by itself; it runs on as a real one meanwhile.
	if (options.clock) await page.clock.install();
	const updateRequests: Array<{ path: string; body: string }> = [];
	page.on("request", (request) => {
		const pathname = new URL(request.url()).pathname;
		const quiet = !probe && pathname.endsWith("/updates/check") && JSON.parse(request.postData() ?? "{}").quiet === true;
		if (UPDATE_ROUTES.test(pathname) && !quiet) updateRequests.push({ path: pathname, body: request.postData() ?? "" });
	});
	// On this computer the page's own check is answered with nothing; from a phone or on a shared server there must be none, so it counts.
	if (!probe) await page.route("**/api/skills/updates/check", (route) => JSON.parse(route.request().postData() ?? "{}").quiet === true ? route.fulfill({ contentType: "application/json", body: JSON.stringify({ checkedAt: new Date().toISOString(), results: [] }) }) : route.fallback());
	if (probe) await page.route("**/api/remote/client-context", (route) => route.fulfill({ contentType: "application/json", body: JSON.stringify(probe) }));
	await page.goto(`${baseUrl}/auth/session?token=${SMOKE_AUTH_TOKEN}`);
	await page.waitForLoadState("networkidle");
	const dismiss = page.locator(".whats-new-close");
	if (await dismiss.count()) await dismiss.click();
	const beforeSkills = await showSkills(page);
	return { ctx, page, updateRequests, beforeSkills };
}
/** Opens Settings, Skills; answers the page's time before it opened: its minute's read comes a minute after that at the earliest. */
async function showSkills(page: Page): Promise<number> {
	await page.locator(".product-sidebar-footer button").first().click();
	await page.locator(".sidebar-config-menu button, .sidebar-config-menu a").filter({ hasText: /Settings/ }).first().click();
	await page.waitForSelector(".settings-overlay", { timeout: 10_000 });
	const before = await page.evaluate(() => Date.now());
	await page.locator(".settings-dialog-nav button").filter({ hasText: "Skills" }).first().click();
	await page.waitForSelector(".skill-table", { timeout: 10_000 });
	return before;
}
const checkButton = (page: Page) => page.getByRole("button", { name: CHECK_NOW, exact: true });
/** A line a check or Update all left, not "Last checked". */
const RESULT_LINE = ".skill-updates-line:not(.skill-updates-checked)";
const updateAllButton = (page: Page) => page.getByRole("button", { name: UPDATE_ALL, exact: true });
const autoSwitch = (page: Page) => page.locator(".skill-detail").getByRole("switch", { name: AUTO_UPDATE_LABEL });
const noticeText = async (page: Page) => ((await page.locator(".skill-auto-notice").count()) ? (await page.locator(".skill-auto-notice p").innerText()).trim() : null);
const rowUpdate = (page: Page, name: string) => page.getByRole("button", { name: `${UPDATE_SKILL} ${name}`, exact: true });
const statusLines = async (page: Page) => (await page.locator(RESULT_LINE).allInnerTexts()).map((line) => line.trim());
async function openSkillPage(page: Page, name: string): Promise<void> {
	if (await page.locator(".skill-detail").count()) await page.locator(".pane-head-back").click();
	await page.locator(".skill-table-row").filter({ has: page.locator(".skill-table-name-text").getByText(name, { exact: true }) }).click();
	await page.waitForSelector(".skill-detail", { timeout: 10_000 });
}
/** A row of the skill's facts (not of its update group), by its label. */
const factRow = (page: Page, label: string) => page.locator(".skill-detail .settings-row:not(.skill-update-group .settings-row)").filter({ has: page.locator(".settings-row-label", { hasText: new RegExp(`^${label}$`) }) });

async function waitUntilTrue(check: () => Promise<boolean>, label: string, timeoutMs = 15_000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (!(await check())) {
		assert(Date.now() < deadline, `timed out waiting until ${label}`);
		await new Promise((resolve) => setTimeout(resolve, 100));
	}
}

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

let server: ChildProcessWithoutNullStreams | null = null;
let browser: Browser | null = null;
async function startServer(): Promise<void> {
	server = spawn("npx", ["tsx", "src/index.ts"], {
		shell: process.platform === "win32",
		...SMOKE_SERVER_SPAWN_TREE_OPTIONS,
		cwd: webServerDir,
		env: smokeHomeEnv(tempHome, { PORT: String(port), ...SMOKE_SERVER_AUTH_ENV, EXXETA_HOME: repoRoot, EXXETA_SKILLS_ALLOW_LOCAL_REPO: "1" }) as NodeJS.ProcessEnv,
		stdio: ["ignore", "pipe", "pipe"],
	}) as unknown as ChildProcessWithoutNullStreams;
	await waitForServer(server, baseUrl, { tries: 100 });
}
try {
	// The repository: one skill for each thing the page shows, and a branch.
	fs.mkdirSync(repo, { recursive: true });
	git(["init", "-q", "-b", "main"]);
	writeSkill(repo, "skills/alpha", "alpha", "Alpha, first.", 'version: "1.0"\n');
	fs.writeFileSync(path.join(repo, "skills", "alpha", "notes.md"), "first notes\n");
	fs.writeFileSync(path.join(repo, "skills", "alpha", "old.md"), "old\n");
	for (const name of ["beta", "gamma", "delta", "eps", "zeta"]) writeSkill(repo, `skills/${name}`, name, `The ${name} instructions.`);
	git(["add", "-A"]);
	git(["commit", "-q", "-m", "first"]);
	const first = git(["rev-parse", "HEAD"]);
	git(["branch", "feature"]);

	await startServer();
	assert((await api("POST", "/api/skills", { id: "by-hand", displayName: "by-hand", description: "Written here", instructions: "Do it by hand." })).status === 201, "a skill written here");
	browser = await chromium.launch();

	await row("1 no Check now while no skill has a repository", async () => {
		const { ctx, page } = await openSkills(browser!);
		assert(await page.locator(".pane-head-actions").getByRole("button", { name: /Add skill/ }).isVisible(), "Add skill is there");
		assert((await checkButton(page).count()) === 0, "no Check now without a skill from a repository");
		await ctx.close();
	});

	// Skills from the repository, and the records an add can't make from a folder.
	const scan = await api("POST", "/api/skills/repo/scan", { source: repo });
	assert(scan.status === 200, `the scan works, got ${scan.status} ${JSON.stringify(scan.body)}`);
	for (const name of ["alpha", "beta", "gamma", "delta", "eps", "zeta"]) {
		const added = await api("POST", "/api/skills/repo/import", { token: scan.body.token, path: `skills/${name}` });
		assert(added.status === 201, `${name} added, got ${added.status} ${JSON.stringify(added.body)}`);
	}
	handMade("rho", { source: `${repo}#${first}`, repository: { address: repo, ref: first, refKind: "commit", path: "skills/rho", commit: first, filesSha256: "" } });
	handMade("tau", { source: "https://github.com/team/skills" });

	const { ctx: desk, page, updateRequests } = await openSkills(browser);

	await row("2 Check now above the list, not in the page's top, and all up to date", async () => {
		assert(await page.locator(".skill-updates-checked").getByRole("button", { name: CHECK_NOW, exact: true }).isVisible(), "Check now sits in the line above the list");
		const top = (await page.locator(".pane-head-actions button").allInnerTexts()).map((name) => name.trim());
		assert(JSON.stringify(top) === JSON.stringify(["Add skill"]), `only Add skill in the page's top, got ${JSON.stringify(top)}`);
		assert((await page.locator(RESULT_LINE).count()) === 0 && (await page.locator(".skill-updates-checked").innerText()).trim() === `Not checked yet. ${CHECK_NOW}`, "no line and no time before the first check");
		await checkButton(page).click();
		await page.locator(RESULT_LINE).first().waitFor({ timeout: 30_000 });
		const lines = await statusLines(page);
		// tau's version in its repository isn't known, so it is named, not counted as up to date.
		assert(JSON.stringify(lines) === JSON.stringify([skillUpdatesFoundLine(0, ["tau"])]), `the line after the check, got ${JSON.stringify(lines)}`);
		assert(lines[0] !== skillUpdatesFoundLine(0), "and the line doesn't say all are up to date");
		assert((await page.locator(".skill-row-update button").count()) === 0, "no Update on any row");
	});

	// The repository moves, a skill is changed here, and one repository can't be found.
	writeSkill(repo, "skills/alpha", "alpha", "Alpha, second.", 'version: "2.0"\n');
	fs.writeFileSync(path.join(repo, "skills", "alpha", "notes.md"), "second notes\n");
	fs.rmSync(path.join(repo, "skills", "alpha", "old.md"));
	fs.writeFileSync(path.join(repo, "skills", "alpha", "run.py"), "print('run')\n");
	writeSkill(repo, "skills/beta", "beta", "The beta instructions,\u200b second.", "", "The beta skill, second.");
	writeSkill(repo, "skills/gamma", "gamma", "The gamma instructions, second.");
	writeSkill(repo, "skills/zeta", "zeta", "The zeta instructions, second.");
	fs.rmSync(path.join(repo, "skills", "delta"), { recursive: true });
	writeSkill(repo, "skills/eps", "eps-two", "The eps instructions.");
	git(["add", "-A"]);
	git(["commit", "-q", "-m", "second"]);
	const gammaManifest = path.join(store, "gamma", "SKILL.md");
	fs.writeFileSync(gammaManifest, fs.readFileSync(gammaManifest, "utf-8").replace("The gamma instructions.", "The gamma instructions, edited here."));
	handMade("sigma", { source: path.join(tempHome, "no-such-repo"), repository: { address: path.join(tempHome, "no-such-repo"), refKind: "default", path: "skills/sigma", commit: first, filesSha256: "" } });

	await row("3 updates available, a repository that could not be asked, and Update beside the rows that have one", async () => {
		await checkButton(page).click();
		await page.locator(RESULT_LINE).filter({ hasText: skillUpdatesFoundLine(4) }).waitFor({ timeout: 30_000 });
		const sigma = ((await api("GET", "/api/skills")).body as any[]).find((skill) => skill.name === "sigma");
		const lines = await statusLines(page);
		assert(JSON.stringify(lines) === JSON.stringify([skillUpdatesFoundLine(4), skillUpdatesFailedLine(sigma.update.failure, ["sigma"])]), `the lines after the check, got ${JSON.stringify(lines)}`);
		for (const name of ["alpha", "beta", "gamma", "zeta"]) {
			const line = page.locator(".skill-row-line").filter({ has: rowUpdate(page, name) });
			assert((await line.count()) === 1 && (await line.locator(".skill-table-row").innerText()).startsWith(name), `Update sits beside ${name}'s row`);
		}
		assert((await page.locator(".skill-row-update button").count()) === 4, "Update only on the four rows with an update");
		// One action per row on the right edge: Update in the chevron's place, the chevron only without one.
		const chevronEnds = await page.locator(".skill-table-chevron").evaluateAll((chevrons) => chevrons.filter((c) => c.getClientRects().length > 0).map((c) => Math.round(c.getBoundingClientRect().right)));
		assert(chevronEnds.length > 0 && new Set(chevronEnds).size === 1, `every chevron shown ends at the same place, got ${JSON.stringify(chevronEnds)}`);
		for (const name of ["alpha", "beta", "gamma", "zeta"]) {
			const shownChevron = await page.locator(".skill-row-line").filter({ has: rowUpdate(page, name) }).locator(".skill-table-chevron").evaluateAll((chevrons) => chevrons.filter((c) => c.getClientRects().length > 0).length);
			assert(shownChevron === 0, `${name} shows Update instead of its chevron`);
			const update = (await rowUpdate(page, name).boundingBox())!;
			assert(Math.abs(update.x + update.width - chevronEnds[0]!) <= 2 , `${name}'s Update ends where the chevrons do, got ${update.x + update.width} and ${chevronEnds[0]}`);
		}
	});

	await row("4 a skill's page says what an update changes, and Update installs it and says what changed", async () => {
		await openSkillPage(page, "alpha");
		const group = page.locator(".skill-update-group");
		try {
			await group.waitFor({ timeout: 10_000 });
		} catch {
			throw new Error(`alpha's page has no update group; it shows: ${await page.locator(".skill-detail").innerText()}`);
		}
		assert((await group.locator(".settings-group-kicker").innerText()).trim() === SKILL_UPDATE_HEADING, "the group's heading");
		assert((await group.locator(".group-head-line").innerText()).trim() === SKILL_UPDATE_SCRIPTS_LINE, "the line says its scripts change too");
		const facts = async () => Object.fromEntries(await group.locator(".settings-row").evaluateAll((rows) => rows.map((r) => [r.querySelector(".settings-row-label")?.textContent?.trim(), r.querySelector(".settings-row-value")?.textContent?.trim()])));
		const wanted = { Version: skillUpdateVersionsLine("1.0", "2.0"), [SKILL_UPDATE_CHANGE_GROUPS.added]: "run.py", [SKILL_UPDATE_CHANGE_GROUPS.removed]: "old.md", [SKILL_UPDATE_CHANGE_GROUPS.changed]: "SKILL.md, notes.md" };
		assert(JSON.stringify(await facts()) === JSON.stringify(wanted), `what it changes: ${JSON.stringify(wanted)}, got ${JSON.stringify(await facts())}`);
		await group.getByRole("button", { name: UPDATE_SKILL, exact: true }).click();
		await page.locator("p.cli-note[role=status]").filter({ hasText: skillUpdatedNotice("alpha") }).waitFor({ timeout: 15_000 });
		await page.locator(".skill-update-group .settings-group-kicker").filter({ hasText: /^Updated/ }).waitFor({ timeout: 10_000 });
		assert(JSON.stringify(await facts()) === JSON.stringify(wanted), `after the update, what changed, got ${JSON.stringify(await facts())}`);
		assert((await page.locator(".skill-update-group .group-head-line").innerText()).trim() === SKILL_UPDATE_STATE_LINES.current, "and that it is up to date");
		assert((await factRow(page, "Version").locator(".settings-row-value").innerText()).trim() === "2.0", "its version is the new one");
	});

	await row("5 hidden characters stop at the skill's page, where Update anyway installs it", async () => {
		await page.locator(".pane-head-back").click();
		const before = updateRequests.length;
		await rowUpdate(page, "beta").click();
		await page.waitForSelector(".skill-detail", { timeout: 10_000 });
		assert(await page.locator(".skill-update-group .skill-review-banner.danger").isVisible(), "the add's warning shows");
		assert((await page.locator(".skill-update-group").innerText()).includes("second."), `the new version's instructions show where the warning asks to review them, got ${await page.locator(".skill-update-group").innerText()}`);
		const labels = (await page.locator(".skill-update-group .skill-review-body-label").allInnerTexts()).map((label) => label.trim());
		assert(JSON.stringify(labels) === JSON.stringify([SKILL_UPDATE_NEW_DESCRIPTION, SKILL_UPDATE_NEW_INSTRUCTIONS]), `the new description and instructions under their own labels, got ${JSON.stringify(labels)}`);
		assert(updateRequests.length === before, "nothing was sent");
		await page.locator(".skill-update-group").getByRole("button", { name: UPDATE_SKILL_ANYWAY, exact: true }).click();
		await page.locator("p.cli-note[role=status]").filter({ hasText: skillUpdatedNotice("beta") }).waitFor({ timeout: 15_000 });
		assert(JSON.parse(updateRequests.at(-1)!.body).confirm?.hiddenCharacters === true, "the yes is sent with it");
	});

	await row("6 a skill changed here asks once before its changes are replaced", async () => {
		await page.locator(".pane-head-back").click();
		const before = updateRequests.length;
		const question = skillChangedHereQuestion("gamma");
		await rowUpdate(page, "gamma").click();
		const dialog = page.locator(".confirm-dialog-backdrop");
		await dialog.waitFor({ timeout: 5_000 });
		assert((await dialog.innerText()).includes(question.title) && (await dialog.innerText()).includes(question.body), `the question, got ${await dialog.innerText()}`);
		await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
		await dialog.waitFor({ state: "detached", timeout: 5_000 });
		assert(updateRequests.length === before && fs.readFileSync(gammaManifest, "utf-8").includes("edited here"), "Cancel sends nothing and keeps the change");
		await rowUpdate(page, "gamma").click();
		await dialog.waitFor({ timeout: 5_000 });
		await dialog.getByRole("button", { name: question.confirmLabel, exact: true }).click();
		await page.locator("p.cli-note[role=status]").filter({ hasText: skillUpdatedNotice("gamma") }).waitFor({ timeout: 15_000 });
		assert(!fs.readFileSync(gammaManifest, "utf-8").includes("edited here"), "the new version replaced the change");
	});

	await row("6b no Update all while only one skill has an update", async () => {
		await page.locator(".pane-head-back").click().catch(() => {});
		const waiting = ((await api("GET", "/api/skills")).body as any[]).filter((skill) => skill.update?.state === "available");
		assert(waiting.length === 1, `one skill has an update, got ${waiting.map((skill) => skill.name)}`);
		assert((await rowUpdate(page, waiting[0].name).count()) === 1 && (await updateAllButton(page).count()) === 0, "its row has Update, and there is no Update all");
	});

	await row("7 a skill changed since the check is checked again, and nothing is written", async () => {
		assert((await api("PUT", "/api/skills/zeta", { displayName: "zeta", description: "The zeta skill.", instructions: "Edited in the app." })).status === 200, "zeta edited");
		const before = updateRequests.length;
		await rowUpdate(page, "zeta").click();
		await page.locator(".checkpoint-proposal-error").filter({ hasText: SKILL_UPDATE_RECHECKED_LINE }).waitFor({ timeout: 15_000 });
		const sent = updateRequests.slice(before);
		assert(sent.length === 2 && sent[0].path === "/api/skills/zeta/update" && sent[1].path === "/api/skills/updates/check" && JSON.stringify(JSON.parse(sent[1].body).names) === JSON.stringify(["zeta"]), `the update, then a check of zeta, got ${JSON.stringify(sent)}`);
		assert(fs.readFileSync(path.join(store, "zeta", "SKILL.md"), "utf-8").includes("Edited in the app."), "zeta keeps its edit");
	});

	await row("8 the lines for a skill fixed to a commit, gone, renamed, added before this change, and From naming the branch", async () => {
		for (const [name, line] of [["rho", SKILL_UPDATE_STATE_LINES.pinned], ["delta", SKILL_UPDATE_STATE_LINES.gone], ["eps", skillRenamedLine("eps-two", true)], ["tau", SKILL_UPDATE_STATE_LINES.untracked]] as const) {
			await openSkillPage(page, name);
			const shown = (await page.locator(".skill-update-group .skill-update-state").innerText()).trim();
			assert(shown === line, `${name}'s page: ${line}, got ${shown}`);
		}
		// A branch of a folder on this computer can't be added or checked, so its record is written here, after the checks.
		handMade("omega", { source: repo, repository: { address: repo, ref: "feature", refKind: "branch", path: "skills/omega", commit: first, filesSha256: "" } });
		const fresh = await openSkills(browser!);
		try {
			await openSkillPage(fresh.page, "omega");
			const from = (await factRow(fresh.page, "From").locator(".settings-row-value").innerText()).trim();
			assert(from === `${repo}, ${skillRefText("branch", "feature")}`, `From names the branch, got ${from}`);
		} finally {
			await fresh.ctx.close();
			fs.rmSync(path.join(store, "omega"), { recursive: true, force: true });
		}
		await openSkillPage(page, "sigma");
		const sigma = ((await api("GET", "/api/skills")).body as any[]).find((skill) => skill.name === "sigma");
		assert((await page.locator(".skill-update-group .skill-update-state").innerText()).trim() === skillPageCheckFailedLine(sigma.update.failure, "sigma"), "a repository that could not be asked says so on the skill's page");
	});
	await desk.close();

	await row("9 the page says when it last checked", async () => {
		const { ctx, page: again } = await openSkills(browser!);
		const line = (await again.locator(".skill-updates-checked").innerText()).trim();
		const unchecked = ((await api("GET", "/api/skills")).body as any[]).filter((skill) => skill.repository && skill.repository.refKind !== "commit" && !skill.update?.checkedAt).map((skill) => `${skill.name} ${JSON.stringify(skill.update ?? null)}`);
		assert(line.startsWith("Last checked ") && line.endsWith(CHECK_NOW) && (await statusLines(again)).length === 0, `the last check is named, with Check now after it, got ${JSON.stringify(line)}; never checked: ${JSON.stringify(unchecked)}`);
		await ctx.close();
	});

	// A second repository, for Update all and Update automatically.
	const repo2 = path.join(tempHome, "repo2");
	const git2 = (args: string[]) => spawnSync("git", ["-c", "user.email=smoke@test", "-c", "user.name=Smoke", ...args], { cwd: repo2, encoding: "utf-8" });
	fs.mkdirSync(repo2, { recursive: true });
	git2(["init", "-q", "-b", "main"]);
	const SECOND = ["ua1", "ua2", "ua3", "ua4", "ua5", "au1", "au2", "au3"];
	for (const name of SECOND) writeSkill(repo2, `skills/${name}`, name, `The ${name} instructions.`);
	const commit2 = (message: string) => {
		git2(["add", "-A"]);
		assert(git2(["commit", "-q", "-m", message]).status === 0, `commit ${message}`);
	};
	commit2("first");
	const scan2 = await api("POST", "/api/skills/repo/scan", { source: repo2 });
	for (const name of SECOND) assert((await api("POST", "/api/skills/repo/import", { token: scan2.body.token, path: `skills/${name}` })).status === 201, `${name} added`);

	await row("11 Update all: shown with two or more updates; each that needs no yes updates in turn, one that stops keeps its Update, a refused one is checked again, and the line names them", async () => {
		for (const name of ["ua1", "ua2", "ua3", "ua4", "ua5"]) writeSkill(repo2, `skills/${name}`, name, `The ${name} instructions, second.`);
		commit2("second");
		const ua3 = path.join(store, "ua3", "SKILL.md");
		fs.writeFileSync(ua3, fs.readFileSync(ua3, "utf-8").replace("instructions.", "instructions, changed here."));
		const { ctx, page: all, updateRequests } = await openSkills(browser!);
		try {
			await checkButton(all).click();
			await all.locator(RESULT_LINE).filter({ hasText: /available/ }).waitFor({ timeout: 30_000 });
			assert(await all.locator(".skill-updates-bar").getByRole("button", { name: UPDATE_ALL, exact: true }).isVisible(), "Update all sits at the end of the line that says what the check found");
			assert((await all.locator(".pane-head-actions").getByRole("button", { name: UPDATE_ALL, exact: true }).count()) === 0, "and not in the page's own buttons");
			// ua4 is edited after the page's check: its Update is refused, and it is checked again.
			assert((await api("PUT", "/api/skills/ua4", { displayName: "ua4", description: "The ua4 skill.", instructions: "Edited in the app." })).status === 200, "ua4 edited");
			// ua5 is updated in another window after the page's check: its Update is refused, it is checked again, and the line sends no one to an Update it no longer has.
			const ua5 = (await api("GET", "/api/skills/ua5")).body;
			assert((await api("POST", "/api/skills/ua5/update", { candidate: ua5.update.candidate.id, installedFilesSha256: ua5.update.installedFilesSha256 })).status === 200, "ua5 updated in another window");
			const before = updateRequests.length;
			await updateAllButton(all).click();
			// ua3 and zeta were changed on this computer, so they wait for the person; ua4 and ua5 failed.
			const wanted = skillUpdateAllLine(2, [{ name: "ua3", why: "waits", hasUpdate: true }, { name: "ua4", why: "failed", hasUpdate: true }, { name: "ua5", why: "failed", hasUpdate: false }, { name: "zeta", why: "waits", hasUpdate: true }]);
			assert(wanted === "Updated 2 skills. “ua4” and “ua5” didn't update. Use the Update beside “ua4” to try again. “ua3” and “zeta” are waiting for you. Use the Update beside each to see why.", `a failed one is sent to try again, a waiting one to see why, and only the ones with an Update are sent anywhere, got ${wanted}`);
			assert(skillUpdateAllLine(12, [{ name: "internal-comms", why: "waits", hasUpdate: true }]) === "Updated 12 skills. “internal-comms” is waiting for you. Use its Update to see why.", "one that waits alone is told to see why");
			assert(skillUpdateAllLine(12, [{ name: "internal-comms", why: "failed", hasUpdate: true }]) === "Updated 12 skills. “internal-comms” didn't update. Use its Update to try again.", "one that failed alone is told to try again");
			assert(skillUpdateAllLine(0, [{ name: "internal-comms", why: "waits", hasUpdate: false }]) === "“internal-comms” didn't update.", "one that waited but lost its Update by then no longer waits");
			try {
				await all.locator(RESULT_LINE).filter({ hasText: wanted }).waitFor({ timeout: 30_000 });
			} catch {
				throw new Error(`the line after Update all: ${wanted}, got ${JSON.stringify(await statusLines(all))}`);
			}
			const sent = updateRequests.slice(before).map((request) => `${request.path} ${request.path.endsWith("/check") ? JSON.parse(request.body).names : ""}`.trim());
			assert(JSON.stringify(sent) === JSON.stringify(["/api/skills/ua1/update", "/api/skills/ua2/update", "/api/skills/ua4/update", "/api/skills/updates/check ua4", "/api/skills/ua5/update", "/api/skills/updates/check ua5"]), `each in turn, never the ones that stop, and ua4 checked again, got ${JSON.stringify(sent)}`);
			assert(updateRequests.slice(before).every((request) => !request.body.includes("confirm") || JSON.stringify(JSON.parse(request.body).confirm ?? {}) === "{}"), "never with a yes");
			assert(fs.readFileSync(path.join(store, "ua1", "SKILL.md"), "utf-8").includes("second") && fs.readFileSync(path.join(store, "ua2", "SKILL.md"), "utf-8").includes("second"), "ua1 and ua2 have the new version");
			assert(fs.readFileSync(ua3, "utf-8").includes("changed here") && fs.readFileSync(path.join(store, "ua4", "SKILL.md"), "utf-8").includes("Edited in the app."), "ua3 and ua4 are as they were");
			for (const name of ["ua3", "ua4", "zeta"]) assert((await rowUpdate(all, name).count()) === 1, `${name} keeps its own Update`);
			assert((await rowUpdate(all, "ua5").count()) === 0, "ua5 has no Update, so the line doesn't send the person to one");
			await rowUpdate(all, "ua3").click();
			await all.locator(".confirm-dialog-backdrop").waitFor({ timeout: 5_000 });
			await all.locator(".confirm-dialog-backdrop").getByRole("button", { name: "Cancel", exact: true }).click();
		} finally {
			await ctx.close();
		}
	});

	await row("12 a skill's page has Update automatically, off until turned on, saved on its click; none for a skill fixed to a commit or whose version isn't known", async () => {
		const { ctx, page: sw, updateRequests } = await openSkills(browser!);
		try {
			await openSkillPage(sw, "au1");
			assert((await autoSwitch(sw).count()) === 1 && !(await autoSwitch(sw).isChecked()), "the switch is there, off");
			await autoSwitch(sw).click();
			await waitUntilTrue(async () => (await api("GET", "/api/skills/au1")).body?.repository?.autoUpdate === true, "au1's switch is saved");
			assert(await autoSwitch(sw).isChecked(), "and shows on");
			assert(updateRequests.some((request) => request.path === "/api/skills/au1/auto-update" && JSON.parse(request.body).on === true), "saved with its click");
			const saved = async () => (await api("GET", "/api/skills/au1")).body?.repository?.autoUpdate;
			const settled = () => waitUntilTrue(async () => !(await autoSwitch(sw).isDisabled()), "the switch's save settles");
			const problem = sw.locator(".skill-auto-update [role=alert]");
			// By keyboard: the keyboard stays on the switch through its save.
			await settled();
			await autoSwitch(sw).focus();
			await sw.keyboard.press("Space");
			await waitUntilTrue(async () => (await saved()) === false, "au1's switch is saved off");
			await settled();
			assert(await autoSwitch(sw).evaluate((input) => input === document.activeElement), "the keyboard is back on the switch after its save");
			// A save whose answer is lost after it was made: the switch shows what was saved, and no failure.
			const route = "**/api/skills/au1/auto-update";
			await sw.route(route, async (request) => {
				await request.fetch();
				await request.abort();
			});
			await autoSwitch(sw).click();
			await waitUntilTrue(async () => (await saved()) === true, "the lost answer's save was made");
			await settled();
			assert((await autoSwitch(sw).isChecked()) && (await problem.count()) === 0, `a lost answer: the switch shows on, with no failure line, got ${await autoSwitch(sw).isChecked()} ${await problem.allInnerTexts()}`);
			// A save that never arrives: the switch shows the place it has, and says so.
			await sw.unroute(route);
			await sw.route(route, (request) => request.abort());
			await autoSwitch(sw).click();
			await problem.waitFor({ timeout: 10_000 });
			await settled();
			assert((await autoSwitch(sw).isChecked()) && (await saved()) === true, "a save that never arrived: still on, here and on the server");
			await sw.unroute(route);
			// Reads of the skill whose answers the row holds until it lets them go: the server answers at once.
			const detail = "**/api/skills/au1";
			let holdNext = false;
			let releaseRead: (() => void) | null = null;
			await sw.route(detail, async (request) => {
				if (request.request().method() !== "GET" || !holdNext) return request.continue();
				holdNext = false;
				const response = await request.fetch();
				await new Promise<void>((resolve) => {
					releaseRead = resolve;
				});
				await request.fulfill({ response });
			});
			let reads = 0;
			sw.on("response", (response) => {
				if (new URL(response.url()).pathname === "/api/skills/au1" && response.request().method() === "GET") reads += 1;
			});
			const letHeldReadLand = async (readsBefore: number) => {
				// Another read has reached the page first; the held one lands last.
				await waitUntilTrue(async () => reads > readsBefore, "a newer read of the skill lands");
				releaseRead!();
				releaseRead = null;
				await waitUntilTrue(async () => reads > readsBefore + 1, "the held read lands");
				await settled();
				await sw.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
			};
			// Two saves in a row, the first one's read held: the switch ends where the second save put it.
			holdNext = true;
			await autoSwitch(sw).click();
			await waitUntilTrue(async () => (await saved()) === false && releaseRead !== null, "the first save, off, and its read held");
			const beforeSecond = reads;
			await autoSwitch(sw).click();
			await waitUntilTrue(async () => (await saved()) === true, "the second save, on");
			await letHeldReadLand(beforeSecond);
			assert(await autoSwitch(sw).isChecked(), "after the first save's read lands, the switch still shows the second save's on");
			// A read the window's focus starts while a save is on its way, held: the switch ends where the save put it.
			let releaseSave: (() => void) | null = null;
			await sw.route(route, async (request) => {
				await new Promise<void>((resolve) => {
					releaseSave = resolve;
				});
				await request.continue();
			});
			await autoSwitch(sw).click();
			await waitUntilTrue(async () => releaseSave !== null, "the save, off, is on its way");
			holdNext = true;
			await sw.evaluate(() => window.dispatchEvent(new Event("focus")));
			await waitUntilTrue(async () => releaseRead !== null, "the focus read, still on, is held");
			const beforeSave = reads;
			releaseSave!();
			await waitUntilTrue(async () => (await saved()) === false, "the save is made");
			await letHeldReadLand(beforeSave);
			assert(!(await autoSwitch(sw).isChecked()), "after the focus read lands, the switch still shows the save's off");
			await sw.unroute(route);
			await sw.unroute(detail);
			await autoSwitch(sw).click();
			await waitUntilTrue(async () => (await saved()) === true, "au1 on again for the rows after");
			await settled();
			for (const name of ["rho", "tau"]) {
				await openSkillPage(sw, name);
				assert((await autoSwitch(sw).count()) === 0, `no switch on ${name}'s page`);
			}
		} finally {
			await ctx.close();
		}
	});

	await row("13 after a pass, the notice names what it updated and left until it is closed, closing sends what it showed and stays closed, and the skill's page says it was updated automatically", async () => {
		for (const name of ["au2", "au3"]) assert((await api("PUT", `/api/skills/${name}/auto-update`, { on: true })).status === 200, `${name} on`);
		writeSkill(repo2, "skills/au1", "au1", "The au1 instructions, second.");
		writeSkill(repo2, "skills/au2", "au2", "The au2 instructions, second.");
		writeSkill(repo2, "skills/au3", "au3", "The au3 instructions,\u200b second.");
		commit2("auto second");
		await passTwice();
		const { ctx, page: told, updateRequests } = await openSkills(browser!);
		try {
			const views = new Map(((await api("GET", "/api/skills")).body as any[]).map((skill) => [skill.name, skill.update]));
			const showed = [{ name: "au1", updatedAt: views.get("au1")?.updated?.at }, { name: "au2", updatedAt: views.get("au2")?.updated?.at }, { name: "au3", skippedVersion: views.get("au3")?.candidate?.filesSha256 }];
			assert(showed.every((shown) => shown.updatedAt || shown.skippedVersion), `each has what the notice names, got ${JSON.stringify(showed)}`);
			const wanted = `${skillsUpdatedAutomaticallyLine(["au1", "au2"])} ${skillsLeftForYouLine(["au3"])}`;
			assert((await noticeText(told)) === wanted, `the notice: ${wanted}, got ${await noticeText(told)}`);
			await openSkillPage(told, "au1");
			const heading = (await told.locator(".skill-update-group .settings-group-kicker").innerText()).trim();
			assert(heading.startsWith(skillUpdatedHeading("", true)) && heading !== skillUpdatedHeading("", true), `the page says it was updated automatically, with its date, got ${heading}`);
			assert((await told.locator(".skill-update-group .settings-row-label").allInnerTexts()).includes(SKILL_UPDATE_CHANGE_GROUPS.changed), "with what changed");
			await openSkillPage(told, "au3");
			assert((await told.locator(".skill-update-skipped").innerText()).trim() === SKILL_AUTO_SKIPPED_LINES.hiddenCharacters, "the skipped skill's page says why");
			assert(await told.locator(".skill-update-group").getByRole("button", { name: UPDATE_SKILL_ANYWAY, exact: true }).isVisible(), "and keeps its stop");
			await told.locator(".pane-head-back").click();
			await told.locator(".skill-auto-notice").getByRole("button", { name: CLOSE_NOTICE, exact: true }).click();
			await told.locator(".skill-auto-notice").waitFor({ state: "detached", timeout: 10_000 });
			const closed = updateRequests.filter((request) => request.path === "/api/skills/updates/seen");
			assert(closed.length === 1 && JSON.stringify(JSON.parse(closed[0].body).notices) === JSON.stringify(showed), `closing sends each update's time and the left version it showed, got ${JSON.stringify(closed)}`);
		} finally {
			await ctx.close();
		}
		const again = await openSkills(browser!);
		try {
			assert((await noticeText(again.page)) === null, "it stays closed after a reload");
		} finally {
			await again.ctx.close();
		}
	});

	await row("14 an open page shows a pass's update on focus, after a reconnect and within a minute, with no repository asked", async () => {
		const { ctx, page: open, updateRequests } = await openSkills(browser!, undefined, { clock: true });
		try {
			await openSkillPage(open, "au1");
			writeSkill(repo2, "skills/au1", "au1", "The au1 instructions, third.");
			commit2("au1 third");
			await passTwice();
			await open.evaluate(() => window.dispatchEvent(new Event("focus")));
			await open.locator(".skill-update-group .settings-group-kicker").filter({ hasText: skillUpdatedHeading("", true) }).waitFor({ timeout: 10_000 });
			await waitUntilTrue(async () => (await open.locator(".skill-detail").innerText()).includes("third"), "the open skill's page shows the new version on focus");
			await open.locator(".pane-head-back").click();
			assert((await noticeText(open)) === skillsUpdatedAutomaticallyLine(["au1"]), `the list shows it, got ${await noticeText(open)}`);

			// A reconnect: the server stops, the pass runs meanwhile, and the server comes back. Settings,
			// Skills opens again first, so its minute starts here.
			await open.keyboard.press("Escape");
			await open.locator(".settings-overlay").waitFor({ state: "detached", timeout: 10_000 });
			const beforeSkills = await showSkills(open);
			writeSkill(repo2, "skills/au2", "au2", "The au2 instructions, third.");
			commit2("au2 third");
			await stopSmokeServer(server);
			await passTwice();
			await startServer();
			await waitUntilTrue(async () => (await noticeText(open)) === skillsUpdatedAutomaticallyLine(["au1", "au2"]), "the list shows au2 after the reconnect", 45_000);
			// Before the page's first minute: the reconnect's read showed it, not the minute's.
			const shownAfter = (await open.evaluate(() => Date.now())) - beforeSkills;
			assert(shownAfter < 60_000, `au2 showed ${shownAfter} ms after Skills opened, when the minute's read may have shown it`);

			// Within a minute: nothing else happens but time passing.
			writeSkill(repo2, "skills/au1", "au1", "The au1 instructions, fourth.");
			commit2("au1 fourth");
			const updatedViews = ((await api("GET", "/api/skills")).body as any[]).filter((skill) => skill.name === "au1" || skill.name === "au2");
			await api("POST", "/api/skills/updates/seen", { notices: updatedViews.map((skill) => ({ name: skill.name, updatedAt: skill.update.updated.at })) });
			await passTwice();
			await open.clock.fastForward(60_000);
			await waitUntilTrue(async () => (await noticeText(open)) === skillsUpdatedAutomaticallyLine(["au1"]), "within a minute the list shows au1's new update");
			assert(updateRequests.every((request) => request.path !== "/api/skills/updates/check"), `no repository asked, got ${JSON.stringify(updateRequests)}`);
		} finally {
			await ctx.close();
		}
	});

	await row("15 a skill never asked leaves the time of the others' last check", async () => {
		writeSkill(repo2, "skills/fresh", "fresh", "The fresh instructions.");
		commit2("fresh");
		const scan = await api("POST", "/api/skills/repo/scan", { source: repo2 });
		assert((await api("POST", "/api/skills/repo/import", { token: scan.body.token, path: "skills/fresh" })).status === 201, "fresh added");
		const { ctx, page: fresh } = await openSkills(browser!);
		try {
			const line = (await fresh.locator(".skill-updates-checked").innerText()).trim();
			assert(line.startsWith("Last checked ") && line.endsWith(CHECK_NOW), `the time while fresh was never asked, got ${JSON.stringify(line)}`);
			await checkButton(fresh).click();
			await fresh.locator(RESULT_LINE).first().waitFor({ timeout: 30_000 });
		} finally {
			await ctx.close();
		}
		const again = await openSkills(browser!);
		try {
			const line = (await again.page.locator(".skill-updates-checked").innerText()).trim();
			assert(line.startsWith("Last checked "), `and once a check asked every skill, got ${JSON.stringify(line)}`);
		} finally {
			await again.ctx.close();
		}
	});

	// A phone, and a shared server's admin and member: the facts stay, the controls and the requests go.
	for (const [label, probe] of [
		["a phone", { remote: true, capability: "full" }],
		["a shared server's admin", { remote: false, capability: "full", sharedServer: true, person: PERSON.admin }],
		["a shared server's member", { remote: false, capability: "full", sharedServer: true, person: PERSON.member }],
	] as const) {
		await row(`10 ${label}: no Check, Update, Update all, switch or notice and no request to the four routes, the version, source and what changed readable`, async () => {
			const { ctx, page: away, updateRequests: sent } = await openSkills(browser!, probe);
			try {
				assert((await checkButton(away).count()) === 0, "no Check now");
				assert((await updateAllButton(away).count()) === 0 && (await away.locator(".skill-auto-notice").count()) === 0, "no Update all and no notice");
				await openSkillPage(away, "au1");
				assert((await autoSwitch(away).count()) === 0, "no Update automatically switch");
				assert((await away.locator(".skill-update-group .settings-group-kicker").innerText()).trim().startsWith(skillUpdatedHeading("", true)), "what Update automatically changed stays readable");
				assert((await away.locator(".skill-row-update button").count()) === 0 && (await away.getByRole("button", { name: `${UPDATE_SKILL} zeta`, exact: true }).count()) === 0, "no Update on a row");
				await openSkillPage(away, "zeta");
				assert(await away.locator(".skill-update-group").filter({ hasText: SKILL_UPDATE_HEADING }).isVisible(), "what an update would change stays readable");
				assert((await away.locator(".skill-update-group button").count()) === 0, "with no Update button");
				await openSkillPage(away, "alpha");
				assert((await factRow(away, "Version").locator(".settings-row-value").innerText()).trim() === "2.0", "the version is readable");
				assert((await factRow(away, "From").locator(".settings-row-value").innerText()).trim() === repo, "the source is readable");
				await openSkillPage(away, "tau");
				assert((await away.locator(".skill-update-state").count()) === 0, "no advice to add it again from here");
				assert(sent.length === 0, `no request to the two routes, got ${JSON.stringify(sent)}`);
			} finally {
				await ctx.close();
			}
		});
	}
} catch (error) {
	failed.push((error as Error).stack ?? String(error));
} finally {
	await browser?.close();
	await stopSmokeServer(server);
	if (failed.length > 0) {
		console.error(failed.join("\n"));
		console.error(`temp folder kept for inspection: ${tempHome}`);
		process.exitCode = 1;
	} else {
		fs.rmSync(tempHome, { recursive: true, force: true });
		console.log("skills-update-page-ui smoke: ok");
	}
}
