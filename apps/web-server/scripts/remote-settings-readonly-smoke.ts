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
import { authedFetch, SMOKE_AUTH_TOKEN, SMOKE_SERVER_AUTH_ENV, SMOKE_SERVER_SPAWN_TREE_OPTIONS, stopSmokeServer } from "./smoke-server-process.js";

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
		// No radio: providers are rows, and the defaults for new rooms choose the models.
		absent: [".ai-profile-signin", ".ai-profile-menu-btn", ".add-provider-toggle", '[role="radio"]', ".ai-profile-radio", ".room-model-pick:not(:disabled)"],
	},
	{
		tab: "Web search",
		honest: "Web search is set up on the computer itself.",
		absent: ['input[type="checkbox"]', 'input[type="radio"]', "select"],
	},
	{
		tab: "Connectors",
		honest: "Connectors are set up and signed in on the computer itself.",
		absent: [".connector-row-actions button", ".connector-dir-search", ".connector-dir-row button"],
	},
	{
		tab: "Skills",
		honest: "Skills are uploaded and edited on the computer itself.",
		absent: [".pane-head-actions button"],
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
	}) as unknown as ChildProcessWithoutNullStreams;
	await waitForServer();
	// One room, so Home shows a card whose model label opens Room settings, Model.
	const created = await authedFetch(`${baseUrl}/api/persistent-agents`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ displayName: "Readonly Room", userName: "Synthetic User", preferredUserAddress: "Synthetic User" }) });
	assert(created.ok, `room create failed: ${created.status}`);

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
		const remoteTab = await page.locator(".settings-dialog-nav button").filter({ hasText: "Remote access" }).count();
		assert(remoteTab === 0, "Remote access tab must be absent on a remote device");

		for (const section of SECTIONS) {
			await page.locator(".settings-dialog-nav button").filter({ hasText: section.tab }).first().click();
			await page.waitForTimeout(700);
			const honestCount = await page.locator(".settings-overlay").getByText(section.honest, { exact: true }).count();
			assert(honestCount === 1, `${section.tab}: expected exactly one honest line, saw ${honestCount}`);
			for (const selector of section.absent) {
				const count = await page.locator(`.settings-overlay ${selector}`).count();
				assert(count === 0, `${section.tab}: local-only control still renders remotely (${selector}, ${count} found)`);
			}
			const back = page.locator(".settings-dialog-back");
			if (await back.count()) await back.click();
			await page.waitForTimeout(200);
		}
		// AI setup renders the defaults for new rooms, read-only.
		await page.locator(".settings-dialog-nav button").filter({ hasText: "AI setup" }).first().click();
		await page.waitForTimeout(700);
		const defaultPickers = await page.locator(".settings-overlay .ai-defaults-group .room-model-pick").count();
		assert(defaultPickers === 2, `AI setup: expected the two default rows, saw ${defaultPickers}`);
		await page.keyboard.press("Escape");
		await page.waitForTimeout(300);
		if (await page.locator(".settings-overlay").count()) {
			await page.locator(".settings-dialog-close").first().click();
			await page.waitForTimeout(300);
		}

		// The card's model is a label that opens Room settings on the Model
		// pane; on a read-only device its pickers are disabled.
		const label = page.locator(".card-model-label").first();
		await label.waitFor({ timeout: 10000 });
		await label.click();
		await page.waitForSelector(".settings-dialog .room-model-section", { timeout: 10000 });
		const modelPane = page.locator(".settings-dialog .room-model-section");
		assert(await modelPane.isVisible(), "the card label must open Room settings on the Model pane");
		assert((await modelPane.locator(".pane-head h2").innerText()).trim() === "Model", "the pane opened is Model");
		const pickers = await modelPane.locator(".room-model-pick").count();
		assert(pickers === 2, `Model pane: expected two rows, saw ${pickers}`);
		assert((await modelPane.locator(".room-model-pick:not(:disabled)").count()) === 0, "Model pane: a picker is enabled on a read-only device");
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
		await localPage.locator(".settings-dialog-nav button").filter({ hasText: "AI setup" }).first().click();
		await localPage.waitForTimeout(700);
		assert((await localPage.locator(".add-provider-toggle").count()) === 1, "loopback: Add another provider must render");
		assert((await localPage.locator(".settings-overlay").getByText(SECTIONS[0].honest, { exact: true }).count()) === 0, "loopback: the remote honest line must not render");
		await localCtx.close();
		// Loopback Remote access with a tunnel found and remote access off: the
		// Tunnel row says what the phone needs and claims nothing about who can
		// reach this computer (a shared tailnet reaches it too).
		const tunnelCtx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
		await tunnelCtx.route("**/api/remote/status", (route) =>
			route.fulfill({ contentType: "application/json", body: JSON.stringify({ enabled: false, address: null, port, tunnelAddress: "100.64.0.1", scheme: null, dnsName: null, tlsFallbackReason: null, degradedReason: null, stateFile: "absent", keepAwake: true }) }));
		const tunnelPage = await tunnelCtx.newPage();
		await tunnelPage.goto(`${baseUrl}/auth/session?token=${SMOKE_AUTH_TOKEN}`);
		await tunnelPage.waitForLoadState("networkidle");
		const tunnelDismiss = tunnelPage.locator(".whats-new-foot .btn-primary");
		if (await tunnelDismiss.count()) await tunnelDismiss.click();
		await tunnelPage.locator(".product-sidebar-footer button").first().click();
		await tunnelPage.locator(".sidebar-config-menu button, .sidebar-config-menu a").filter({ hasText: /Settings/ }).first().click();
		await tunnelPage.waitForSelector(".settings-overlay", { timeout: 10000 });
		await tunnelPage.locator(".settings-dialog-nav button").filter({ hasText: "Remote access" }).first().click();
		await tunnelPage.waitForSelector(".settings-overlay .workspaces-tool-switch", { timeout: 10000 });
		const tunnelLine = "Found. Your phone needs Tailscale on too, signed in to the same account as this computer.";
		const tunnelLineCount = await tunnelPage.locator(".settings-overlay").getByText(tunnelLine, { exact: true }).count();
		assert(tunnelLineCount === 1, `loopback Remote access: expected the Tunnel row's sentence once, saw ${tunnelLineCount}`);
		assert((await tunnelPage.locator(".settings-overlay").getByText(/Only devices signed in to your Tailscale account/).count()) === 0, "loopback Remote access: the Tunnel row must not claim who can reach this computer");
		await tunnelCtx.close();
	} finally {
		await browser.close();
	}

	console.log("remote-settings-readonly smoke: ok");
} finally {
	await stopSmokeServer(server);
	fs.rmSync(tempHome, { recursive: true, force: true });
}
