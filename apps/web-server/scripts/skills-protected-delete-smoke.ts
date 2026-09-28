// A skill exxperts does not own (built in, shared, project) keeps the skill
// page's last row: "Delete skill", a line that says where it can be removed,
// and the Delete button disabled. The library table names its source where an
// owned skill shows its date. A remote device shows no Delete row at all.
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { authedFetch, SMOKE_AUTH_TOKEN, SMOKE_SERVER_AUTH_ENV, SMOKE_SERVER_SPAWN_TREE_OPTIONS, stopSmokeServer } from "./smoke-server-process.js";

const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), "exxperts-skills-protected-"));
process.env.HOME = tempHome;
process.env.USERPROFILE = tempHome;

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const webServerDir = path.resolve(scriptDir, "..");
const port = 24000 + Math.floor(Math.random() * 10000);
const baseUrl = `http://127.0.0.1:${port}`;

function assert(condition: unknown, message: string): asserts condition {
	if (!condition) throw new Error(message);
}

function writeSkill(dir: string, name: string, description: string): void {
	fs.mkdirSync(dir, { recursive: true });
	fs.writeFileSync(path.join(dir, "SKILL.md"), ["---", `name: ${name}`, `description: ${description}`, "---", "", "Follow these steps.", ""].join("\n"));
}

// --- The words, exactly as specified, for every tier ------------------------
const copy = await import("../../web-ui/src/skill-source-copy.js");
const expected: Record<string, [string, string]> = {
	builtin: ["It comes with exxperts, so it can't be deleted. To stop a room using it, remove it in that room's Skills settings.", "Built in"],
	shared: ["It lives in ~/.agents/skills, which other tools manage. Delete it there to remove it.", "Shared"],
	project: ["It comes with this project's folder. Remove it from .exxeta/skills there.", "This project"],
};
for (const [tier, [line, label]] of Object.entries(expected)) {
	assert(copy.protectedSkillDeleteLine(tier) === line, `${tier}: the Delete row's line, got ${JSON.stringify(copy.protectedSkillDeleteLine(tier))}`);
	assert(copy.skillTierLabel(tier) === label, `${tier}: the table's label, got ${JSON.stringify(copy.skillTierLabel(tier))}`);
}
assert(copy.protectedSkillDeleteLine("user") === null && copy.skillTierLabel("user") === null, "a skill of your own has neither");

// A machine without Chromium cannot run the browser half; the words above
// still ran.
{
	const p = typeof chromium?.executablePath === "function" ? chromium.executablePath() : "";
	if (!p || !fs.existsSync(p)) {
		console.log("skills protected-delete smoke skipped (Chromium not installed)");
		process.exit(0);
	}
}

let server: ChildProcessWithoutNullStreams | null = null;

async function waitForServer(): Promise<void> {
	for (let attempt = 0; attempt < 100; attempt += 1) {
		if (server?.exitCode != null) throw new Error(`server exited before startup with code ${server.exitCode}`);
		try {
			const res = await fetch(`${baseUrl}/healthz`);
			if (res.ok) return;
		} catch { /* not up yet */ }
		await new Promise((resolve) => setTimeout(resolve, 150));
	}
	throw new Error("server did not come up");
}

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
	await waitForServer();
	const own = await authedFetch(`${baseUrl}/api/skills`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ id: "cite-sources", displayName: "cite-sources", description: "Cites its sources", instructions: "Cite every source." }) });
	assert(own.status === 201, `writing a skill of your own should succeed, got ${own.status}`);

	const browser = await chromium.launch();
	try {
		const openSkills = async (remote: boolean) => {
			const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
			const page = await ctx.newPage();
			if (remote) {
				await page.route("**/api/remote/client-context", (route) =>
					route.fulfill({ contentType: "application/json", body: JSON.stringify({ remote: true, capability: "read-only" }) }));
			}
			await page.goto(`${baseUrl}/auth/session?token=${SMOKE_AUTH_TOKEN}`);
			await page.waitForLoadState("networkidle");
			const dismiss = page.locator(".whats-new-foot .btn-primary");
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
		assert((await sharedRow.locator(".skill-table-cell").last().innerText()).trim() === "Shared", "the table names a shared skill's source where the date would be");

		await sharedRow.click();
		await page.waitForSelector(".skill-detail", { timeout: 10000 });
		assert((await deleteRow(page).count()) === 1, "a shared skill keeps the Delete skill row");
		assert((await deleteRow(page).locator(".settings-row-sub").innerText()).trim() === expected.shared[0], "the row says where a shared skill can be removed");
		assert(await deleteRow(page).locator("button.rs-btn-danger").isDisabled(), "its Delete button is disabled");

		await page.locator(".skill-detail-back").click();
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
	} finally {
		await browser.close();
	}

	console.log("skills-protected-delete smoke: ok");
} finally {
	await stopSmokeServer(server);
	fs.rmSync(tempHome, { recursive: true, force: true });
}
