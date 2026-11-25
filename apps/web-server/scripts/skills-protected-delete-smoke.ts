// A skill exxperts does not own (built in, shared, project) keeps the skill
// page's last row: "Delete skill", a line that says where it can be removed,
// and the Delete button disabled. The library table names its source under
// From. A remote device shows no Delete row at all.
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { SKILL_UNREADABLE_LINE, SKILL_UNREADABLE_PAGE_LINE } from "../../web-ui/src/skill-source-copy.js";
import { authedFetch, SMOKE_AUTH_TOKEN, SMOKE_SERVER_AUTH_ENV, SMOKE_SERVER_SPAWN_TREE_OPTIONS, stopSmokeServer, freePort, waitForServer } from "./smoke-server-process.js";

const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), "exxperts-skills-protected-"));
process.env.HOME = tempHome;
process.env.USERPROFILE = tempHome;

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const webServerDir = path.resolve(scriptDir, "..");
const port = await freePort();
const baseUrl = `http://127.0.0.1:${port}`;

function assert(condition: unknown, message: string): asserts condition {
	if (!condition) throw new Error(message);
}

function writeSkill(dir: string, name: string, description: string): void {
	fs.mkdirSync(dir, { recursive: true });
	fs.writeFileSync(path.join(dir, "SKILL.md"), ["---", `name: ${name}`, `description: ${description}`, "---", "", "Follow these steps.", ""].join("\n"));
}

const SHARED_DELETE_LINE = "It lives in ~/.agents/skills, which other tools manage. Delete it there to remove it.";

// A machine without Chromium cannot run the browser half.
{
	const p = typeof chromium?.executablePath === "function" ? chromium.executablePath() : "";
	if (!p || !fs.existsSync(p)) {
		console.log("skills protected-delete smoke skipped (Chromium not installed)");
		process.exit(0);
	}
}

let server: ChildProcessWithoutNullStreams | null = null;

try {
	// A shared skill in the cross-tool folder, and one of your own.
	writeSkill(path.join(tempHome, ".agents", "skills", "brand-voice"), "brand-voice", "Writes in the company's voice");
	server = spawn("npx", ["tsx", "src/index.ts"], {
		shell: process.platform === "win32",
		...SMOKE_SERVER_SPAWN_TREE_OPTIONS,
		cwd: webServerDir,
		env: { ...process.env, HOME: tempHome, USERPROFILE: tempHome, PORT: String(port), ...SMOKE_SERVER_AUTH_ENV },
		stdio: ["ignore", "pipe", "pipe"],
	}) as unknown as ChildProcessWithoutNullStreams;
	await waitForServer(server, baseUrl, { tries: 100 });
	const own = await authedFetch(`${baseUrl}/api/skills`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ id: "cite-sources", displayName: "cite-sources", description: "Cites its sources", instructions: "Cite every source." }) });
	assert(own.status === 201, `writing a skill of your own should succeed, got ${own.status}`);

	const browser = await chromium.launch();
	try {
		const openSkills = async (remote: boolean) => {
			const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
			// A Home with no rooms: the guide has had its turn, so it leaves the gear free.
			await ctx.addInitScript(() => localStorage.setItem("exxperts.first-run-guide-seen", "1"));
			const page = await ctx.newPage();
			if (remote) {
				await page.route("**/api/remote/client-context", (route) =>
					route.fulfill({ contentType: "application/json", body: JSON.stringify({ remote: true, capability: "read-only" }) }));
			}
			await page.goto(`${baseUrl}/auth/session?token=${SMOKE_AUTH_TOKEN}`);
			await page.waitForLoadState("networkidle");
			const dismiss = page.locator(".whats-new-close");
			if (await dismiss.count()) await dismiss.click();
			await page.locator(".product-sidebar-footer button").first().click();
			await page.locator(".sidebar-config-menu button, .sidebar-config-menu a").filter({ hasText: /Settings/ }).first().click();
			await page.waitForSelector(".settings-overlay", { timeout: 10000 });
			await page.locator(".settings-dialog-nav button").filter({ hasText: "Skills" }).first().click();
			await page.waitForSelector(".skill-table", { timeout: 10000 });
			return { ctx, page };
		};
		const deleteRow = (page: import("playwright").Page) => page.locator(".skill-detail .settings-row").filter({ hasText: "Delete skill" });

		const { ctx, page } = await openSkills(false);
		const sharedRow = page.locator(".skill-table-row").filter({ hasText: "brand-voice" });
		assert((await sharedRow.locator(".skill-table-from").innerText()).trim() === "Shared", "the table's From names a shared skill's source");
		// One row pattern: no column heads, the facts under the name on its edge.
		const nameLeft = (await sharedRow.locator(".skill-table-name").boundingBox())?.x ?? NaN;
		const factsLeft = (await sharedRow.locator(".skill-table-facts").boundingBox())?.x ?? NaN;
		assert(Math.abs(nameLeft - factsLeft) <= 2, `the facts start on the name's edge (name at ${nameLeft}, facts at ${factsLeft})`);

		await sharedRow.click();
		await page.waitForSelector(".skill-detail", { timeout: 10000 });
		assert((await deleteRow(page).count()) === 1, "a shared skill keeps the Delete skill row");
		assert((await deleteRow(page).locator(".settings-row-sub").innerText()).trim() === SHARED_DELETE_LINE, "the row says where a shared skill can be removed");
		assert(await deleteRow(page).locator("button.rs-btn-danger").isDisabled(), "its Delete button is disabled");

		await page.locator(".pane-head-back").click();
		await page.locator(".skill-table-row").filter({ hasText: "cite-sources" }).click();
		await page.waitForSelector(".skill-detail", { timeout: 10000 });
		assert((await deleteRow(page).locator(".settings-row-sub").innerText()).trim() === "Removes it from your library. Rooms that use it stop using it.", "a skill of your own keeps its own line");
		assert(await deleteRow(page).locator("button.rs-btn-danger").isEnabled(), "and its Delete button works");
		// The delete question starts on Cancel: Enter there keeps the skill.
		await deleteRow(page).locator("button.rs-btn-danger").click();
		const question = page.locator(".confirm-dialog-backdrop");
		await question.waitFor({ timeout: 5000 });
		const focused = await page.evaluate(() => (document.activeElement as HTMLElement | null)?.innerText ?? "");
		assert(focused === "Cancel", `a danger question starts with the focus on Cancel, got ${JSON.stringify(focused)}`);
		await page.keyboard.press("Enter");
		await question.waitFor({ state: "detached", timeout: 5000 });
		assert((await page.locator(".skill-detail").count()) === 1, "Enter on Cancel keeps the skill and its page");
		const listed = JSON.stringify(await (await authedFetch(`${baseUrl}/api/skills`)).json());
		assert(listed.includes("\"cite-sources\""), "the skill is still in the library");
		await ctx.close();

		// A remote device keeps its read-only page: no Delete row at all.
		const remote = await openSkills(true);
		await remote.page.locator(".skill-table-row").filter({ hasText: "brand-voice" }).click();
		await remote.page.waitForSelector(".skill-detail", { timeout: 10000 });
		assert((await deleteRow(remote.page).count()) === 0, "a remote device shows no Delete row");
		await remote.ctx.close();

		// A skill whose SKILL.md is a link exxperts doesn't follow, in the shared folder (into
		// the app's own data) and in your own library (any link): listed with the line that
		// it can't be read and no instructions, never left out. Yours can still be deleted,
		// and deleting it leaves the file the link led to.
		let linksAllowed = true;
		const elsewhere = path.join(tempHome, ".exxperts", "kept-elsewhere");
		writeSkill(elsewhere, "linked-elsewhere", "Lives elsewhere");
		for (const dir of [path.join(tempHome, ".agents", "skills", "shared-linked"), path.join(tempHome, ".exxperts", "agent", "skills", "own-linked")]) {
			fs.mkdirSync(dir, { recursive: true });
			try {
				fs.symlinkSync(path.join(elsewhere, "SKILL.md"), path.join(dir, "SKILL.md"));
			} catch {
				linksAllowed = false;
				console.log("SKIPPED: the linked SKILL.md rows (this system does not allow links here)");
				break;
			}
		}
		if (linksAllowed) {
			const linked = await openSkills(false);
			for (const name of ["shared-linked", "own-linked"]) {
				const row = linked.page.locator(".skill-table-row").filter({ hasText: name });
				assert((await row.count()) === 1, `a skill whose SKILL.md is a link is listed: ${name}`);
				assert((await row.locator(".skill-table-problem").innerText()).trim() === SKILL_UNREADABLE_LINE, `its row says it can't be opened: ${name}`);
			}
			await linked.page.locator(".skill-table-row").filter({ hasText: "shared-linked" }).click();
			await linked.page.waitForSelector(".skill-detail", { timeout: 10000 });
			assert((await linked.page.locator(".skill-detail .pane-lead").innerText()).trim() === SKILL_UNREADABLE_PAGE_LINE, "its page says it can't be read and what to do, on the line under its title");
			assert((await linked.page.locator(".skill-detail").innerText()).includes("Instructions") === false, "its page shows no instructions");
			await linked.page.locator(".pane-head-back").click();
			await linked.page.locator(".skill-table-row").filter({ hasText: "own-linked" }).click();
			await linked.page.waitForSelector(".skill-detail", { timeout: 10000 });
			await deleteRow(linked.page).locator("button.rs-btn-danger").click();
			await linked.page.locator(".confirm-dialog-backdrop button.rs-btn-danger").click();
			await linked.page.waitForSelector(".skill-table", { timeout: 10000 });
			const after = (await (await authedFetch(`${baseUrl}/api/skills`)).json()) as Array<{ name: string }>;
			assert(!after.some((skill) => skill.name === "own-linked"), "a skill of your own whose SKILL.md is a link can be deleted");
			assert(fs.existsSync(path.join(elsewhere, "SKILL.md")), "deleting it leaves the file its link led to");
			await linked.ctx.close();
		}
	} finally {
		await browser.close();
	}

	console.log("skills-protected-delete smoke: ok");
} finally {
	await stopSmokeServer(server);
	fs.rmSync(tempHome, { recursive: true, force: true });
}
