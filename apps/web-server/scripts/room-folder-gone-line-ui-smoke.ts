// A room whose saved folder is gone from this computer says so above the
// composer, with the folder's name and one button, Choose folder, that opens
// Room settings at Workspace. The line has no Dismiss; it leaves by itself,
// without a reload, once the folder is back (on returning to the page) or
// another folder is chosen there; a re-check that fails keeps it. A folder
// that goes while its room is open is said on returning to the page. A room
// that never had a folder still shows the old nudge, and a room whose folder
// exists shows neither.
// Offline: the room's model is never asked. Throwaway HOME.
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, type Page } from "playwright";
import { authedFetch, SMOKE_AUTH_TOKEN, SMOKE_SERVER_AUTH_ENV, SMOKE_SERVER_SPAWN_TREE_OPTIONS, smokeHomeEnv, stopSmokeServer, freePort, type AuthedFetchInit } from "./smoke-server-process.js";
import { waitEvery } from "./smoke-wait.js";

function assert(condition: unknown, message: string): asserts condition {
	if (!condition) throw new Error(message);
}

{
	const p = typeof chromium?.executablePath === "function" ? chromium.executablePath() : "";
	if (!p || !fs.existsSync(p)) {
		console.log("room folder gone line smoke skipped (Chromium not installed)");
		process.exit(0);
	}
}

const NUDGE_LINE = "Set a folder so this room can read and write files.";
const goneLine = (name: string) => `${name} was not found on this computer. Choose it again, or another folder.`;

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const webServerDir = path.resolve(scriptDir, "..");
const repoRoot = path.resolve(webServerDir, "..", "..");
const port = await freePort();
const baseUrl = `http://127.0.0.1:${port}`;

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "exxperts-folder-gone-line-"));
const tempHome = path.join(tempRoot, "home");
const agentsRoot = path.join(tempHome, ".exxperts", "app", "personalized-agents");
const agentDir = path.join(tempHome, ".exxperts", "agent");
const appDir = path.join(tempHome, ".exxperts", "app");
for (const dir of [agentsRoot, agentDir]) fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
const projects = path.join(tempHome, "Projects");
const hereFolder = path.join(projects, "still-here");
const goneFolder = path.join(projects, "Quarterly Reports");
const movedFolder = path.join(projects, "moved-away");
const newFolder = path.join(projects, "new-home");
for (const dir of [hereFolder, goneFolder, movedFolder, newFolder]) fs.mkdirSync(dir, { recursive: true });

// A provider at an address nobody answers: the rooms only have to open, never answer.
fs.writeFileSync(path.join(agentDir, "models.json"), JSON.stringify({
	providers: { "fake-claude": { name: "Fake Claude", baseUrl: "http://127.0.0.1:9", api: "anthropic-messages", models: [{ id: "claude-fake", name: "Claude Fake", input: ["text"], contextWindow: 200000, maxTokens: 32000 }] } },
}, null, 2), { mode: 0o600 });
fs.writeFileSync(path.join(agentDir, "auth.json"), JSON.stringify({ "fake-claude": { type: "api_key", key: "synthetic-claude" } }, null, 2), { mode: 0o600 });
fs.writeFileSync(path.join(appDir, "custom-ai-profiles.json"), JSON.stringify({ version: 1, profiles: [
	{ id: "custom-fake-claude", providerId: "fake-claude", label: "Fake Claude", roomModels: ["claude-fake"], learnModel: "claude-fake", reviewMemoryModel: "claude-fake" },
] }, null, 2), { mode: 0o600 });
fs.writeFileSync(path.join(appDir, "persistent-agent-ai-profile.json"), JSON.stringify({ profileId: "custom-fake-claude" }, null, 2), { mode: 0o600 });

const waitUntil = waitEvery(150, 15_000);

async function api(pathname: string, init: AuthedFetchInit = {}): Promise<{ status: number; body: any }> {
	const response = await authedFetch(`${baseUrl}${pathname}`, { ...init, headers: { ...(init.body ? { "content-type": "application/json" } : {}), ...init.headers } });
	const text = await response.text();
	return { status: response.status, body: text ? JSON.parse(text) : null };
}

async function createRoom(displayName: string, folder?: string): Promise<string> {
	const created = await api("/api/persistent-agents", { method: "POST", body: JSON.stringify({ displayName, userName: "Synthetic User", preferredUserAddress: "Synthetic User" }) });
	assert(created.status === 201, `${displayName} is created, got ${created.status}`);
	const agentId = String(created.body?.agent?.id ?? "");
	if (folder) {
		const saved = await api(`/api/persistent-agents/${encodeURIComponent(agentId)}/workspace-default`, { method: "PUT", body: JSON.stringify({ root: folder, workspaceAccessMode: "localFiles" }) });
		assert(saved.status === 200, `${displayName}'s folder is saved, got ${saved.status} ${JSON.stringify(saved.body)}`);
	}
	return agentId;
}

// Enters a room from Home and waits until the page has its folder answer, so
// "no line" is read after the page could have shown one.
async function enterRoom(page: Page, roomName: string, agentId: string): Promise<void> {
	await page.evaluate(() => { window.location.hash = "#/"; });
	const card = page.locator(".persistent-agent-card").filter({ hasText: roomName });
	await card.waitFor({ timeout: 10_000 });
	const answered = page.waitForResponse((response) => response.request().method() === "GET" && response.url().endsWith(`/api/persistent-agents/${encodeURIComponent(agentId)}/workspace-default`), { timeout: 15_000 });
	await card.getByRole("button", { name: /^(Enter|Resume)$/ }).click();
	await (await answered).finished();
	await settled(page);
}

// The page has applied an answer it has fully read: React renders it within the next frames.
async function settled(page: Page): Promise<void> {
	await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
}

async function closeSettings(page: Page): Promise<void> {
	await page.keyboard.press("Escape");
	await page.locator(".settings-dialog").first().waitFor({ state: "detached", timeout: 10_000 });
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
	await waitUntil(() => fetch(`${baseUrl}/healthz`).then((r) => r.ok).catch(() => false), "server ready", 60_000);

	const emptyDesk = await createRoom("Empty Desk");
	const hereDesk = await createRoom("Here Desk", hereFolder);
	const goneDesk = await createRoom("Gone Desk", goneFolder);
	const movedDesk = await createRoom("Moved Desk", movedFolder);
	fs.rmSync(goneFolder, { recursive: true, force: true });
	fs.rmSync(movedFolder, { recursive: true, force: true });

	const browser = await chromium.launch();
	try {
		const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
		const page = await context.newPage();
		await page.goto(`${baseUrl}/auth/session?token=${SMOKE_AUTH_TOKEN}`);
		await page.waitForLoadState("networkidle");
		const dismiss = page.locator(".whats-new-close");
		if (await dismiss.count()) await dismiss.click();
		const hint = page.locator(".room-workspace-nudge[role=note]");
		const hintText = hint.locator(".room-workspace-nudge-text");
		const hintButtons = () => hint.getByRole("button").allTextContents();

		// A room that never had a folder keeps the old nudge, with its Dismiss.
		await enterRoom(page, "Empty Desk", emptyDesk);
		await hintText.waitFor({ timeout: 10_000 });
		assert(await hintText.textContent() === NUDGE_LINE, `a room without a folder shows the nudge, got ${await hintText.textContent()}`);
		assert(JSON.stringify(await hintButtons()) === JSON.stringify(["Set workspace", "Dismiss"]), `the nudge keeps its two buttons, got ${JSON.stringify(await hintButtons())}`);
		console.log("  ok  a room without a folder shows the nudge");

		// A room whose folder exists shows neither, until the folder goes while the room is open.
		await enterRoom(page, "Here Desk", hereDesk);
		assert(await hint.count() === 0, `a room whose folder exists shows no folder hint, got ${await hint.allTextContents()}`);
		console.log("  ok  a room whose folder exists shows no hint");
		fs.rmSync(hereFolder, { recursive: true, force: true });
		await page.evaluate(() => window.dispatchEvent(new Event("focus")));
		await waitUntil(async () => (await hintText.textContent().catch(() => null)) === goneLine("still-here"), "a folder gone while its room is open is said on returning to the page");
		console.log("  ok  a folder gone while its room is open is said on returning to the page");

		// A room whose folder is gone names it, offers Choose folder alone, and the button opens Workspace.
		await enterRoom(page, "Gone Desk", goneDesk);
		await hintText.waitFor({ timeout: 10_000 });
		assert(await hintText.textContent() === goneLine("Quarterly Reports"), `a gone folder's room names the folder, got ${await hintText.textContent()}`);
		assert(JSON.stringify(await hintButtons()) === JSON.stringify(["Choose folder"]), `the line has one button and no Dismiss, got ${JSON.stringify(await hintButtons())}`);
		await hint.getByRole("button", { name: "Choose folder" }).click();
		await page.locator(".settings-dialog").first().waitFor({ timeout: 10_000 });
		const activePane = (await page.locator(".settings-dialog-nav-item.active").first().textContent())?.trim();
		assert(activePane === "Folder", `Choose folder opens Room settings at Folder, got ${activePane}`);
		await closeSettings(page);
		await hintText.waitFor({ timeout: 10_000 });
		assert(await hintText.textContent() === goneLine("Quarterly Reports"), "closing Room settings without a folder keeps the line");
		console.log("  ok  a gone folder's room names it, and Choose folder opens Workspace");

		// A re-check that fails keeps the line: the folder is still missing as far as the page knows.
		const workspaceRoute = "**/api/persistent-agents/*/workspace-default";
		await page.route(workspaceRoute, (route) => (route.request().method() === "GET" ? route.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ error: "Bad Request" }) }) : route.continue()));
		await hint.getByRole("button", { name: "Choose folder" }).click();
		await page.locator(".settings-dialog").first().waitFor({ timeout: 10_000 });
		const refused = page.waitForResponse((response) => response.request().method() === "GET" && response.url().endsWith(`/api/persistent-agents/${encodeURIComponent(goneDesk)}/workspace-default`) && response.status() === 500, { timeout: 15_000 });
		await closeSettings(page);
		await (await refused).finished();
		await settled(page);
		assert(await hintText.textContent().catch(() => null) === goneLine("Quarterly Reports"), `a failed re-check keeps the line, got ${await hint.allTextContents()}`);
		await page.unroute(workspaceRoute);
		console.log("  ok  a failed re-check keeps the line");

		// The folder is put back outside the page: returning to the page clears the line.
		fs.mkdirSync(goneFolder, { recursive: true });
		await page.evaluate(() => window.dispatchEvent(new Event("focus")));
		await waitUntil(async () => (await hint.count()) === 0, "the line leaves once the folder is back");
		console.log("  ok  the line leaves once the folder is back, without a reload");

		// Another folder chosen in Workspace clears the line once settings close.
		await enterRoom(page, "Moved Desk", movedDesk);
		await hintText.waitFor({ timeout: 10_000 });
		assert(await hintText.textContent() === goneLine("moved-away"), `the moved room names its folder, got ${await hintText.textContent()}`);
		await hint.getByRole("button", { name: "Choose folder" }).click();
		const pane = page.locator(".room-settings-section:not([hidden])");
		await pane.getByRole("button", { name: "Edit", exact: true }).click();
		await pane.getByLabel("Folder path").fill(newFolder);
		await pane.getByRole("button", { name: "Save changes" }).click();
		await pane.getByText("Saved.", { exact: true }).waitFor({ timeout: 10_000 });
		const rechecked = page.waitForResponse((response) => response.request().method() === "GET" && response.url().endsWith(`/api/persistent-agents/${encodeURIComponent(movedDesk)}/workspace-default`), { timeout: 15_000 });
		await closeSettings(page);
		await (await rechecked).finished();
		await waitUntil(async () => (await hint.count()) === 0, "the line leaves once another folder is chosen");
		console.log("  ok  the line leaves once another folder is chosen, without a reload");
		await context.close();
	} finally {
		await browser.close();
	}
	console.log("room-folder-gone-line-ui smoke: ok");
} catch (error) {
	console.error(serverOutput.join("").slice(-4000));
	throw error;
} finally {
	await stopSmokeServer(server);
	fs.rmSync(tempRoot, { recursive: true, force: true });
}
