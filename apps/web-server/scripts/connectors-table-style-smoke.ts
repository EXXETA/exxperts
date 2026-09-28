// Settings, Connectors: an added connector is a row of the Added table. The
// row is a grid whose columns the table head sets, its name is a plain
// button (no native button face), and the connector's icon sits on a tile.
// Guards the base rules the table depends on: without them the rows stack,
// the name shows as a grey native button and the icons lose their tile.
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { authedFetch, SMOKE_AUTH_TOKEN, SMOKE_SERVER_AUTH_ENV, SMOKE_SERVER_SPAWN_TREE_OPTIONS, stopSmokeServer } from "./smoke-server-process.js";

const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), "exxperts-connectors-table-"));
process.env.HOME = tempHome;
process.env.USERPROFILE = tempHome;

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const webServerDir = path.resolve(scriptDir, "..");
const port = 24000 + Math.floor(Math.random() * 10000);
const baseUrl = `http://127.0.0.1:${port}`;

function assert(condition: unknown, message: string): asserts condition {
	if (!condition) throw new Error(message);
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

// A machine without Chromium cannot run a browser assertion at all; skip
// whole, the same way remote-settings-readonly-smoke does.
{
	const p = typeof chromium?.executablePath === "function" ? chromium.executablePath() : "";
	if (!p || !fs.existsSync(p)) {
		console.log("connectors table style smoke skipped (Chromium not installed)");
		process.exit(0);
	}
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
	const added = await authedFetch(`${baseUrl}/api/mcp/servers`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "canva", url: "http://127.0.0.1:9/mcp" }) });
	assert(added.ok, `adding the connector failed: ${added.status} ${await added.text()}`);

	const browser = await chromium.launch();
	try {
		const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
		const page = await ctx.newPage();
		await page.goto(`${baseUrl}/auth/session?token=${SMOKE_AUTH_TOKEN}`);
		await page.waitForLoadState("networkidle");
		const dismiss = page.locator(".whats-new-foot .btn-primary");
		if (await dismiss.count()) await dismiss.click();

		await page.locator(".product-sidebar-footer button").first().click();
		await page.locator(".sidebar-config-menu button, .sidebar-config-menu a").filter({ hasText: /Settings/ }).first().click();
		await page.waitForSelector(".settings-overlay", { timeout: 10000 });
		await page.locator(".settings-dialog-nav button").filter({ hasText: "Connectors" }).first().click();
		const row = page.locator(".settings-overlay .connector-table .connector-row").first();
		await row.waitFor({ timeout: 10000 });

		const rowStyle = await row.evaluate((el) => {
			const s = getComputedStyle(el);
			return { display: s.display, columns: s.gridTemplateColumns.split(" ").length };
		});
		assert(rowStyle.display === "grid", `the Added row is a grid, got ${rowStyle.display}`);
		assert(rowStyle.columns === 5, `the Added row has the head's five columns, got ${rowStyle.columns}`);

		const toggle = await row.locator(".connector-row-toggle").evaluate((el) => {
			const s = getComputedStyle(el);
			return { background: s.backgroundColor, borderTop: s.borderTopWidth, borderStyle: s.borderTopStyle };
		});
		assert(toggle.background === "rgba(0, 0, 0, 0)" || toggle.background === "transparent", `the name has no button face, got ${toggle.background}`);
		assert(toggle.borderStyle === "none" || toggle.borderTop === "0px", `the name has no button border, got ${toggle.borderTop} ${toggle.borderStyle}`);

		const avatar = await row.locator(".connector-avatar").evaluate((el) => {
			const s = getComputedStyle(el);
			return { radius: parseFloat(s.borderTopLeftRadius), background: s.backgroundColor, display: s.display };
		});
		assert(avatar.radius > 0, `the icon tile has a radius, got ${avatar.radius}`);
		assert(avatar.background !== "rgba(0, 0, 0, 0)" && avatar.background !== "transparent", `the icon tile has a background, got ${avatar.background}`);
		assert(avatar.display === "flex", `the icon tile centres its glyph, got ${avatar.display}`);

		// The expanded row: the detail sits under the row, at the name's edge.
		await row.locator(".connector-row-toggle").click();
		const expansion = row.locator(".connector-row-expansion");
		await expansion.waitFor({ timeout: 5000 });
		const expansionColumn = await expansion.evaluate((el) => getComputedStyle(el).gridColumnStart);
		assert(expansionColumn === "2", `the detail starts at the name's column, got ${expansionColumn}`);

		// The directory's icons keep their tile too.
		const directoryAvatar = page.locator(".settings-overlay .connector-dir-row .connector-avatar").first();
		await directoryAvatar.waitFor({ timeout: 5000 });
		const directoryRadius = await directoryAvatar.evaluate((el) => parseFloat(getComputedStyle(el).borderTopLeftRadius));
		assert(directoryRadius > 0, `a directory icon has its tile, got radius ${directoryRadius}`);
		await ctx.close();
	} finally {
		await browser.close();
	}

	console.log("connectors-table-style smoke: ok");
} finally {
	await stopSmokeServer(server);
	fs.rmSync(tempHome, { recursive: true, force: true });
}
