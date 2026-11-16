// A room whose saved folder is gone from this computer says so above the
// composer, with the folder's name and one button, Choose folder, that opens
// Room settings at Workspace. The line has no Dismiss; it leaves by itself,
// without a reload, once the folder is back (on returning to the page) or
// another folder is chosen there; a re-check that fails keeps it. A folder
// that goes while its room is open is said on returning to the page. A room
// that never had a folder shows the no-folder line, whose Choose folder opens
// the computer's window and sets the room's own folder: a closed window leaves
// the line, a folder takes it away. A room whose folder exists shows neither.
// Offline: the room's model is never asked. Throwaway HOME.
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, type Page, type Route } from "playwright";
import { authedFetch, SMOKE_AUTH_TOKEN, SMOKE_SERVER_AUTH_ENV, SMOKE_SERVER_SPAWN_TREE_OPTIONS, smokeHomeEnv, stopSmokeServer, freePort, type AuthedFetchInit } from "./smoke-server-process.js";
import { waitEvery } from "./smoke-wait.js";
import { createHash } from "node:crypto";
import { CHOOSE_FOLDER, DISMISS, FOLDER_CHOOSE_FAILED, FOLDER_PICK_REFUSED, NO_FOLDER_LINE, ROOM_FOLDER_REFUSED_LINE, SAVED } from "../src/room-box/card-text.js";

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
const toolsFolder = path.join(projects, "tools");
// Folders no room may have as its own, by the Also allowed list's rule: home, inside ~/Library, a folder other programs run from, another tool's connector folder, a folder holding a closed place (~/.config holds ~/.config/gh).
const refusedFolders = [tempHome, path.join(tempHome, "Library", "Notes"), path.join(tempHome, ".local", "bin"), path.join(tempHome, ".cursor"), path.join(tempHome, ".config")];
for (const dir of [toolsFolder, ...refusedFolders]) fs.mkdirSync(dir, { recursive: true });
const firstFolder = path.join(projects, "first-home");
for (const dir of [hereFolder, goneFolder, movedFolder, newFolder, firstFolder]) fs.mkdirSync(dir, { recursive: true });

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
	const refusedDesk = await createRoom("Refused Desk", toolsFolder);
	// The pick: each refused folder is turned down before anything is saved; the room keeps its own.
	for (const folder of refusedFolders) {
		const saved = await api(`/api/persistent-agents/${encodeURIComponent(refusedDesk)}/workspace-default`, { method: "PUT", body: JSON.stringify({ root: folder, workspaceAccessMode: "localFiles" }) });
		assert(saved.status === 400, `${folder} is refused at the pick, got ${saved.status} ${JSON.stringify(saved.body)}`);
		const kept = await api(`/api/persistent-agents/${encodeURIComponent(refusedDesk)}/workspace-default`);
		assert(fs.realpathSync(String(kept.body?.policy?.roots?.[0]?.path ?? "")) === fs.realpathSync(toolsFolder) && kept.body?.folderRefused === false, `the room keeps its folder after ${folder} is refused, got ${JSON.stringify(kept.body?.policy?.roots)}`);
	}
	const homeOnly = (await api(`/api/persistent-agents/${encodeURIComponent(refusedDesk)}/workspace-default`, { method: "PUT", body: JSON.stringify({ root: path.join(tempHome, ".local", "bin"), workspaceAccessMode: "localFiles" }) })).body;
	assert(homeOnly?.code === "folder_refused" && homeOnly?.error === FOLDER_PICK_REFUSED, `a program folder is refused with the pick's line, got ${JSON.stringify(homeOnly)}`);
	console.log("  ok  the pick refuses home, ~/Library, ~/.local/bin, ~/.cursor and ~/.config, and the room keeps its folder");
	// A stored room on one, as an older room's folder was saved before the rule: the file names ~/.local/bin, its hash matching.
	const storedFile = path.join(agentsRoot, refusedDesk, "runtime", "workspace-default.json");
	const stored = JSON.parse(fs.readFileSync(storedFile, "utf8"));
	const programs = fs.realpathSync(path.join(tempHome, ".local", "bin"));
	stored.roots[0] = { ...stored.roots[0], path: programs, realpath: programs, basename: "bin", displayLabel: "bin", pathHash: { algorithm: "sha256", value: createHash("sha256").update(programs, "utf-8").digest("hex") } };
	fs.writeFileSync(storedFile, JSON.stringify(stored, null, 2));
	assert((await api(`/api/persistent-agents/${encodeURIComponent(refusedDesk)}/workspace-default`)).body?.folderRefused === true, "a stored room on ~/.local/bin reads as refused");
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
		// A button's name: the cross's is its label, the others' their words.
		const hintButtons = () => hint.getByRole("button").evaluateAll((buttons) => buttons.map((button) => button.getAttribute("aria-label") ?? button.textContent));

		// A room that never had a folder shows the no-folder line, with Choose folder and Dismiss.
		await enterRoom(page, "Empty Desk", emptyDesk);
		await hintText.waitFor({ timeout: 10_000 });
		assert(await hintText.textContent() === NO_FOLDER_LINE, `a room without a folder shows the no-folder line, got ${await hintText.textContent()}`);
		assert(JSON.stringify(await hintButtons()) === JSON.stringify([CHOOSE_FOLDER, DISMISS]), `the line has Choose folder and Dismiss, got ${JSON.stringify(await hintButtons())}`);
		console.log("  ok  a room without a folder shows the no-folder line");

		// Choose folder opens the computer's window: closed with no folder, the line stays and the room has none.
		const chooser = "**/api/system/choose-folder";
		await page.route(chooser, (route) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ supported: true, cancelled: true, path: null }) }));
		const cancelled = page.waitForResponse((response) => response.url().endsWith("/api/system/choose-folder"), { timeout: 15_000 });
		await hint.getByRole("button", { name: CHOOSE_FOLDER }).click();
		await (await cancelled).finished();
		await settled(page);
		await waitUntil(async () => await hint.getByRole("button", { name: CHOOSE_FOLDER }).isEnabled(), "the button is back after the window closed");
		assert(await hintText.textContent() === NO_FOLDER_LINE, "a window closed with no folder keeps the line");
		assert((await api(`/api/persistent-agents/${encodeURIComponent(emptyDesk)}/workspace-default`)).body?.policy === null, "a window closed with no folder sets nothing");
		await page.unroute(chooser);
		console.log("  ok  Choose folder: a window closed with no folder keeps the line and sets nothing");

		// A folder from the window becomes the room's own folder, and the line goes without a reload.
		await page.route(chooser, (route) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ supported: true, cancelled: false, path: firstFolder }) }));
		await hint.getByRole("button", { name: CHOOSE_FOLDER }).click();
		await waitUntil(async () => (await hint.count()) === 0, "the line leaves once the window gave a folder");
		const chosen = await api(`/api/persistent-agents/${encodeURIComponent(emptyDesk)}/workspace-default`);
		assert(fs.realpathSync(String(chosen.body?.policy?.roots?.[0]?.path ?? "")) === fs.realpathSync(firstFolder), `the folder from the window is the room's own folder, got ${JSON.stringify(chosen.body?.policy?.roots)}`);
		await page.unroute(chooser);
		console.log("  ok  Choose folder: the folder from the window is the room's own folder, and the line leaves");

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
		// The computer's folder window, stood in for: it returns the new folder, which saves on the pick.
		await page.route("**/api/system/choose-folder", (route) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ supported: true, cancelled: false, path: newFolder }) }));
		try {
			await pane.locator(".folder-pane-location").getByRole("button", { name: CHOOSE_FOLDER }).click();
			// The pick saved: a screen reader hears it, as no row shows Saved.
			await waitUntil(async () => (await pane.locator(".room-workspace-section > .sr-only[role=status]").textContent()) === SAVED, "the new folder saved");
		} finally {
			await page.unroute("**/api/system/choose-folder");
		}
		const rechecked = page.waitForResponse((response) => response.request().method() === "GET" && response.url().endsWith(`/api/persistent-agents/${encodeURIComponent(movedDesk)}/workspace-default`), { timeout: 15_000 });
		await closeSettings(page);
		await (await rechecked).finished();
		await waitUntil(async () => (await hint.count()) === 0, "the line leaves once another folder is chosen");
		console.log("  ok  the line leaves once another folder is chosen, without a reload");
		// A stored room on a folder no room may use says so, with Choose folder alone, which opens Folder.
		await enterRoom(page, "Refused Desk", refusedDesk);
		await hintText.waitFor({ timeout: 10_000 });
		assert(await hintText.textContent() === ROOM_FOLDER_REFUSED_LINE, `a stored room on a refused folder shows its line, got ${await hintText.textContent()}`);
		assert(JSON.stringify(await hintButtons()) === JSON.stringify(["Choose folder"]), `the refused folder's line has one button and no Dismiss, got ${JSON.stringify(await hintButtons())}`);
		await hint.getByRole("button", { name: "Choose folder" }).click();
		await page.locator(".settings-dialog").first().waitFor({ timeout: 10_000 });
		assert((await page.locator(".settings-dialog-nav-item.active").first().textContent())?.trim() === "Folder", "Choose folder on the refused folder's line opens Folder");
		await closeSettings(page);
		console.log("  ok  a stored room on a refused folder shows its line, and Choose folder opens Folder");

		// The no-folder line's Choose folder: a refused pick says so and sets nothing.
		const noFolderDesk = await createRoom("Second Empty Desk");
		await enterRoom(page, "Second Empty Desk", noFolderDesk);
		await hintText.waitFor({ timeout: 10_000 });
		await page.route("**/api/system/choose-folder", (route) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ supported: true, cancelled: false, path: path.join(tempHome, ".cursor") }) }));
		await hint.getByRole("button", { name: CHOOSE_FOLDER }).click();
		await hint.getByRole("alert").waitFor({ timeout: 10_000 });
		assert(await hint.getByRole("alert").textContent() === FOLDER_PICK_REFUSED, `a refused pick on the no-folder line says so, got ${await hint.getByRole("alert").textContent()}`);
		assert(await hintText.textContent() === FOLDER_PICK_REFUSED, `the refusal stands in place of the no-folder sentence, got ${await hintText.textContent()}`);
		assert((await api(`/api/persistent-agents/${encodeURIComponent(noFolderDesk)}/workspace-default`)).body?.policy === null, "a refused pick sets nothing");
		await page.unroute("**/api/system/choose-folder");
		console.log("  ok  a refused pick on the no-folder line says so and sets nothing");

		// A window that failed says so on the line and the button works again; only a computer with no folder window opens Folder settings.
		const failingDesk = await createRoom("Third Empty Desk");
		const otherDesk = await createRoom("Fourth Empty Desk");
		await enterRoom(page, "Third Empty Desk", failingDesk);
		await hintText.waitFor({ timeout: 10_000 });
		await page.route(chooser, (route) => route.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ error: "Folder chooser failed. Enter the path manually.", code: "choose_folder_failed", supported: true, cancelled: false }) }));
		await hint.getByRole("button", { name: CHOOSE_FOLDER }).click();
		await hint.getByRole("alert").waitFor({ timeout: 10_000 });
		assert(await hint.getByRole("alert").textContent() === FOLDER_CHOOSE_FAILED, `a failed window says so on the line, got ${await hint.getByRole("alert").textContent()}`);
		assert(await hint.getByRole("button", { name: CHOOSE_FOLDER }).isEnabled(), "after a failed window the button works again");
		assert(await page.locator(".settings-dialog").count() === 0, "a failed window stays in the chat");
		await page.unroute(chooser);
		await page.route(chooser, (route) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ supported: true, cancelled: true, path: null }) }));
		const closedAgain = page.waitForResponse((response) => response.url().endsWith("/api/system/choose-folder"), { timeout: 15_000 });
		await hint.getByRole("button", { name: CHOOSE_FOLDER }).click();
		await (await closedAgain).finished();
		await settled(page);
		await waitUntil(async () => await hint.getByRole("button", { name: CHOOSE_FOLDER }).isEnabled(), "the button is back after the window closed");
		assert(await hintText.textContent() === NO_FOLDER_LINE && await hint.getByRole("alert").count() === 0, `a window closed with no folder shows nothing, got ${await hintText.textContent()}`);
		await page.unroute(chooser);
		console.log("  ok  a failed window says so on the no-folder line and the button works again; a closed one shows nothing");

		for (const [status, code] of [[501, "unsupported_platform"], [503, "folder_chooser_unavailable"]] as const) {
			await page.route(chooser, (route) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify({ error: "No folder window here.", code, supported: false, cancelled: false }) }));
			await hint.getByRole("button", { name: CHOOSE_FOLDER }).click();
			await page.locator(".settings-dialog").first().waitFor({ timeout: 10_000 });
			assert((await page.locator(".settings-dialog-nav-item.active").first().textContent())?.trim() === "Folder", `no folder window (${code}) opens Folder settings`);
			await closeSettings(page);
			await page.unroute(chooser);
		}
		console.log("  ok  a computer with no folder window still opens Folder settings");

		// A window open for one room holds only that room: in another room the button works and no sentence shows, leaving closed the window, and its late answer changes nothing.
		let held: Route | undefined;
		await page.route(chooser, (route) => { held = route; });
		const pickGone = page.waitForEvent("requestfailed", { predicate: (request) => request.url().endsWith("/api/system/choose-folder"), timeout: 15_000 });
		// Read below; a row that fails first must not leave it to fail unheard.
		pickGone.catch(() => {});
		await hint.getByRole("button", { name: CHOOSE_FOLDER }).click();
		await waitUntil(() => held !== undefined, "the window is open for the third room");
		assert(await hint.getByRole("button", { name: CHOOSE_FOLDER }).isDisabled(), "the button waits while its room's window is open");
		await enterRoom(page, "Fourth Empty Desk", otherDesk);
		await hintText.waitFor({ timeout: 10_000 });
		assert(await hint.getByRole("button", { name: CHOOSE_FOLDER }).isEnabled(), "another room's button works while the first room's window was open");
		assert(await hintText.textContent() === NO_FOLDER_LINE && await hint.getByRole("alert").count() === 0, `another room shows no sentence, got ${await hintText.textContent()}`);
		await pickGone;
		console.log("  ok  with a window open in one room, another room's button works and shows no sentence, and leaving closed the first room's window");

		await held?.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ error: "Folder chooser failed. Enter the path manually.", code: "choose_folder_failed", supported: true, cancelled: false }) }).catch(() => {});
		await settled(page);
		assert(await hintText.textContent() === NO_FOLDER_LINE && await hint.getByRole("alert").count() === 0, `a late failure from the first room changes nothing here, got ${await hintText.textContent()}`);
		assert(await hint.getByRole("button", { name: CHOOSE_FOLDER }).isEnabled() && await page.locator(".settings-dialog").count() === 0, "a late failure from the first room holds no button and opens nothing");
		await page.unroute(chooser);
		await enterRoom(page, "Third Empty Desk", failingDesk);
		await hintText.waitFor({ timeout: 10_000 });
		assert(await hintText.textContent() === NO_FOLDER_LINE && await hint.getByRole("button", { name: CHOOSE_FOLDER }).isEnabled(), `back in the first room, the line is as it was, got ${await hintText.textContent()}`);
		console.log("  ok  a failure that arrives after the move changes nothing in the other room");

		// The window's pick came back in the first room; its save fails once the person is in the other room: the other room's line stays as it is.
		let heldSave: Route | undefined;
		const saveRoute = "**/api/persistent-agents/*/workspace-default";
		await page.route(saveRoute, (route) => (route.request().method() === "PUT" ? void (heldSave = route) : route.continue()));
		await page.route(chooser, (route) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ supported: true, cancelled: false, path: firstFolder }) }));
		await hint.getByRole("button", { name: CHOOSE_FOLDER }).click();
		await waitUntil(() => heldSave !== undefined, "the pick's save is on its way");
		await enterRoom(page, "Fourth Empty Desk", otherDesk);
		await hintText.waitFor({ timeout: 10_000 });
		assert(await hintText.textContent() === NO_FOLDER_LINE && await hint.getByRole("button", { name: CHOOSE_FOLDER }).isEnabled(), "the other room's line is its own while the first room's save waits");
		// Back in the first room, a newer press opens the window again; the old save's failure must not touch it.
		await enterRoom(page, "Third Empty Desk", failingDesk);
		await hintText.waitFor({ timeout: 10_000 });
		await page.unroute(chooser);
		let heldAgain: Route | undefined;
		await page.route(chooser, (route) => { heldAgain = route; });
		await hint.getByRole("button", { name: CHOOSE_FOLDER }).click();
		await waitUntil(() => heldAgain !== undefined, "the newer press opened the window");
		const saveAnswered = page.waitForResponse((response) => response.request().method() === "PUT" && response.url().includes("/workspace-default"), { timeout: 15_000 });
		await heldSave?.fulfill({ status: 400, contentType: "application/json", body: JSON.stringify({ error: FOLDER_PICK_REFUSED, code: "folder_refused" }) });
		await (await saveAnswered).finished();
		await settled(page);
		assert(await hint.getByRole("button", { name: CHOOSE_FOLDER }).isDisabled() && await hint.getByRole("alert").count() === 0, `an older press's failed save leaves the newer press's window as it is, got ${await hintText.textContent()}`);
		await heldAgain?.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ supported: true, cancelled: true, path: null }) });
		await waitUntil(async () => await hint.getByRole("button", { name: CHOOSE_FOLDER }).isEnabled(), "the newer press's window closed");
		await page.unroute(chooser);
		await page.unroute(saveRoute);
		console.log("  ok  a save that fails after the move, or after a newer press, changes nothing");
		await context.close();

		// A page away from the computer has no folder window: Choose folder opens Folder settings, which says where the folder is changed, never the failure sentence.
		const away = await browser.newContext({ viewport: { width: 1280, height: 900 } });
		await away.route("**/api/remote/client-context", (route) => route.fulfill({ contentType: "application/json", body: JSON.stringify({ remote: true, capability: "full", sharedServer: false }) }));
		const awayPage = await away.newPage();
		await awayPage.goto(`${baseUrl}/auth/session?token=${SMOKE_AUTH_TOKEN}`);
		await awayPage.waitForLoadState("networkidle");
		if (await awayPage.locator(".whats-new-close").count()) await awayPage.locator(".whats-new-close").click();
		await awayPage.route(chooser, (route) => route.fulfill({ status: 403, contentType: "application/json", body: JSON.stringify({ error: "This action is only available on the computer running Exxperts.", code: "remote_local_only" }) }));
		await enterRoom(awayPage, "Fourth Empty Desk", otherDesk);
		const awayHint = awayPage.locator(".room-workspace-nudge[role=note]");
		await awayHint.locator(".room-workspace-nudge-text").waitFor({ timeout: 10_000 });
		await awayHint.getByRole("button", { name: CHOOSE_FOLDER }).click();
		await awayPage.locator(".settings-dialog").first().waitFor({ timeout: 10_000 });
		assert((await awayPage.locator(".settings-dialog-nav-item.active").first().textContent())?.trim() === "Folder", "a page away from the computer opens Folder settings");
		assert(await awayHint.getByRole("alert").count() === 0, "a page away from the computer shows no failure sentence");
		await away.close();
		console.log("  ok  a page away from the computer opens Folder settings, as before");
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
