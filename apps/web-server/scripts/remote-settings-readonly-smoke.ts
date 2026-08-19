// Remote settings render read-only: on a device whose client-context probe
// says remote, every settings section must show its facts plus one honest
// line, and none of the local-only controls (sign-in, add provider, gateway
// edit, web search saves, connector admin, skill upload, remote admin) may
// render. The server's remote route policy is the truth this rendering
// mirrors; here the probe response is intercepted in the page so the real
// tunnel is not needed. Loopback rendering is asserted too, so the gate can
// never fail closed on the computer itself.
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { SMOKE_AUTH_TOKEN, SMOKE_SERVER_AUTH_ENV, SMOKE_SERVER_SPAWN_TREE_OPTIONS, stopSmokeServer } from "./smoke-server-process.js";

const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), "exxperts-remote-readonly-"));
process.env.HOME = tempHome;
process.env.USERPROFILE = tempHome;

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const webServerDir = path.resolve(scriptDir, "..");
const port = 24000 + Math.floor(Math.random() * 10000);
const baseUrl = `http://127.0.0.1:${port}`;

function assert(condition: unknown, message: string): asserts condition {
	if (!condition) throw new Error(message);
}

// A signed-in profile so the AI setup section renders rows, not the empty card.
const agentDir = path.join(tempHome, ".exxperts", "agent");
fs.mkdirSync(agentDir, { recursive: true, mode: 0o700 });
fs.writeFileSync(path.join(agentDir, "auth.json"), JSON.stringify({ "openai-codex": { type: "api_key", key: "sk-smoke" } }), { mode: 0o600 });

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

const SECTIONS: Array<{ tab: string; honest: string; absent: string[] }> = [
	{
		tab: "AI setup",
		honest: "Providers and gateways are set up on the computer itself.",
		absent: [".ai-profile-signin", ".ai-profile-menu-btn", ".add-provider-toggle"],
	},
	{
		tab: "Web search",
		honest: "Web search is set up on the computer itself.",
		absent: [".web-search-native input", ".web-search-native button", ".web-search-fallback select"],
	},
	{
		tab: "Connectors",
		honest: "Connectors are set up and signed in on the computer itself.",
		absent: [".connector-row-actions button", ".connector-directory input"],
	},
	{
		tab: "Skills",
		honest: "Skills are uploaded and edited on the computer itself.",
		absent: [".skill-library-controls button"],
	},
];

// Environments without an installed Chromium (the Linux Docker gate sets
// EXXETA_SKIP_BROWSER_INSTALL=1) cannot run a browser assertion at all; skip
// whole, the same way fetch-url-extraction-smoke does.
{
	const p = typeof chromium?.executablePath === "function" ? chromium.executablePath() : "";
	if (!p || !fs.existsSync(p)) {
		console.log("remote settings read-only smoke skipped (Chromium not installed)");
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
	}) as ChildProcessWithoutNullStreams;
	await waitForServer();

	const browser = await chromium.launch();
	try {
		// Remote read-only device: the probe is intercepted in the page.
		const remoteCtx = await browser.newContext({ viewport: { width: 393, height: 852 } });
		const page = await remoteCtx.newPage();
		await page.route("**/api/remote/client-context", (route) =>
			route.fulfill({ contentType: "application/json", body: JSON.stringify({ remote: true, capability: "read-only" }) }));
		await page.goto(`${baseUrl}/auth/session?token=${SMOKE_AUTH_TOKEN}`);
		await page.waitForLoadState("networkidle");
		const dismiss = page.locator(".whats-new-foot .btn-primary");
		if (await dismiss.count()) await dismiss.click();
		await page.locator(".product-sidebar-footer button").first().click();
		await page.locator(".sidebar-config-menu button, .sidebar-config-menu a").filter({ hasText: /Settings/ }).first().click();
		await page.waitForSelector(".settings-overlay", { timeout: 10000 });

		// The Remote access section is not offered to remote devices at all
		// (the shell drops it); its in-page gate is unreachable depth.
		const remoteTab = await page.locator(".settings-overlay-nav button").filter({ hasText: "Remote access" }).count();
		assert(remoteTab === 0, "Remote access tab must be absent on a remote device");

		for (const section of SECTIONS) {
			await page.locator(".settings-overlay-nav button").filter({ hasText: section.tab }).first().click();
			await page.waitForTimeout(700);
			const honestCount = await page.locator(".settings-overlay").getByText(section.honest, { exact: true }).count();
			assert(honestCount === 1, `${section.tab}: expected exactly one honest line, saw ${honestCount}`);
			for (const selector of section.absent) {
				const count = await page.locator(`.settings-overlay ${selector}`).count();
				assert(count === 0, `${section.tab}: local-only control still renders remotely (${selector}, ${count} found)`);
			}
			const back = page.locator(".settings-overlay-back");
			if (await back.count()) await back.click();
			await page.waitForTimeout(200);
		}
		await remoteCtx.close();

		// Loopback: the same tabs stay operable (the gate must fail open).
		const localCtx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
		const localPage = await localCtx.newPage();
		await localPage.goto(`${baseUrl}/auth/session?token=${SMOKE_AUTH_TOKEN}`);
		await localPage.waitForLoadState("networkidle");
		const localDismiss = localPage.locator(".whats-new-foot .btn-primary");
		if (await localDismiss.count()) await localDismiss.click();
		await localPage.locator(".product-sidebar-footer button").first().click();
		await localPage.locator(".sidebar-config-menu button, .sidebar-config-menu a").filter({ hasText: /Settings/ }).first().click();
		await localPage.waitForSelector(".settings-overlay", { timeout: 10000 });
		await localPage.locator(".settings-overlay-nav button").filter({ hasText: "AI setup" }).first().click();
		await localPage.waitForTimeout(700);
		assert((await localPage.locator(".add-provider-toggle").count()) === 1, "loopback: Add another provider must render");
		assert((await localPage.locator(".settings-overlay").getByText(SECTIONS[0].honest, { exact: true }).count()) === 0, "loopback: the remote honest line must not render");
		await localCtx.close();
	} finally {
		await browser.close();
	}

	console.log("remote-settings-readonly smoke: ok");
} finally {
	await stopSmokeServer(server);
	fs.rmSync(tempHome, { recursive: true, force: true });
}
