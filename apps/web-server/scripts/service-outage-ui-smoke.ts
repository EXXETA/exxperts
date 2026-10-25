// The app's own server stops for longer than the lost-connection banner waits,
// then starts again, with Home, three Settings tabs, Settings over an open room,
// a room being archived and a room's Model pane in their own pages. While it is
// down: Home's banner speaks for the outage, and Home's strip adds no second
// sentence for it; a room left on the way says the sentence alone, and an
// archive that got no answer keeps "… was NOT deleted." beside the banner;
// Settings, AI setup cannot read its default models and says so in the service
// sentence, never "Choose a model"; its Sign out and Add provider, Skills,
// Connectors and the room's Model pane say the same sentence. Once each page
// reconnects (a room's on its own ladder): AI setup reads its defaults again
// and names them, Skills and Connectors read their lists, the Model pane reads
// its models on Try again, the archive's line still says what did not happen,
// and no line still says the service could not be reached.
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, type BrowserContext, type Page } from "playwright";
import { SMOKE_AUTH_TOKEN, SMOKE_SERVER_AUTH_ENV, SMOKE_SERVER_SPAWN_TREE_OPTIONS, smokeHomeEnv, stopSmokeServer, freePort } from "./smoke-server-process.js";

{
	const p = typeof chromium?.executablePath === "function" ? chromium.executablePath() : "";
	if (!p || !fs.existsSync(p)) {
		console.log("service outage smoke skipped (Chromium not installed)");
		process.exit(0);
	}
}

const SENTENCE = "exxperts could not reach its own service just now. Try again; if it repeats, restart exxperts.";
const MODEL_NAME = "Claude Fake";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const webServerDir = path.resolve(scriptDir, "..");
const repoRoot = path.resolve(webServerDir, "..", "..");
const port = await freePort();
const baseUrl = `http://127.0.0.1:${port}`;

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "exxperts-service-outage-"));
const tempHome = path.join(tempRoot, "home");
const agentsRoot = path.join(tempHome, ".exxperts", "app", "personalized-agents");
const agentDir = path.join(tempHome, ".exxperts", "agent");
const appDir = path.join(tempHome, ".exxperts", "app");
for (const dir of [agentsRoot, agentDir]) fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
process.env.HOME = tempHome;
process.env.USERPROFILE = tempHome;
process.env.EXXPERTS_CODING_AGENT_DIR = agentDir;
process.env.EXXETA_PERSISTENT_AGENTS_ROOT = agentsRoot;

async function waitUntil(predicate: () => Promise<boolean> | boolean, label: string, timeoutMs = 25_000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (await predicate()) return;
		await new Promise((resolve) => setTimeout(resolve, 150));
	}
	throw new Error(`timed out waiting until ${label}`);
}

let server: ChildProcessWithoutNullStreams | undefined;
const serverOutput: string[] = [];

async function startServer(): Promise<void> {
	server = spawn("npx", ["tsx", "src/index.ts"], {
		shell: process.platform === "win32",
		...SMOKE_SERVER_SPAWN_TREE_OPTIONS,
		cwd: webServerDir,
		env: smokeHomeEnv(tempHome, { PORT: String(port), ...SMOKE_SERVER_AUTH_ENV, EXXETA_HOME: repoRoot, EXXPERTS_CODING_AGENT_DIR: agentDir, EXXETA_PERSISTENT_AGENTS_ROOT: agentsRoot }) as NodeJS.ProcessEnv,
	});
	server.stdout.on("data", (chunk) => serverOutput.push(String(chunk)));
	server.stderr.on("data", (chunk) => serverOutput.push(String(chunk)));
	await waitUntil(() => fetch(`${baseUrl}/healthz`).then((r) => r.ok).catch(() => false), "server ready", 60_000);
}

async function openPage(ctx: BrowserContext): Promise<Page> {
	const page = await ctx.newPage();
	await page.goto(`${baseUrl}/auth/session?token=${SMOKE_AUTH_TOKEN}`);
	await page.waitForLoadState("networkidle");
	const dismiss = page.locator(".whats-new-close");
	if (await dismiss.count()) await dismiss.click();
	return page;
}

async function openSettings(page: Page, tab: string): Promise<void> {
	if (!(await page.locator(".settings-overlay").count())) {
		await page.locator(".product-sidebar-footer button").first().click();
		await page.locator(".sidebar-config-menu button, .sidebar-config-menu a").filter({ hasText: /Settings/ }).first().click();
		await page.waitForSelector(".settings-overlay", { timeout: 10_000 });
	}
	await page.locator(".settings-dialog-nav button").filter({ hasText: tab }).first().click();
}

const flat = (text: string) => text.replace(/\s+/g, " ").trim();
const paneText = async (page: Page) => flat(await page.locator(".settings-overlay .settings-dialog-pane").innerText());
const defaultsText = async (page: Page) => flat(await page.locator(".settings-overlay .ai-defaults-group").innerText());
const defaultNames = (page: Page) => page.locator(".settings-overlay .ai-defaults-group .room-model-pick-name").allInnerTexts();
const namesBoth = async (page: Page) => JSON.stringify(await defaultNames(page)) === JSON.stringify([MODEL_NAME, MODEL_NAME]);

try {
	// A provider at an address nobody answers: its model only has to be offered, never asked.
	fs.writeFileSync(path.join(agentDir, "models.json"), JSON.stringify({
		providers: { "fake-claude": { name: "Fake Claude", baseUrl: "http://127.0.0.1:9", api: "anthropic-messages", models: [{ id: "claude-fake", name: MODEL_NAME, input: ["text"], contextWindow: 200000, maxTokens: 32000 }] } },
	}, null, 2), { mode: 0o600 });
	fs.writeFileSync(path.join(agentDir, "auth.json"), JSON.stringify({ "fake-claude": { type: "api_key", key: "synthetic-claude" } }, null, 2), { mode: 0o600 });
	fs.writeFileSync(path.join(appDir, "custom-ai-profiles.json"), JSON.stringify({ version: 1, profiles: [
		{ id: "custom-fake-claude", providerId: "fake-claude", label: "Fake Claude", roomModels: ["claude-fake"], learnModel: "claude-fake", reviewMemoryModel: "claude-fake" },
	] }, null, 2), { mode: 0o600 });
	fs.writeFileSync(path.join(appDir, "persistent-agent-ai-profile.json"), JSON.stringify({ profileId: "custom-fake-claude" }, null, 2), { mode: 0o600 });
	const agents = await import("../src/persistent-agents.js");
	const roomModels = await import("../src/room-models.js");
	const agentId = agents.createPersistentAgentFromScaffoldInput({ displayName: "Strip Room", userName: "Synthetic User", preferredUserAddress: "Synthetic User" }).agent.agentId;
	roomModels.writeRoomModels(agentId, { conversation: { provider: "fake-claude", model: "claude-fake" } });
	for (const displayName of ["Leave Room", "Archive Room", "Model Room"]) {
		const id = agents.createPersistentAgentFromScaffoldInput({ displayName, userName: "Synthetic User", preferredUserAddress: "Synthetic User" }).agent.agentId;
		roomModels.writeRoomModels(id, { conversation: { provider: "fake-claude", model: "claude-fake" } });
	}
	roomModels.writeAiDefaults({ conversation: { provider: "fake-claude", model: "claude-fake" }, memory: { provider: "fake-claude", model: "claude-fake" } });
	await startServer();

	const browser = await chromium.launch();
	try {
		const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
		const failures: string[] = [];
		const enterRoom = async (page: Page, name: string) => {
			await page.locator(".persistent-agent-card").filter({ hasText: name }).getByRole("button", { name: /^(Enter|Resume) →$/ }).click();
			await page.locator("textarea").first().waitFor({ timeout: 20_000 });
		};
		const openRoomSettings = async (page: Page, pane: string) => {
			if (!(await page.locator(".rs-shell").count())) await page.getByRole("button", { name: "Room settings" }).click();
			await page.locator(".settings-dialog-nav-item").filter({ hasText: pane }).first().click();
			return page.locator(".room-settings-section:not([hidden])");
		};
		// Home first sits in a room, which it leaves during the outage.
		const home = await openPage(ctx);
		await enterRoom(home, "Leave Room");
		// The Settings pages wait on another tab, so the tabs under test first read during the outage.
		const aiSetup = await openPage(ctx);
		await openSettings(aiSetup, "AI setup");
		await waitUntil(() => namesBoth(aiSetup), "AI setup names both default models before the outage", 15_000).catch(async (error) => {
			throw new Error(`${(error as Error).message}; they read ${JSON.stringify(await defaultNames(aiSetup))}`);
		});
		await openSettings(aiSetup, "Web search");
		const skills = await openPage(ctx);
		await openSettings(skills, "Web search");
		const connectors = await openPage(ctx);
		await openSettings(connectors, "Web search");
		const room = await openPage(ctx);
		await room.locator(".persistent-agent-card").filter({ hasText: "Strip Room" }).getByRole("button", { name: /^(Enter|Resume) →$/ }).click();
		await room.locator("textarea").first().waitFor({ timeout: 20_000 });
		await room.keyboard.press("ControlOrMeta+Comma");
		await room.waitForSelector(".settings-overlay", { timeout: 10_000 });
		await openSettings(room, "Web search");
		// The tabs that read a list on opening: on their own, and Skills over the room.
		const lists = [
			{ page: skills, tab: "Skills", where: "Skills", loaded: "No skills yet" },
			{ page: room, tab: "Skills", where: "Skills over the room", loaded: "No skills yet" },
			{ page: connectors, tab: "Connectors", where: "Connectors", loaded: "No connectors yet" },
		];
		const archiver = await openPage(ctx);
		await enterRoom(archiver, "Archive Room");
		await openRoomSettings(archiver, "Archive or delete");
		const modeler = await openPage(ctx);
		await enterRoom(modeler, "Model Room");

		await stopSmokeServer(server);
		server = undefined;

		// Home: the room is left with no answer to its save, then a room's door gets
		// none either, then the banner comes for the same outage.
		const strip = (page: Page) => page.locator(".home-resume-error");
		const stripText = async (page: Page) => ((await strip(page).count()) ? flat(await strip(page).first().innerText()) : "(no strip)");
		await home.goBack();
		await strip(home).waitFor({ timeout: 15_000 });
		if ((await stripText(home)) !== SENTENCE) failures.push(`a room left with no answer to its save: the strip reads "${await stripText(home)}", not the sentence alone`);
		await home.locator(".persistent-agent-card").filter({ hasText: "Strip Room" }).getByRole("button", { name: /^(Enter|Resume) →$/ }).click();
		const sentenceStrip = strip(home).filter({ hasText: SENTENCE });
		await sentenceStrip.waitFor({ timeout: 15_000 });
		const banner = home.locator(".connection-lost-banner");
		await banner.waitFor({ timeout: 45_000 });
		await home.waitForTimeout(300);
		if ((await sentenceStrip.count()) > 0) failures.push("while the lost-connection banner shows, Home's strip still says the service sentence");

		// A room archived from inside it gets no answer: what did not happen stays beside the banner.
		const NOT_DELETED = "Archive Room was NOT deleted.";
		await archiver.locator(".room-settings-section:not([hidden])").getByRole("button", { name: "Archive", exact: true }).click();
		await strip(archiver).filter({ hasText: "Archive Room was NOT deleted" }).waitFor({ timeout: 15_000 });
		await archiver.locator(".connection-lost-banner").waitFor({ timeout: 45_000 });
		await archiver.waitForTimeout(300);
		if ((await stripText(archiver)) !== NOT_DELETED) failures.push(`while the banner shows, the archive's strip reads "${await stripText(archiver)}", not "${NOT_DELETED}"`);

		// A room's Model pane opened during the outage says why it has no models to offer.
		const modelPane = await openRoomSettings(modeler, "Model");
		const conversationPick = modelPane.locator(".room-model-row").first().locator(".room-model-pick");
		try {
			await waitUntil(async () => flat(await modelPane.innerText()).includes(SENTENCE) && (await modelPane.getByRole("button", { name: "Try again" }).count()) === 1, "the Model pane says the sentence beside Try again", 15_000);
		} catch (error) {
			failures.push(`${(error as Error).message}; it reads "${flat(await modelPane.innerText()).slice(0, 300)}"`);
		}
		if (await conversationPick.isEnabled()) failures.push("with no models read, the Model pane still opens a picker that has none to offer");

		// AI setup, read during the outage.
		await openSettings(aiSetup, "AI setup");
		try {
			await waitUntil(async () => (await defaultsText(aiSetup)).includes(SENTENCE), "the default models say the service sentence", 15_000);
		} catch (error) {
			failures.push(`${(error as Error).message}; they read "${await defaultsText(aiSetup)}"`);
		}
		if ((await defaultsText(aiSetup)).includes("Choose a model")) failures.push(`with the defaults unread, the default models say "Choose a model": "${await defaultsText(aiSetup)}"`);
		await aiSetup.getByRole("button", { name: "Manage Fake Claude" }).click();
		await aiSetup.getByRole("menuitem", { name: "Sign out" }).click();
		const signOutLine = aiSetup.locator(".ai-profile-switcher-section .checkpoint-proposal-error").filter({ hasText: SENTENCE });
		await signOutLine.waitFor({ timeout: 15_000 });
		await aiSetup.getByRole("button", { name: "Add provider" }).click();
		const addProviderLine = aiSetup.locator(".add-provider-block .checkpoint-proposal-error").filter({ hasText: SENTENCE });
		await addProviderLine.waitFor({ timeout: 15_000 });

		// The lists, read during the outage.
		for (const { page, tab, where } of lists) {
			await openSettings(page, tab);
			await waitUntil(async () => (await paneText(page)).includes(SENTENCE), `${where} says the service sentence`, 15_000);
		}

		// The server starts again; each page reconnects on its own ladder.
		await startServer();
		try {
			await waitUntil(async () => (await banner.count()) === 0, "Home's banner goes once the page reconnects", 45_000);
		} catch (error) {
			failures.push((error as Error).message);
		}
		if ((await strip(home).count()) > 0) failures.push(`after the reconnect Home's strip reads "${await stripText(home)}"`);
		try {
			await waitUntil(async () => (await archiver.locator(".connection-lost-banner").count()) === 0, "the archive's page reconnects", 45_000);
			await archiver.waitForTimeout(300);
			if ((await stripText(archiver)) !== NOT_DELETED) failures.push(`after the reconnect the archive's strip reads "${await stripText(archiver)}", not "${NOT_DELETED}"`);
		} catch (error) {
			failures.push((error as Error).message);
		}
		try {
			await modelPane.getByRole("button", { name: "Try again" }).click({ timeout: 5_000 });
			await waitUntil(async () => !flat(await modelPane.innerText()).includes(SENTENCE) && (await conversationPick.isEnabled()), "the Model pane reads its models on Try again", 30_000);
			await conversationPick.click();
			await modeler.locator(".room-model-option").filter({ hasText: MODEL_NAME }).first().waitFor({ timeout: 10_000 });
			await modeler.keyboard.press("Escape");
		} catch (error) {
			failures.push(`${(error as Error).message}; it reads "${flat(await modelPane.innerText()).slice(0, 300)}"`);
		}
		try {
			await waitUntil(async () => !(await paneText(aiSetup)).includes(SENTENCE) && (await namesBoth(aiSetup)), "AI setup reads its defaults again and no line says the service sentence", 45_000);
		} catch (error) {
			failures.push(`${(error as Error).message}; the defaults read "${await defaultsText(aiSetup)}", and the pane ${(await paneText(aiSetup)).split(SENTENCE).length - 1} time(s) says the service sentence`);
		}
		for (const { page, where, loaded } of lists) {
			try {
				await waitUntil(async () => { const text = await paneText(page); return !text.includes(SENTENCE) && text.includes(loaded); }, `${where} reads its list again and no line says the service sentence`, 45_000);
			} catch (error) {
				failures.push(`${(error as Error).message}; it reads "${(await paneText(page)).slice(0, 300)}"`);
			}
		}
		if (failures.length > 0) throw new Error(`service outage:\n  ${failures.join("\n  ")}`);
		await ctx.close();
	} finally {
		await browser.close();
	}
	console.log("service-outage-ui smoke: ok");
} catch (error) {
	console.error(serverOutput.join("").slice(-4000));
	throw error;
} finally {
	await stopSmokeServer(server);
	fs.rmSync(tempRoot, { recursive: true, force: true });
}
