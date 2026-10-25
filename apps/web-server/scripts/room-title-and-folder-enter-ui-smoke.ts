// Small things in the page, against a real server: the window title names
// the room a person is in ("Room name - exxperts"), and Home and Settings keep
// "exxperts"; a room whose name is only invisible characters reads "Unnamed
// room" wherever its name shows; and Enter in Room settings' workspace folder
// box accepts the folder and keeps the editor open, so nothing is saved until
// Save changes is clicked. Offline: a synthetic model that is never called. Throwaway HOME.
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { authedFetch, SMOKE_AUTH_TOKEN, SMOKE_SERVER_AUTH_ENV, SMOKE_SERVER_SPAWN_TREE_OPTIONS, smokeHomeEnv, stopSmokeServer, freePort, type AuthedFetchInit } from "./smoke-server-process.js";

function assert(condition: unknown, message: string): asserts condition {
	if (!condition) throw new Error(message);
}

{
	const p = typeof chromium?.executablePath === "function" ? chromium.executablePath() : "";
	if (!p || !fs.existsSync(p)) {
		console.log("room title and folder enter smoke skipped (Chromium not installed)");
		process.exit(0);
	}
}

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const webServerDir = path.resolve(scriptDir, "..");
const repoRoot = path.resolve(webServerDir, "..", "..");
const port = await freePort();
const baseUrl = `http://127.0.0.1:${port}`;

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "exxperts-room-title-"));
const tempHome = path.join(tempRoot, "home");
const agentsRoot = path.join(tempHome, ".exxperts", "app", "personalized-agents");
const agentDir = path.join(tempHome, ".exxperts", "agent");
for (const dir of [agentsRoot, agentDir]) fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
const clientA = path.join(tempHome, "Projects", "client-a");
const clientB = path.join(tempHome, "Projects", "client-b");
for (const dir of [clientA, clientB]) fs.mkdirSync(dir, { recursive: true });
// A model to enter a room with; nothing here sends it a message, so its address answers nothing.
const appDir = path.join(tempHome, ".exxperts", "app");
fs.writeFileSync(path.join(agentDir, "models.json"), JSON.stringify({ providers: { "openai-compatible": { name: "Synthetic Gateway", baseUrl: "http://127.0.0.1:9/v1", api: "openai-completions", models: [{ id: "room-model", name: "Room Model", contextWindow: 128000, maxTokens: 16384 }] } } }, null, 2), { mode: 0o600 });
fs.writeFileSync(path.join(agentDir, "auth.json"), JSON.stringify({ "openai-compatible": { type: "api_key", key: "synthetic-title-key" } }, null, 2), { mode: 0o600 });
fs.writeFileSync(path.join(appDir, "openai-compatible-ai-profile.json"), JSON.stringify({ profileId: "openai-compatible", providerId: "openai-compatible", label: "Synthetic Gateway", roomModels: [{ modelId: "room-model", label: "Room Model" }], maintenanceModel: "room-model" }, null, 2), { mode: 0o600 });
fs.writeFileSync(path.join(appDir, "persistent-agent-ai-profile.json"), JSON.stringify({ profileId: "openai-compatible" }, null, 2), { mode: 0o600 });

async function api(pathname: string, init: AuthedFetchInit = {}): Promise<{ status: number; body: any }> {
	const response = await authedFetch(`${baseUrl}${pathname}`, { ...init, headers: { ...(init.body ? { "content-type": "application/json" } : {}), ...init.headers } });
	const text = await response.text();
	return { status: response.status, body: text ? JSON.parse(text) : null };
}

async function waitUntil(predicate: () => Promise<boolean> | boolean, label: string, timeoutMs = 15_000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (await predicate()) return;
		await new Promise((resolve) => setTimeout(resolve, 150));
	}
	throw new Error(`timed out waiting until ${label}`);
}

let server: ChildProcessWithoutNullStreams | undefined;
const serverOutput: string[] = [];
try {
	server = spawn("npx", ["tsx", "src/index.ts"], {
		shell: process.platform === "win32",
		...SMOKE_SERVER_SPAWN_TREE_OPTIONS,
		cwd: webServerDir,
		env: smokeHomeEnv(tempHome, { PORT: String(port), ...SMOKE_SERVER_AUTH_ENV, EXXETA_HOME: repoRoot, EXXPERTS_CODING_AGENT_DIR: agentDir, EXXETA_PERSISTENT_AGENTS_ROOT: agentsRoot }) as NodeJS.ProcessEnv,
	});
	server.stdout.on("data", (chunk) => serverOutput.push(String(chunk)));
	server.stderr.on("data", (chunk) => serverOutput.push(String(chunk)));
	await waitUntil(() => fetch(`${baseUrl}/healthz`).then((r) => r.ok).catch(() => false), "server ready", 30_000);

	const created = await api("/api/persistent-agents", { method: "POST", body: JSON.stringify({ displayName: "Client Desk", userName: "Synthetic User", preferredUserAddress: "Synthetic User" }) });
	assert(created.status === 201, `the room is created, got ${created.status}`);
	const agentId = String(created.body?.agent?.id ?? "");
	const saved = await api(`/api/persistent-agents/${encodeURIComponent(agentId)}/workspace-default`, { method: "PUT", body: JSON.stringify({ root: clientA, displayLabel: "client-a", workspaceAccessMode: "localFiles", bashEnabled: false }) });
	assert(saved.status === 200, `the room's folder is client-a, got ${saved.status}`);
	// The page's view names the folder, never its full path.
	const savedRoot = async () => String((await api(`/api/persistent-agents/${encodeURIComponent(agentId)}/workspace-default`)).body?.policy?.roots?.[0]?.basename ?? "");
	assert(await savedRoot() === "client-a", `client-a is saved, got ${await savedRoot()}`);

	// Two rooms named before such names were refused: one zero-width space, one word joiner.
	const ghostIds: string[] = [];
	for (const [name, invisible] of [["Ghost Desk", "\u200b"], ["Ghost Two", "\u2060"]]) {
		const ghost = await api("/api/persistent-agents", { method: "POST", body: JSON.stringify({ displayName: name, userName: "Synthetic User", preferredUserAddress: "Synthetic User" }) });
		assert(ghost.status === 201, `${name} is created, got ${ghost.status}`);
		ghostIds.push(String(ghost.body?.agent?.id ?? ""));
		const ghostRecord = path.join(agentsRoot, ghostIds.at(-1)!, "agent.json");
		fs.writeFileSync(ghostRecord, JSON.stringify({ ...JSON.parse(fs.readFileSync(ghostRecord, "utf-8")), displayName: invisible }, null, 2));
	}
	// A memory edit, so Maintain has something to offer the first one.
	const ghostMemory = path.join(agentsRoot, ghostIds[0], "L1b", "current.md");
	fs.writeFileSync(ghostMemory, fs.readFileSync(ghostMemory, "utf-8").replace(/^## Chronos[ \t]*$/m, "## Chronos\n- Last edit at: 2026-10-01T10:00:00.000Z"));

	const browser = await chromium.launch();
	try {
		const page = await (await browser.newContext({ viewport: { width: 1280, height: 900 } })).newPage();
		await page.goto(`${baseUrl}/auth/session?token=${SMOKE_AUTH_TOKEN}`);
		await page.waitForLoadState("networkidle");
		const dismiss = page.locator(".whats-new-close");
		if (await dismiss.count()) await dismiss.click();
		const card = page.locator(".persistent-agent-card").filter({ hasText: "Client Desk" });
		await card.waitFor({ timeout: 10_000 });
		const title = () => page.title();

		// ONLY=title, ONLY=enter or ONLY=unnamed runs one section alone, so each is its own red-first command.
		const only = process.env.ONLY;

		// 1. The window title follows the room; Home and Settings keep the app's name.
		if (!only || only === "title") {
			assert(await title() === "exxperts", `Home is called exxperts, got ${await title()}`);
			await card.getByRole("button", { name: /^(Enter|Resume) →$/ }).click();
			await waitUntil(async () => (await title()) === "Client Desk - exxperts", `the room's title, got ${await title()}`);
			await page.keyboard.press("ControlOrMeta+Comma");
			await page.locator(".settings-dialog").first().waitFor({ timeout: 10_000 });
			await waitUntil(async () => (await title()) === "exxperts", `Settings is called exxperts, got ${await title()}`);
			await page.keyboard.press("Escape");
			await waitUntil(async () => (await title()) === "Client Desk - exxperts", `back in the room, its title again, got ${await title()}`);
			await page.evaluate(() => { window.location.hash = "#/"; });
			await card.waitFor({ timeout: 10_000 });
			await waitUntil(async () => (await title()) === "exxperts", `Home again is called exxperts, got ${await title()}`);
			console.log("  ok  the window title names the room; Home and Settings keep exxperts");
		}

		// 3. A name of only invisible characters is refused like an empty one, in the page's words;
		// a room named so before reads "Unnamed room" wherever its name shows.
		if (!only || only === "unnamed") {
			await page.getByRole("button", { name: "Create a new room" }).click();
			const form = page.locator(".create-room-overlay .create-room-form");
			await form.locator(".create-room-field").filter({ hasText: "Room name" }).locator("input").fill("\u200b");
			await form.locator(".create-room-field").filter({ hasText: "Your name" }).locator("input").fill("Synthetic User");
			await form.getByRole("button", { name: "Create room" }).click();
			await form.getByText("Room name is required.").waitFor({ timeout: 10_000 });
			assert(!(await form.innerText()).includes("displayName"), "the refusal names no code word");
			await page.keyboard.press("Escape");
			// Home: both read "Unnamed room", sort under U, and each card names its room id.
			const names = async () => (await page.locator(".persistent-agent-card h2").allInnerTexts()).map((name) => name.trim());
			await waitUntil(async () => (await names()).filter((name) => name === "Unnamed room").length === 2, `two cards read Unnamed room, got ${JSON.stringify(await names())}`);
			const order = await names();
			assert(order.indexOf("Unnamed room") > order.indexOf("Client Desk"), `A to Z puts Unnamed room under U, after Client Desk, got ${JSON.stringify(order)}`);
			const hints = await page.locator(".persistent-agent-card h2", { hasText: "Unnamed room" }).evaluateAll((heads) => heads.map((head) => head.getAttribute("title") ?? ""));
			assert(hints.length === 2 && hints.every((hint) => hint.startsWith("Room id ")), `two Unnamed room cards each name their room id, got ${JSON.stringify(hints)}`);
			// Room settings: the header, Rename starting empty, and the delete row.
			const ghostCard = page.locator(".persistent-agent-card").filter({ hasText: "Unnamed room" }).first();
			await ghostCard.locator(".card-gear-btn").click();
			await page.waitForSelector(".settings-dialog", { timeout: 10_000 });
			const header = page.locator("#room-settings-title");
			await header.waitFor({ state: "attached", timeout: 10_000 });
			assert(await header.textContent() === "Unnamed room", `Room settings names the room Unnamed room, got ${JSON.stringify(await header.textContent())}`);
			await page.getByRole("button", { name: "Rename room" }).click();
			assert(await page.locator(".room-settings-rename-input").inputValue() === "", `Rename starts empty, got ${JSON.stringify(await page.locator(".room-settings-rename-input").inputValue())}`);
			await page.keyboard.press("Escape");
			await page.locator(".settings-dialog-nav-item").filter({ hasText: /^Archive or delete$/ }).first().click();
			await page.getByText("Delete Unnamed room permanently").waitFor({ timeout: 10_000 });
			await page.keyboard.press("Escape");
			await page.locator(".settings-dialog").first().waitFor({ state: "detached", timeout: 10_000 });
			// The room itself: the title.
			await ghostCard.getByRole("button", { name: /^(Enter|Resume) →$/ }).click();
			await waitUntil(async () => (await title()) === "Unnamed room - exxperts", `the unnamed room's title, got ${JSON.stringify(await title())}`);
			await page.evaluate(() => { window.location.hash = "#/"; });
			await card.waitFor({ timeout: 10_000 });
			// Maintain, opened from its address, and the Memory page.
			await page.evaluate((id) => { window.location.hash = `#/maintain/${id}`; }, ghostIds[0]);
			const kicker = page.locator(".maintain-workspace .card-kicker");
			await kicker.waitFor({ timeout: 10_000 });
			assert(await kicker.textContent() === "Unnamed room", `Maintain names the room Unnamed room, got ${JSON.stringify(await kicker.textContent())}`);
			await page.evaluate(() => { window.location.hash = "#/"; });
			await card.waitFor({ timeout: 10_000 });
			await page.evaluate(() => { window.location.hash = "#/memory"; });
			const memoryNames = async () => (await page.locator(".mem-card-name").allInnerTexts()).map((name) => name.trim());
			await waitUntil(async () => (await memoryNames()).length === 3, "the Memory page lists the three rooms");
			assert((await memoryNames()).filter((name) => name === "Unnamed room").length === 2, `the Memory page reads Unnamed room, got ${JSON.stringify(await memoryNames())}`);
			await page.evaluate(() => { window.location.hash = "#/"; });
			await card.waitFor({ timeout: 10_000 });
			console.log("  ok  an invisible name is refused in plain words; an old one reads Unnamed room on Home, in Room settings, in the room, Maintain and Memory");
		}

		// 2. Enter in the folder box accepts the folder and keeps the editor open; Save changes saves.
		if (!only || only === "enter") {
			await card.locator(".card-gear-btn").click();
			await page.waitForSelector(".settings-dialog", { timeout: 10_000 });
			await page.locator(".settings-dialog-nav-item").filter({ hasText: /^Workspace$/ }).first().click();
			const pane = page.locator(".room-settings-section:not([hidden]) .room-workspace-section");
			await pane.getByRole("button", { name: "Edit workspace" }).click();
			const folder = pane.getByLabel("Workspace folder path");
			await folder.fill(clientB);
			await folder.press("Enter");
			await page.waitForTimeout(800);
			assert(await pane.getByRole("button", { name: "Save changes" }).isVisible(), "the editor stays open after Enter");
			assert(await folder.inputValue() === clientB, `the typed folder stays in the box, got ${await folder.inputValue()}`);
			assert(await savedRoot() === "client-a", "Enter saves nothing: client-a is still the room's folder");
			await pane.getByRole("button", { name: "Save changes" }).click();
			await waitUntil(async () => (await savedRoot()) === "client-b", "Save changes saves client-b");
			console.log("  ok  Enter in the folder box keeps the editor open; Save changes saves");
		}
	} finally {
		await browser.close();
	}
	console.log("room title and folder enter smoke: ok");
} catch (error) {
	console.error(serverOutput.join("").slice(-3000));
	throw error;
} finally {
	await stopSmokeServer(server);
	fs.rmSync(tempRoot, { recursive: true, force: true });
}
