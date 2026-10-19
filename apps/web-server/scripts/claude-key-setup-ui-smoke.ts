// The Claude API key in AI setup, in the browser, against a real spawned server
// and one synthetic Anthropic endpoint (nothing leaves the machine, no real
// key exists), with a Claude sign-in already stored:
//
// - a refused key's line shows inside the key form it is about, in Add
//   provider and in Replace API key;
// - the key field names the provider once ("Claude API key");
// - Approve models shows dated model ids by their names, and the date only
//   where two models would read the same;
// - after Approve models, the Default models Memory list shows the new
//   choice at once, without a reload;
// - the key's models carry the same Recommended tag as the sign-in's, and
//   the memory model choice promises no tag;
// - a chat turn refused because the key is outside a workspace says so, with
//   Replace key;
// - the Wallet's turn rows count all input and name the cache, with the
//   full numbers in the row's tooltip.
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import { fileURLToPath } from "node:url";
import { chromium, type Page } from "playwright";
import { authedFetch, SMOKE_AUTH_TOKEN, SMOKE_SERVER_AUTH_ENV, SMOKE_SERVER_SPAWN_TREE_OPTIONS, smokeHomeEnv, stopSmokeServer, freePort } from "./smoke-server-process.js";

function assert(condition: unknown, message: string): asserts condition {
	if (!condition) throw new Error(message);
}

function pass(label: string): void {
	console.log(`  ok  ${label}`);
}

{
	const p = typeof chromium?.executablePath === "function" ? chromium.executablePath() : "";
	if (!p || !fs.existsSync(p)) {
		console.log("claude key setup ui smoke skipped (Chromium not installed)");
		process.exit(0);
	}
}

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const webServerDir = path.resolve(scriptDir, "..");
const repoRoot = path.resolve(webServerDir, "..", "..");
const port = await freePort();
const baseUrl = `http://127.0.0.1:${port}`;

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "exxperts-claude-key-ui-"));
const tempHome = path.join(tempRoot, "home");
const agentsRoot = path.join(tempHome, ".exxperts", "app", "personalized-agents");
const agentDir = path.join(tempHome, ".exxperts", "agent");
const appDir = path.join(tempHome, ".exxperts", "app");
for (const dir of [agentsRoot, agentDir]) fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
process.env.HOME = tempHome;
process.env.USERPROFILE = tempHome;
process.env.EXXPERTS_CODING_AGENT_DIR = agentDir;
process.env.EXXETA_PERSISTENT_AGENTS_ROOT = agentsRoot;

const KEY_PROVIDER = "anthropic-api-key";
const SIGN_IN = { type: "oauth", access: "sk-ant-oat01-synthetic-sign-in", refresh: "synthetic-refresh", expires: Date.now() + 365 * 24 * 3600 * 1000 };
const REFUSED_LINE = /did not accept this key/;

// The key check at save (GET /v1/models): refused or accepted.
let keyRefused = true;
const endpoint = http.createServer((req, res) => {
	req.resume();
	req.on("end", () => {
		if (req.method === "GET" && req.url?.startsWith("/v1/models")) {
			if (keyRefused) { res.writeHead(401, { "content-type": "application/json" }); res.end(JSON.stringify({ type: "error", error: { type: "authentication_error", message: "invalid x-api-key" } })); return; }
			res.writeHead(200, { "content-type": "application/json" });
			res.end(JSON.stringify({ data: [{ type: "model", id: "claude-opus-5-5" }], has_more: false }));
			return;
		}
		// Every turn meets the 400 Anthropic gives a key made outside a workspace.
		res.writeHead(400, { "content-type": "application/json" });
		res.end(JSON.stringify({ type: "error", error: { type: "invalid_request_error", message: "This API key is not scoped to a workspace, so this request must include the anthropic-workspace-id header with the ID of the workspace to use. Add the header, or use an API key that is scoped to a workspace." } }));
	});
});

async function waitUntil(predicate: () => Promise<boolean> | boolean, label: string, timeoutMs = 25_000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (await predicate()) return;
		await new Promise((resolve) => setTimeout(resolve, 150));
	}
	throw new Error(`timed out waiting until ${label}`);
}

/** The Default models Memory picker's groups, each with its options and which one is tagged. */
async function memoryDefaults(page: Page): Promise<Record<string, { names: string[]; recommended: string[] }>> {
	const pick = page.locator(".settings-overlay .ai-defaults-group .room-model-row").nth(1).locator(".room-model-pick");
	await pick.click();
	await page.locator(".room-model-menu-group").first().waitFor({ timeout: 10000 });
	const groups = await page.locator(".room-model-menu-group[aria-label]").evaluateAll((nodes) => Object.fromEntries(nodes.map((node) => [
		node.getAttribute("aria-label") ?? "",
		{
			names: [...node.querySelectorAll(".room-model-option-name")].map((name) => name.textContent ?? ""),
			recommended: [...node.querySelectorAll(".room-model-option")].filter((option) => option.querySelector(".room-model-option-tag")).map((option) => option.querySelector(".room-model-option-name")?.textContent ?? ""),
		},
	])));
	await page.keyboard.press("Escape");
	return groups;
}

let server: ChildProcessWithoutNullStreams | undefined;
const serverOutput: string[] = [];

try {
	await new Promise<void>((resolve) => endpoint.listen(0, "127.0.0.1", resolve));
	const endpointUrl = `http://127.0.0.1:${(endpoint.address() as AddressInfo).port}`;
	fs.writeFileSync(path.join(agentDir, "models.json"), JSON.stringify({ providers: { anthropic: { baseUrl: endpointUrl }, [KEY_PROVIDER]: { baseUrl: endpointUrl } } }, null, 2), { mode: 0o600 });
	fs.writeFileSync(path.join(agentDir, "auth.json"), JSON.stringify({ anthropic: SIGN_IN }, null, 2), { mode: 0o600 });
	fs.writeFileSync(path.join(appDir, "persistent-agent-ai-profile.json"), JSON.stringify({ profileId: "anthropic" }, null, 2), { mode: 0o600 });
	// Three turns on the key: one wrote the cache, one read it, one did both.
	const turn = (ts: number, input: number, cacheRead: number, cacheWrite: number, output: number, cost: number) => ({ ts, agent: "wallet-room", persona: "wallet-room", model: "claude-opus-5-5", provider: KEY_PROVIDER, authType: "api_key", kind: "chat", input, output, cacheRead, cacheWrite, cost });
	const now = Date.now();
	fs.writeFileSync(path.join(appDir, "usage.jsonl"), [turn(now - 3000, 4, 0, 9409, 44, 0.05), turn(now - 2000, 5, 9455, 0, 50, 0.001), turn(now - 1000, 5, 9000, 455, 6, 0.004)].map((row) => JSON.stringify(row)).join("\n") + "\n", { mode: 0o600 });

	const agents = await import("../src/persistent-agents.js");
	const keyRoom = agents.createPersistentAgentFromScaffoldInput({ displayName: "Key Room", userName: "Synthetic User", preferredUserAddress: "Synthetic User" }).agent.agentId;

	server = spawn("npx", ["tsx", "src/index.ts"], {
		shell: process.platform === "win32",
		...SMOKE_SERVER_SPAWN_TREE_OPTIONS,
		cwd: webServerDir,
		env: smokeHomeEnv(tempHome, { PORT: String(port), ...SMOKE_SERVER_AUTH_ENV, EXXETA_HOME: repoRoot, EXXPERTS_CODING_AGENT_DIR: agentDir, EXXETA_PERSISTENT_AGENTS_ROOT: agentsRoot }) as NodeJS.ProcessEnv,
	});
	server.stdout.on("data", (chunk) => serverOutput.push(String(chunk)));
	server.stderr.on("data", (chunk) => serverOutput.push(String(chunk)));
	await waitUntil(() => fetch(`${baseUrl}/healthz`).then((r) => r.ok).catch(() => false), "server ready");

	const browser = await chromium.launch();
	try {
		const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
		const page = await ctx.newPage();
		await page.goto(`${baseUrl}/auth/session?token=${SMOKE_AUTH_TOKEN}`);
		await page.waitForLoadState("networkidle");
		const dismiss = page.locator(".whats-new-close");
		if (await dismiss.count()) await dismiss.click();
		await page.locator(".product-sidebar-footer button").first().click();
		await page.locator(".sidebar-config-menu button, .sidebar-config-menu a").filter({ hasText: /Settings/ }).first().click();
		await page.waitForSelector(".settings-overlay", { timeout: 10000 });
		await page.locator(".settings-dialog-nav button").filter({ hasText: "AI setup" }).first().click();

		// Add provider: a refused key's line sits inside the key form.
		await page.getByRole("button", { name: "Add provider" }).click();
		const keyRow = page.locator(".add-provider-row-group").filter({ has: page.locator(".settings-row-label", { hasText: /^Claude API key$/ }) });
		await keyRow.getByRole("button", { name: "Add key" }).click();
		const addForm = keyRow.locator(".add-provider-row-key-form");
		await addForm.locator("input").fill("synthetic-refused-key");
		await addForm.getByRole("button", { name: "Save key" }).click();
		await waitUntil(async () => REFUSED_LINE.test(await page.locator(".add-provider-block").innerText()), "the refused line shows");
		assert(await addForm.getByText(REFUSED_LINE).count() === 1, `Add provider shows the refused line inside the key form, got the form "${await addForm.innerText()}"`);
		pass("Add provider shows a refused key's line inside the key form");

		// Approve models: dated ids read as names, the date only where two would read the same.
		keyRefused = false;
		await addForm.locator("input").fill("synthetic-key");
		await addForm.getByRole("button", { name: "Save key" }).click();
		const modal = page.locator(".configure-profile-modal");
		await modal.locator(".configure-profile-model-name").first().waitFor({ timeout: 10000 });
		const approveNames = await modal.locator(".configure-profile-model-name").allInnerTexts();
		assert(approveNames.every((name) => !/\d\.\d{8}/.test(name)), `no model name carries a raw date, got ${JSON.stringify(approveNames)}`);
		assert(approveNames.includes("Claude Haiku 4.5") && approveNames.includes("Claude Haiku 4.5 (1 Oct 2025)") && approveNames.includes("Claude Sonnet 4.5 (29 Sep 2025)"), `a dated model shows its date only beside a look-alike, got ${JSON.stringify(approveNames)}`);
		assert(new Set(approveNames).size === approveNames.length, `no two models in the list read the same, got ${JSON.stringify(approveNames)}`);
		pass("Approve models names dated models plainly, and dates only look-alikes");
		const memorySelect = modal.getByRole("combobox", { name: "Memory model", exact: true });
		assert(!/Recommended/.test(`${await memorySelect.getAttribute("title") ?? ""} ${await modal.locator(".configure-profile-field h3").allInnerTexts()}`), "the memory model choice calls nothing Recommended");
		pass("the memory model choice promises no Recommended tag");
		await modal.getByRole("button", { name: "Save profile" }).click();
		await modal.waitFor({ state: "detached", timeout: 10000 });

		// The key's models carry the sign-in's Recommended tag.
		let groups = await memoryDefaults(page);
		assert(groups["Claude API key"] && groups.Claude, `the Memory list has the sign-in and the key, got ${JSON.stringify(groups)}`);
		assert(groups.Claude.recommended.length === 1 && JSON.stringify(groups["Claude API key"].recommended) === JSON.stringify(groups.Claude.recommended), `the key tags the sign-in's recommended model, got ${JSON.stringify(groups)}`);
		pass(`the key's Memory list tags ${groups.Claude.recommended[0]}, as the sign-in does`);

		// A second Approve models that changes only the memory model shows at once.
		assert(!groups["Claude API key"].names.includes("Claude Haiku 5.5"), `before: the key offers no Haiku 5.5 for memory, got ${JSON.stringify(groups["Claude API key"])}`);
		await page.getByRole("button", { name: "Manage Claude API key" }).click();
		await page.getByRole("menuitem", { name: "Approve models" }).click();
		await modal.locator(".configure-profile-model-name").first().waitFor({ timeout: 10000 });
		await modal.getByRole("combobox", { name: "Memory model", exact: true }).selectOption("claude-haiku-5-5");
		await modal.getByRole("button", { name: "Save profile" }).click();
		await modal.waitFor({ state: "detached", timeout: 10000 });
		await page.waitForTimeout(800);
		groups = await memoryDefaults(page);
		assert(groups["Claude API key"].names.includes("Claude Haiku 5.5"), `after Approve models, the Default models Memory list shows the new memory model without a reload, got ${JSON.stringify(groups["Claude API key"])}`);
		pass("the Default models Memory list follows Approve models at once");

		// Replace API key: the field names the provider once, and a refused key's line sits inside the form.
		keyRefused = true;
		await page.getByRole("button", { name: "Manage Claude API key" }).click();
		await page.getByRole("menuitem", { name: "Replace API key" }).click();
		const replaceForm = page.locator(".ai-profile-key-form");
		await replaceForm.locator("input").waitFor({ timeout: 10000 });
		const placeholder = await replaceForm.locator("input").getAttribute("placeholder");
		assert(placeholder === "Claude API key", `the Replace field names the provider once, got "${placeholder}"`);
		pass("the Replace API key field reads \"Claude API key\"");
		await replaceForm.locator("input").fill("synthetic-refused-key");
		await replaceForm.getByRole("button", { name: "Save key" }).click();
		await waitUntil(async () => REFUSED_LINE.test(await page.locator(".settings-overlay").innerText()), "the refused line shows after Replace");
		assert(await replaceForm.getByText(REFUSED_LINE).count() === 1, `Replace API key shows the refused line inside the key form, got the form "${await replaceForm.innerText()}"`);
		pass("Replace API key shows a refused key's line inside the key form");

		// A chat turn refused because the key is outside a workspace: the workspace line, with Replace key.
		await page.keyboard.press("Escape");
		const picked = await authedFetch(`${baseUrl}/api/persistent-agents/${keyRoom}/models`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ conversation: { provider: KEY_PROVIDER, model: "claude-opus-5-5" } }) });
		assert(picked.ok, `the key room picks Opus 5.5 on the key, got ${picked.status}`);
		await page.goto(baseUrl);
		await page.reload();
		await page.waitForLoadState("networkidle");
		await page.locator(".persistent-agent-card").filter({ hasText: "Key Room" }).getByRole("button", { name: /^(Enter|Resume) →$/ }).click();
		const composer = page.locator("textarea").first();
		await composer.waitFor({ timeout: 15000 });
		await page.locator('button[title="Send"]').first().waitFor({ timeout: 15000 });
		await page.waitForLoadState("networkidle");
		await composer.fill("A question on a key outside a workspace.");
		await page.getByRole("button", { name: "Send" }).click();
		const workspaceLine = page.getByText("Claude Opus 5.5 cannot answer because its key isn't tied to a workspace.", { exact: true });
		await workspaceLine.waitFor({ timeout: 20000 });
		assert(await page.getByRole("button", { name: "Replace key" }).count() >= 1, "the workspace line offers Replace key");
		assert(await page.getByText(/did not accept the saved key|check the model and its sign-in/).count() === 0, "the chat names the workspace, not a refused key or the raw words");
		pass("a chat turn refused for a key outside a workspace says so, with Replace key");

		// The Wallet's turn rows: all input counted, the cache named, full numbers in the tooltip.
		await page.goto(`${baseUrl}/#/dashboard`);
		await page.reload();
		await page.waitForLoadState("networkidle");
		await page.locator("[aria-controls=\"recent-turns-body\"]").click();
		const inCells = page.locator("#recent-turns-body tbody tr td:nth-child(6)");
		await inCells.first().waitFor({ timeout: 10000 });
		// The refused chat turn above is the newest row; the three seeded turns follow it.
		const cells = await inCells.evaluateAll((nodes) => nodes.map((node) => ({ text: node.textContent ?? "", title: node.getAttribute("title") ?? "" })));
		const expected = [
			{ text: "9.5k(9.0k reused, 455 stored)", title: "9,460 in (9,000 reused, 455 stored), 6 out, $0.004" },
			{ text: "9.5k(9.5k reused)", title: "9,460 in (9,455 reused), 50 out, $0.001" },
			{ text: "9.4k(9.4k stored for reuse)", title: "9,413 in (9,409 stored for reuse), 44 out, $0.05" },
		];
		assert(JSON.stringify(cells.slice(-3)) === JSON.stringify(expected), `the Wallet's turn rows count all input and name the cache, got ${JSON.stringify(cells)}`);
		pass("the Wallet's turn rows count all input and name the cache");
		await ctx.close();
	} finally {
		await browser.close();
	}
	console.log("claude-key-setup-ui smoke: ok");
} catch (error) {
	console.error(serverOutput.join("").slice(-6000));
	throw error;
} finally {
	await stopSmokeServer(server);
	endpoint.close();
	fs.rmSync(tempRoot, { recursive: true, force: true });
}
