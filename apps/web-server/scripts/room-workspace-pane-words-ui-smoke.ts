// Room settings' Folder pane, and the Skills pane's files line, say what the
// room really has, in the page against a real server: the pane shows Location,
// Can change files, Commands, the protection row and Also allowed, and none of
// the old Access, tools, Bash, Edit or Save; an older Bounded room reads with
// commands off; a room whose own list had no Read reads with no folder; a long
// folder name stays inside the pane; a folder that is gone says so, by name;
// the cross asks before the room stops using its folder; a failed load offers
// Try again; an allowed skill's files say they run only while the room's
// commands are on, and on a shared server that they never run; a folder's
// refusal shows under Location, a switch's beside the switch, a wait muted and
// a failure in red; while the room answers every control is greyed with the
// reason above them, in the room and from Home, and a change the server
// refuses for an answer the page had not seen greys them too; a greyed control
// carries its reason for a screen reader. On this computer Location shows the
// folder's full path, wrapped inside the row on a narrow screen, and the name
// does not repeat beside it; a remote device shows the name alone. A reload
// asks nothing: each change has saved on its click.
// Offline: a synthetic model on this machine that holds an answer until the
// smoke lets it finish. Throwaway HOME.
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, type Locator, type Page } from "playwright";
import { authedFetch, SMOKE_AUTH_HEADERS, SMOKE_AUTH_TOKEN, SMOKE_SERVER_AUTH_ENV, SMOKE_SERVER_SPAWN_TREE_OPTIONS, smokeHomeEnv, stopSmokeServer, freePort, type AuthedFetchInit } from "./smoke-server-process.js";
import { sha256, writeSkillProvenance } from "../src/skills-store.js";
import { waitEvery } from "./smoke-wait.js";
import { CAN_CHANGE_FILES, CHANGE_SAVE_FAILED, CHANGE_FOLDER, CHANGEABLE_AT_COMPUTER, CHOOSE_FOLDER, COMMANDS, FOLDER_LOAD_FAILED, FOLDER_NOT_FOUND, FOLDER_REMOVED, LOCATION, NO_FOLDER_LINE, NO_FOLDER_YET_LINE, NOT_FOUND, PROTECTION, ROOM_ANSWERING_CHANGE_LINE, STOP_USING, STOP_USING_FOLDER, STOP_USING_FOLDER_BODY, stopUsingFolderTitle, TRY_AGAIN } from "../src/room-box/card-text.js";
import { closeBrowser, closeContext } from "./smoke-close-context.js";

function assert(condition: unknown, message: string): asserts condition {
	if (!condition) throw new Error(message);
}

{
	const p = typeof chromium?.executablePath === "function" ? chromium.executablePath() : "";
	if (!p || !fs.existsSync(p)) {
		console.log("room workspace pane words smoke skipped (Chromium not installed)");
		process.exit(0);
	}
}

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const webServerDir = path.resolve(scriptDir, "..");
const repoRoot = path.resolve(webServerDir, "..", "..");
const port = await freePort();
const baseUrl = `http://127.0.0.1:${port}`;

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "exxperts-workspace-pane-"));
const tempHome = path.join(tempRoot, "home");
const agentsRoot = path.join(tempHome, ".exxperts", "app", "personalized-agents");
const agentDir = path.join(tempHome, ".exxperts", "agent");
for (const dir of [agentsRoot, agentDir]) fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
const projects = path.join(tempHome, "Projects");
const demo = path.join(projects, "demo");
const longFolder = path.join(projects, "Präsentationen und Angebote für das dritte Quartal データ und noch viel mehr");
const goneFolder = path.join(projects, "gone-soon");
const deepFolder = path.join(projects, "Kunden und Partner", "Angebote für das dritte Quartal", "Entwürfe_ohne_Leerzeichen_und_mit_einem_sehr_langen_Namen");
for (const dir of [demo, longFolder, goneFolder, deepFolder]) fs.mkdirSync(dir, { recursive: true });
const appDir = path.join(tempHome, ".exxperts", "app");

// The room's model: it answers each message at once, or, while `holding` is
// set, starts the answer and holds it until letAnswersFinish().
let holding = false;
const heldAnswers: Array<() => void> = [];
let modelCalls = 0;
const gateway = http.createServer((req, res) => {
	if (req.method !== "POST" || !String(req.url ?? "").endsWith("/chat/completions")) {
		res.writeHead(404).end();
		return;
	}
	let raw = "";
	req.on("data", (chunk) => { raw += chunk; });
	req.on("end", () => {
		modelCalls += 1;
		let model = "room-model";
		try { model = String(JSON.parse(raw)?.model ?? model); } catch {}
		res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
		const base = { id: `cmpl_${modelCalls}`, object: "chat.completion.chunk", created: Math.floor(Date.now() / 1000), model };
		res.write(`data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: { role: "assistant", content: "Working on it." }, finish_reason: null }] })}\n\n`);
		const finish = () => {
			res.write(`data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 100, completion_tokens: 5, total_tokens: 105 } })}\n\n`);
			res.write("data: [DONE]\n\n");
			res.end();
		};
		if (holding) heldAnswers.push(finish);
		else finish();
	});
});
function letAnswersFinish(): void {
	holding = false;
	for (const finish of heldAnswers.splice(0)) finish();
}
await new Promise<void>((resolve) => gateway.listen(0, "127.0.0.1", resolve));
const gatewayPort = (gateway.address() as AddressInfo).port;
fs.writeFileSync(path.join(agentDir, "models.json"), JSON.stringify({ providers: { "openai-compatible": { name: "Synthetic Gateway", baseUrl: `http://127.0.0.1:${gatewayPort}/v1`, api: "openai-completions", models: [{ id: "room-model", name: "Room Model", contextWindow: 128000, maxTokens: 16384 }] } } }, null, 2), { mode: 0o600 });
fs.writeFileSync(path.join(agentDir, "auth.json"), JSON.stringify({ "openai-compatible": { type: "api_key", key: "synthetic-pane-key" } }, null, 2), { mode: 0o600 });
fs.writeFileSync(path.join(appDir, "openai-compatible-ai-profile.json"), JSON.stringify({ profileId: "openai-compatible", providerId: "openai-compatible", label: "Synthetic Gateway", roomModels: [{ modelId: "room-model", label: "Room Model" }], maintenanceModel: "room-model" }, null, 2), { mode: 0o600 });
fs.writeFileSync(path.join(appDir, "persistent-agent-ai-profile.json"), JSON.stringify({ profileId: "openai-compatible" }, null, 2), { mode: 0o600 });

// A skill with one script, planted as an import leaves it.
const skillName = "csv-tools";
const skillDir = path.join(agentDir, "skills", skillName);
fs.mkdirSync(path.join(skillDir, "scripts"), { recursive: true, mode: 0o700 });
const skillManifest = `---\nname: ${skillName}\ndescription: Tidies CSV files with a bundled script\n---\n\nRun the bundled script to tidy a CSV file.\n`;
fs.writeFileSync(path.join(skillDir, "SKILL.md"), skillManifest, { mode: 0o600 });
fs.writeFileSync(path.join(skillDir, "scripts", "tidy.py"), "print('tidy')\n", { mode: 0o600 });
writeSkillProvenance(skillDir, { source: "upload", importedAt: new Date().toISOString(), license: null, sha256: sha256(skillManifest) });
// And one with two scripts, for the line that counts its files.
const pairSkillName = "report-tools";
const pairSkillDir = path.join(agentDir, "skills", pairSkillName);
fs.mkdirSync(path.join(pairSkillDir, "scripts"), { recursive: true, mode: 0o700 });
const pairSkillManifest = `---\nname: ${pairSkillName}\ndescription: Builds a report with two bundled scripts\n---\n\nRun the bundled scripts to build the report.\n`;
fs.writeFileSync(path.join(pairSkillDir, "SKILL.md"), pairSkillManifest, { mode: 0o600 });
fs.writeFileSync(path.join(pairSkillDir, "scripts", "collect.py"), "print('collect')\n", { mode: 0o600 });
fs.writeFileSync(path.join(pairSkillDir, "scripts", "render.py"), "print('render')\n", { mode: 0o600 });
writeSkillProvenance(pairSkillDir, { source: "upload", importedAt: new Date().toISOString(), license: null, sha256: sha256(pairSkillManifest) });

// The server's own words for a refused folder and for a save during an answer; the pane shows the first and never the second.
const SERVER_ANSWERING_LINE = "The room is answering right now. Save again when it has finished; nothing was changed.";
const HOLDS_APP_DATA_LINE = "This folder contains exxperts' own data, so a room can't work in it. Choose a project folder instead, such as one in Documents.";
const HIDDEN_PATH_LINE = "The full path stays on this computer and is not shown here.";
// Words of the pane before it saved on each click: none may show now.
const OLD_WORDS = [/\bAccess\b/, /Full access/, /Bounded/, /\bBash\b/, /^Tools$/m, /Save changes/, /next message/];

async function api(pathname: string, init: AuthedFetchInit = {}): Promise<{ status: number; body: any }> {
	const response = await authedFetch(`${baseUrl}${pathname}`, { ...init, headers: { ...(init.body ? { "content-type": "application/json" } : {}), ...init.headers } });
	const text = await response.text();
	return { status: response.status, body: text ? JSON.parse(text) : null };
}

const waitUntil = waitEvery(150, 15_000);

async function createRoom(displayName: string): Promise<string> {
	const created = await api("/api/persistent-agents", { method: "POST", body: JSON.stringify({ displayName, userName: "Synthetic User", preferredUserAddress: "Synthetic User" }) });
	assert(created.status === 201, `${displayName} is created, got ${created.status}`);
	const id = String(created.body?.agent?.id ?? "");
	// Rooms as made before commands started on, so each pane reads as this smoke sets it.
	for (const file of ["commands-start-on.json", "bash-settings.json"]) fs.rmSync(path.join(agentsRoot, id, "runtime", file), { force: true });
	return id;
}

async function saveWorkspace(agentId: string, body: Record<string, unknown>): Promise<void> {
	const saved = await api(`/api/persistent-agents/${encodeURIComponent(agentId)}/workspace-default`, { method: "PUT", body: JSON.stringify(body) });
	assert(saved.status === 200, `the workspace is saved, got ${saved.status} ${JSON.stringify(saved.body)}`);
}

async function openPane(page: Page, roomName: string, paneName: "Folder" | "Skills") {
	const card = page.locator(".persistent-agent-card").filter({ hasText: roomName });
	await card.waitFor({ timeout: 10_000 });
	await card.locator(".card-gear-btn").click();
	await page.waitForSelector(".settings-dialog", { timeout: 10_000 });
	await page.locator(".settings-dialog-nav-item").filter({ hasText: new RegExp(`^${paneName}`) }).first().click();
	return page.locator(".room-settings-section:not([hidden])");
}

async function closeSettings(page: Page): Promise<void> {
	await page.keyboard.press("Escape");
	await page.locator(".settings-dialog").first().waitFor({ state: "detached", timeout: 10_000 });
}

const locationRow = (pane: Locator) => pane.locator(".folder-pane-location");
const commandsSwitch = (pane: Locator) => pane.getByRole("switch", { name: COMMANDS, exact: true });
const canChangeSwitch = (pane: Locator) => pane.getByRole("switch", { name: CAN_CHANGE_FILES, exact: true });

// What a screen reader hears beside a control: the text of the element its aria-describedby names.
async function describedBy(control: Locator): Promise<string | null> {
	return control.evaluate((el) => {
		const id = el.getAttribute("aria-describedby");
		return id ? el.ownerDocument.getElementById(id)?.textContent ?? null : null;
	});
}

// The room's open conversation, written as the page writes it when a room is entered.
async function openConversation(agentId: string, conversationId: string): Promise<void> {
	const saved = await api(`/api/persistent-agents/${encodeURIComponent(agentId)}/threads/${conversationId}`, { method: "PUT", body: JSON.stringify({ state: "active", origin: "launcher", model: { provider: "openai-compatible", model: "room-model" }, items: [] }) });
	assert(saved.status === 200, `the conversation is open, got ${saved.status} ${JSON.stringify(saved.body)}`);
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

	const fullDesk = await createRoom("Full Desk");
	await saveWorkspace(fullDesk, { root: demo, workspaceAccessMode: "localFiles", bashEnabled: false });
	for (const action of ["enable", "approve-execution"]) {
		const changed = await api(`/api/persistent-agents/${encodeURIComponent(fullDesk)}/skill-settings`, { method: "PUT", body: JSON.stringify({ action, name: skillName }) });
		assert(changed.status === 200, `${action} the skill, got ${changed.status} ${JSON.stringify(changed.body)}`);
	}
	const boundedDesk = await createRoom("Bounded Desk");
	await saveWorkspace(boundedDesk, { root: demo, workspaceAccessMode: "bounded" });
	const noReadDesk = await createRoom("No Read Desk");
	await saveWorkspace(noReadDesk, { root: demo, workspaceAccessMode: "localFiles", toolSelection: { kind: "custom", allowedToolNames: [] }, bashEnabled: false });
	await saveWorkspace(await createRoom("Long Desk"), { root: longFolder, workspaceAccessMode: "localFiles" });
	await saveWorkspace(await createRoom("Gone Desk"), { root: goneFolder, workspaceAccessMode: "localFiles" });
	fs.rmSync(goneFolder, { recursive: true, force: true });
	const stopDesk = await createRoom("Stop Desk");
	await saveWorkspace(stopDesk, { root: demo, workspaceAccessMode: "localFiles" });
	await createRoom("Empty Desk");
	const placeDesk = await createRoom("Place Desk");
	await saveWorkspace(placeDesk, { root: demo, workspaceAccessMode: "localFiles", bashEnabled: false });
	const busyDesk = await createRoom("Busy Desk");
	await saveWorkspace(busyDesk, { root: demo, workspaceAccessMode: "localFiles", bashEnabled: false });
	await saveWorkspace(await createRoom("Heard Desk"), { root: demo, workspaceAccessMode: "localFiles", bashEnabled: false });
	const edgeDesk = await createRoom("Edge Desk");
	await saveWorkspace(edgeDesk, { root: demo, workspaceAccessMode: "localFiles", bashEnabled: false });
	await saveWorkspace(await createRoom("Path Desk"), { root: deepFolder, workspaceAccessMode: "localFiles", bashEnabled: false });
	const sharedDesk = await createRoom("Shared Desk");
	await saveWorkspace(sharedDesk, { root: demo, workspaceAccessMode: "localFiles", bashEnabled: false });
	for (const name of [skillName, pairSkillName]) {
		for (const action of ["enable", "approve-execution"]) {
			const changed = await api(`/api/persistent-agents/${encodeURIComponent(sharedDesk)}/skill-settings`, { method: "PUT", body: JSON.stringify({ action, name }) });
			assert(changed.status === 200, `${action} ${name} in Shared Desk, got ${changed.status} ${JSON.stringify(changed.body)}`);
		}
	}
	const roomFolder = async (agentId: string) => (await api(`/api/persistent-agents/${encodeURIComponent(agentId)}/workspace-default`)).body;
	const commandsOn = async (agentId: string) => (await roomFolder(agentId))?.policy?.bashEnabled === true;
	const savedRoot = async (agentId: string) => String((await roomFolder(agentId))?.policy?.roots?.[0]?.basename ?? "");

	const browser = await chromium.launch();
	try {
		const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
		const page = await context.newPage();
		await page.goto(`${baseUrl}/auth/session?token=${SMOKE_AUTH_TOKEN}`);
		await page.waitForLoadState("networkidle");
		const dismiss = page.locator(".whats-new-close");
		if (await dismiss.count()) await dismiss.click();

		// ONLY=<section> runs one section alone, so each is its own red-first command.
		const only = process.env.ONLY;

		// 1. The pane shows Location, Can change files, Commands, the protection row and Also allowed, and
		// none of the old controls. An older Bounded room can change files and its commands are off.
		if (!only || only === "shape") {
			const pane = await openPane(page, "Bounded Desk", "Folder");
			await commandsSwitch(pane).waitFor({ timeout: 10_000 });
			const labels = await pane.locator(".room-workspace-section .settings-row-label").allInnerTexts();
			assert(labels[0] === LOCATION && labels[1] === CAN_CHANGE_FILES && labels[2] === COMMANDS && labels[3] === PROTECTION, `the rows read Location, Can change files, Commands, Protection, got ${JSON.stringify(labels)}`);
			await pane.locator("section.also-allowed").waitFor({ timeout: 10_000 });
			assert(await pane.locator("section.also-allowed").count() === 1, "Also allowed follows them");
			const text = await pane.innerText();
			for (const old of OLD_WORDS) assert(!old.test(text), `the pane shows none of the old words (${old}), got: ${text}`);
			for (const name of ["Edit", "Save changes", "Cancel", "Clear"]) assert(await pane.getByRole("button", { name, exact: true }).count() === 0, `the pane has no ${name} button`);
			assert(await pane.getByRole("radio").count() === 0, "the pane has no access choice");
			assert(await canChangeSwitch(pane).isChecked(), "an older Bounded room can change files");
			assert(!(await commandsSwitch(pane).isChecked()), "an older Bounded room's commands are off");
			await closeSettings(page);
			const card = page.locator(".persistent-agent-card").filter({ hasText: "Empty Desk" });
			await card.getByRole("button", { name: /^(Enter|Resume)$/ }).click();
			const nudge = page.locator(".room-workspace-nudge-text");
			await nudge.waitFor({ timeout: 10_000 });
			assert(await nudge.textContent() === NO_FOLDER_LINE, `the room's no-folder line says folder, got ${await nudge.textContent()}`);
			await page.evaluate(() => { window.location.hash = "#/"; });
			console.log("  ok  Location, Can change files, Commands, Protection, Also allowed, and none of the old controls");
		}

		// 2. A room whose own list had no Read reads with no folder, until one is chosen again.
		if (!only || only === "noread") {
			const pane = await openPane(page, "No Read Desk", "Folder");
			await locationRow(pane).getByText(NO_FOLDER_YET_LINE, { exact: true }).waitFor({ timeout: 10_000 });
			assert(await canChangeSwitch(pane).count() === 0 && await commandsSwitch(pane).count() === 0, "with no folder, Can change files and Commands are hidden");
			await closeSettings(page);
			console.log("  ok  a room with no Read reads with no folder");
		}

		// 3. A long folder name stays inside the pane, with the cross in view. On this computer the name
		// carries its path for the pointer; a remote device, sent no path, shows the name alone.
		if (!only || only === "long") {
			const pane = await openPane(page, "Long Desk", "Folder");
			const shownName = pane.locator(".workspace-folder-name");
			await shownName.waitFor({ timeout: 10_000 });
			const paneBox = await pane.locator(".room-workspace-section").boundingBox();
			const crossBox = await pane.getByRole("button", { name: STOP_USING_FOLDER }).boundingBox();
			const nameBox = await shownName.boundingBox();
			assert(paneBox && crossBox && nameBox, "the Location row is laid out");
			assert(crossBox.x + crossBox.width <= paneBox.x + paneBox.width + 1, `the cross stays inside the pane, its right edge ${crossBox.x + crossBox.width} against ${paneBox.x + paneBox.width}`);
			assert(nameBox.x + nameBox.width <= crossBox.x, "the name ends before the buttons");
			assert(await shownName.textContent() === path.basename(longFolder) && await shownName.getAttribute("title") === longFolder, `Location shows the folder's name with its path on it, got ${await shownName.textContent()} / ${await shownName.getAttribute("title")}`);
			assert(!(await locationRow(pane).innerText()).includes(projects), `no path shows in the row, got ${await locationRow(pane).innerText()}`);
			await closeSettings(page);
			const remoteContext = await browser.newContext({ viewport: { width: 1280, height: 900 } });
			try {
				const remotePage = await remoteContext.newPage();
				await remotePage.route("**/api/remote/client-context", (route) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ remote: true, capability: "full", sharedServer: false }) }));
				// A remote device is sent the folder's name and no path; room-workspace-path-reach-smoke checks the server's own answer.
				await remotePage.route("**/api/persistent-agents/*/workspace-default", async (route) => {
					if (route.request().method() !== "GET") return route.continue();
					const response = await route.fetch();
					const body = await response.json();
					for (const root of body?.policy?.roots ?? []) delete root.path;
					await route.fulfill({ response, json: body });
				});
				await remotePage.goto(`${baseUrl}/auth/session?token=${SMOKE_AUTH_TOKEN}`);
				await remotePage.waitForLoadState("networkidle");
				const close = remotePage.locator(".whats-new-close");
				if (await close.count()) await close.click();
				const remotePane = await openPane(remotePage, "Long Desk", "Folder");
				const name = remotePane.locator(".workspace-folder-name");
				await name.waitFor({ timeout: 10_000 });
				assert(await name.textContent() === path.basename(longFolder), `on a remote device Location names the folder, got ${await name.textContent()}`);
				const remotePaneBox = await remotePane.locator(".room-workspace-section").boundingBox();
				const nameBox = await name.boundingBox();
				assert(remotePaneBox && nameBox && nameBox.x + nameBox.width <= remotePaneBox.x + remotePaneBox.width + 1, "on a remote device the name stays inside the pane");
				assert(await name.getAttribute("title") === null, "on a remote device the name carries no path");
				assert(await remotePane.getByText(CHANGEABLE_AT_COMPUTER, { exact: true }).count() === 1, "on a remote device the pane says once where it can be changed");
			} finally {
				await closeContext(remoteContext);
			}
			console.log("  ok  a long folder name stays inside the pane, its path on the name on this computer and none on a remote device");
		}

		// 4. A folder that is gone says so under its name, and the row still names it.
		if (!only || only === "gone") {
			const pane = await openPane(page, "Gone Desk", "Folder");
			const row = locationRow(pane);
			await row.getByText(FOLDER_NOT_FOUND, { exact: true }).waitFor({ timeout: 10_000 });
			assert(await row.locator(".workspace-folder-name").textContent() === "gone-soon", `the row still names the folder that is gone, got ${await row.innerText()}`);
			assert(await pane.getByText(FOLDER_NOT_FOUND, { exact: true }).count() === 1, "the pane says it once");
			assert(!(await pane.innerText()).includes('The saved workspace folder "gone-soon"'), "no line under the pane repeats it");
			// The folder's button, not the cross beside it, which is a family button too.
			const button = row.locator("button.rs-btn:not(.also-allowed-cross)");
			assert(await button.textContent() === CHOOSE_FOLDER && await button.evaluate((el) => el.classList.contains("rs-btn-primary")), `a folder that is gone gets Choose folder, the primary button, not Change folder, got ${await button.textContent()}`);
			await closeSettings(page);
			const remoteContext = await browser.newContext({ viewport: { width: 1280, height: 900 } });
			try {
				const remotePage = await remoteContext.newPage();
				await remotePage.route("**/api/remote/client-context", (route) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ remote: true, capability: "full", sharedServer: false }) }));
				await remotePage.goto(`${baseUrl}/auth/session?token=${SMOKE_AUTH_TOKEN}`);
				await remotePage.waitForLoadState("networkidle");
				const close = remotePage.locator(".whats-new-close");
				if (await close.count()) await close.click();
				const remotePane = await openPane(remotePage, "Gone Desk", "Folder");
				await locationRow(remotePane).locator(".settings-row-tag").getByText(NOT_FOUND, { exact: true }).waitFor({ timeout: 10_000 });
				assert(await remotePane.getByText(FOLDER_NOT_FOUND, { exact: true }).count() === 0, "on a remote device the tag says it, never \"this computer\"");
			} finally {
				await closeContext(remoteContext);
			}
			console.log("  ok  a gone folder says so under its name");
		}

		// 5. The cross asks first, with the focus on Cancel; Cancel keeps the folder and Stop using removes it.
		if (!only || only === "stop") {
			const pane = await openPane(page, "Stop Desk", "Folder");
			const cross = pane.getByRole("button", { name: STOP_USING_FOLDER });
			await cross.click();
			const question = page.getByRole("alertdialog", { name: stopUsingFolderTitle("demo") });
			await question.waitFor({ timeout: 10_000 });
			assert((await question.innerText()).includes(STOP_USING_FOLDER_BODY), `the question says the folder stays, got: ${await question.innerText()}`);
			assert(await question.getByRole("button", { name: "Cancel" }).evaluate((el) => el === document.activeElement), "the focus starts on Cancel");
			await question.getByRole("button", { name: "Cancel" }).click();
			await question.waitFor({ state: "hidden", timeout: 10_000 });
			assert(await savedRoot(stopDesk) === "demo", "Cancel keeps the folder");
			await cross.click();
			await question.getByRole("button", { name: STOP_USING, exact: true }).click();
			await waitUntil(async () => (await savedRoot(stopDesk)) === "", "Stop using removes the folder");
			// The row's own line says the room has no folder now; a screen reader hears the removal.
			await waitUntil(async () => (await pane.locator(".room-workspace-section > .sr-only[role=status]").textContent()) === FOLDER_REMOVED, "a screen reader hears the folder removed");
			const lines = await pane.locator(".folder-pane-location .settings-row-sub").allTextContents();
			assert(JSON.stringify(lines) === JSON.stringify([NO_FOLDER_YET_LINE]), `Location shows its one line after Stop using, got ${JSON.stringify(lines)}`);
			await closeSettings(page);
			console.log("  ok  the cross asks first");
		}

		// 6. A failed load says so and offers Try again, never "No folder yet".
		if (!only || only === "loadfail") {
			let failing = true;
			await page.route("**/api/persistent-agents/*/workspace-default", (route) => (failing && route.request().method() === "GET" ? route.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ error: "Bad Request" }) }) : route.continue()));
			const pane = await openPane(page, "Full Desk", "Folder");
			await pane.getByText(FOLDER_LOAD_FAILED).waitFor({ timeout: 10_000 });
			const text = await pane.innerText();
			assert(!text.includes(NO_FOLDER_YET_LINE) && !text.includes("Bad Request"), `a failed load is not "No folder yet" nor the raw error, got: ${text}`);
			// While the room's commands are unknown, the skill's files line says only what is true.
			await page.locator(".settings-dialog-nav-item").filter({ hasText: /^Skills/ }).first().click();
			const unknownLine = page.locator(".room-settings-section:not([hidden]) .room-skill-files-row .settings-row-sub");
			await unknownLine.waitFor({ timeout: 10_000 });
			await waitUntil(async () => /^Allowed\. Its files? runs? only while this room's commands are on\./.test(String(await unknownLine.textContent())), "the files line says only what is true while the commands are unknown");
			await page.locator(".settings-dialog-nav-item").filter({ hasText: /^Folder$/ }).first().click();
			failing = false;
			await pane.getByRole("button", { name: TRY_AGAIN }).click();
			await commandsSwitch(pane).waitFor({ timeout: 10_000 });
			await page.unroute("**/api/persistent-agents/*/workspace-default");
			await closeSettings(page);
			console.log("  ok  a failed load offers Try again");
		}

		// 7. An allowed skill's files say they run only while the room's commands are on, and follow the Commands switch at once.
		if (!only || only === "skills") {
			const skills = await openPane(page, "Full Desk", "Skills");
			const filesLine = skills.locator(".room-skill-files-row .settings-row-sub");
			await filesLine.waitFor({ timeout: 10_000 });
			await waitUntil(async () => /^Allowed\. Its (file runs|\d+ files run) only while this room's commands are on; turn them on under Folder\./.test(String(await filesLine.textContent())), `with commands off the files line says where to turn them on, got ${await filesLine.textContent()}`);
			await page.locator(".settings-dialog-nav-item").filter({ hasText: /^Folder$/ }).first().click();
			const pane = page.locator(".room-settings-section:not([hidden])");
			await commandsSwitch(pane).click();
			await waitUntil(async () => await commandsOn(fullDesk), "the Commands switch saves on its click");
			await page.locator(".settings-dialog-nav-item").filter({ hasText: /^Skills/ }).first().click();
			await waitUntil(async () => /^Allowed\. The room may run its (file as it is|\d+ files as they are) now\./.test(String(await filesLine.textContent())), `with commands on the files line says they may run, got ${await filesLine.textContent()}`);
			await closeSettings(page);
			console.log("  ok  a skill's files line follows the room's commands");
		}

		// 8. A refusal shows by what it is about: a folder's under Location, a switch's beside the switch;
		// a wait in the muted colour, any other failure in red with the switch back where it was.
		if (!only || only === "beside") {
			const pane = await openPane(page, "Place Desk", "Folder");
			await commandsSwitch(pane).waitFor({ timeout: 10_000 });
			await page.route("**/api/system/choose-folder", (route) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ supported: true, cancelled: false, path: tempHome }) }));
			try {
				await locationRow(pane).getByRole("button", { name: CHANGE_FOLDER }).click();
				const refusal = locationRow(pane).getByText(HOLDS_APP_DATA_LINE, { exact: true });
				await refusal.waitFor({ timeout: 10_000 });
				assert(await pane.getByText(HOLDS_APP_DATA_LINE, { exact: true }).count() === 1, "the folder's refusal shows once, under Location");
				assert(await refusal.getAttribute("role") === "alert", "the folder's refusal is announced");
			} finally {
				await page.unroute("**/api/system/choose-folder");
			}
			assert(await savedRoot(placeDesk) === "demo", "a refused folder leaves the saved one");
			const muted = await pane.locator(".pane-head-text p").first().evaluate((el) => getComputedStyle(el).color);
			const commandsRow = pane.locator("label.settings-row").filter({ has: page.getByRole("switch", { name: COMMANDS, exact: true }) });
			await page.route("**/api/persistent-agents/*/workspace-default", (route) => (route.request().method() === "PUT" ? route.fulfill({ status: 409, contentType: "application/json", body: JSON.stringify({ error: SERVER_ANSWERING_LINE, code: "active_turn_in_flight" }) }) : route.continue()));
			await commandsSwitch(pane).click();
			const waitLine = commandsRow.getByText(ROOM_ANSWERING_CHANGE_LINE, { exact: true });
			await waitLine.waitFor({ timeout: 10_000 });
			assert(await pane.getByText(SERVER_ANSWERING_LINE).count() === 0, "the server's own words never show");
			assert(await waitLine.evaluate((el) => getComputedStyle(el).color) === muted, "the wait is in the muted colour, not a refusal's red");
			await page.unroute("**/api/persistent-agents/*/workspace-default");
			await page.route("**/api/persistent-agents/*/workspace-default", (route) => (route.request().method() === "PUT" ? route.fulfill({ status: 500, body: "" }) : route.continue()));
			await commandsSwitch(pane).click();
			const failLine = commandsRow.getByText(CHANGE_SAVE_FAILED, { exact: true });
			await failLine.waitFor({ timeout: 10_000 });
			assert(await failLine.evaluate((el) => getComputedStyle(el).color) !== muted, "a failed save is in a refusal's colour");
			assert(!(await commandsSwitch(pane).isChecked()), "a failed save puts the switch back");
			await page.unroute("**/api/persistent-agents/*/workspace-default");
			await commandsSwitch(pane).click();
			await waitUntil(async () => await commandsOn(placeDesk), "a save that works goes through");
			await waitUntil(async () => await commandsRow.getByText(CHANGE_SAVE_FAILED, { exact: true }).count() === 0, "a save that works takes the old line away");
			await closeSettings(page);
			console.log("  ok  a refusal shows by what it is about");
		}

		// The pane's controls a person can press, for the greyed checks: the switches, the cross,
		// Location's button and Also allowed's Add.
		const paneControls = (pane: Locator) => pane.locator(".room-workspace-section").locator('input[role="switch"], button.also-allowed-cross, .folder-pane-location button, button.also-allowed-add');

		// 9. While the room answers, every control is greyed with one muted line above them, in the room
		// and from Home, and the cross asks nothing; they work again as soon as the answer has finished.
		if (!only || only === "answering") {
			const card = page.locator(".persistent-agent-card").filter({ hasText: "Busy Desk" });
			await card.getByRole("button", { name: /^(Enter|Resume)$/ }).click();
			const composer = page.locator("textarea").first();
			await composer.waitFor({ timeout: 15_000 });
			const send = page.locator('button.send-btn[title="Send"]');
			await send.waitFor({ timeout: 15_000 });
			holding = true;
			await composer.fill("Take your time with this one.");
			await send.click();
			await waitUntil(() => heldAnswers.length > 0, "the room is answering");
			await page.locator(".stop-btn").first().waitFor({ timeout: 10_000 });

			await page.getByRole("button", { name: "Room settings" }).first().click();
			await page.locator(".settings-dialog-nav-item").filter({ hasText: /^Folder$/ }).first().click();
			const pane = page.locator(".room-settings-section:not([hidden])");
			await commandsSwitch(pane).waitFor({ timeout: 10_000 });
			const controls = paneControls(pane);
			assert(await controls.count() >= 4, `the pane's controls are found, got ${await controls.count()}`);
			for (const control of await controls.all()) assert(await control.isDisabled(), `every control is greyed while the room answers: ${await control.evaluate((el) => el.outerHTML.slice(0, 120))}`);
			const line = pane.locator(".folder-pane-elsewhere").getByText(ROOM_ANSWERING_CHANGE_LINE, { exact: true });
			assert(await line.isVisible(), `the reason shows above the rows, got: ${await pane.innerText()}`);
			const muted = await pane.locator(".pane-head-text p").first().evaluate((el) => getComputedStyle(el).color);
			assert(await line.evaluate((el) => getComputedStyle(el).color) === muted, "the reason is in the muted colour");
			await pane.getByRole("button", { name: STOP_USING_FOLDER }).click({ force: true, timeout: 2_000 }).catch(() => {});
			await page.waitForTimeout(400);
			assert(await page.getByRole("alertdialog").count() === 0, "a greyed cross asks no question");

			letAnswersFinish();
			await waitUntil(async () => await commandsSwitch(pane).isEnabled(), "the switches work again once the answer has finished");
			assert(await line.count() === 0, "the reason goes with the answer");
			await commandsSwitch(pane).click();
			await waitUntil(async () => await commandsOn(busyDesk), "the change went through once the answer had finished");
			await closeSettings(page);

			// From Home, while the room goes on answering with nobody inside, the pane is greyed the same way.
			holding = true;
			await composer.fill("And one more, slowly.");
			await send.click();
			await waitUntil(() => heldAnswers.length > 0, "the room is answering again");
			await page.locator(".stop-btn").first().waitFor({ timeout: 10_000 });
			await page.evaluate(() => { window.location.hash = "#/"; });
			const home = await openPane(page, "Busy Desk", "Folder");
			await commandsSwitch(home).waitFor({ timeout: 10_000 });
			await waitUntil(async () => await commandsSwitch(home).isDisabled(), "from Home, the switches are greyed while the room answers");
			assert(await home.getByText(ROOM_ANSWERING_CHANGE_LINE, { exact: true }).isVisible(), "from Home, the reason shows");
			letAnswersFinish();
			await waitUntil(async () => await commandsSwitch(home).isEnabled(), "from Home, the switches work again once the answer has finished", 20_000);
			assert(await home.getByText(ROOM_ANSWERING_CHANGE_LINE, { exact: true }).count() === 0, "from Home, the reason goes with the answer");
			await closeSettings(page);
			console.log("  ok  while the room answers, every control waits greyed with the reason above them");
		}

		// 10. A change the server refuses for an answer the page had not seen: from Home, the room starts
		// answering elsewhere; the refusal makes the page look again, so the controls grey with the page's
		// own line and come back by themselves once the answer has finished.
		if (!only || only === "refused") {
			const pane = await openPane(page, "Edge Desk", "Folder");
			await commandsSwitch(pane).waitFor({ timeout: 10_000 });
			assert(await commandsSwitch(pane).isEnabled(), "the switch works while the page knows of no answer");
			// The room starts answering over its own socket, as from another device.
			const conversationId = `edge_${Date.now().toString(36)}`;
			await openConversation(edgeDesk, conversationId);
			const WebSocketImpl: any = (await import("ws")).default;
			const frames: any[] = [];
			const socket = new WebSocketImpl(`ws://127.0.0.1:${port}/ws?persistentAgentId=${edgeDesk}&conversationId=${conversationId}&modelProvider=openai-compatible&model=room-model`, { headers: { ...SMOKE_AUTH_HEADERS } });
			socket.addEventListener("message", (event: { data: unknown }) => { try { frames.push(JSON.parse(String(event.data))); } catch {} });
			await new Promise<void>((resolve, reject) => { socket.addEventListener("open", () => resolve()); socket.addEventListener("error", () => reject(new Error("the room's socket failed to connect"))); });
			try {
				await waitUntil(() => frames.some((frame) => frame.type === "ready"), "the room's socket is ready");
				holding = true;
				socket.send(JSON.stringify({ type: "prompt", text: "An answer from another device, slowly." }));
				await waitUntil(() => heldAnswers.length > 0, "the room answers elsewhere");
				await commandsSwitch(pane).click();
				await pane.locator(".folder-pane-elsewhere").getByText(ROOM_ANSWERING_CHANGE_LINE, { exact: true }).waitFor({ timeout: 10_000 });
				await waitUntil(async () => !(await commandsSwitch(pane).isChecked()), "after the refusal, the switch is back where it was");
				assert(await commandsSwitch(pane).isDisabled() && !(await commandsOn(edgeDesk)), "after the refusal, the switch is greyed while the room answers, and nothing was changed");
				for (const control of await paneControls(pane).all()) assert(await control.isDisabled(), "after the refusal, every control is greyed");
				letAnswersFinish();
				await waitUntil(async () => await commandsSwitch(pane).isEnabled(), "the switch comes back by itself once the answer has finished", 20_000);
				await commandsSwitch(pane).click();
				await waitUntil(async () => await commandsOn(edgeDesk), "the change went through once the answer had finished");
			} finally {
				socket.close();
			}
			await closeSettings(page);
			console.log("  ok  a change refused for an answer the page had not seen greys the controls until it has finished");
		}

		// 11. A greyed control carries its reason for a screen reader; a failed save is announced at once,
		// and a wait stays a quiet status.
		if (!only || only === "heard") {
			const card = page.locator(".persistent-agent-card").filter({ hasText: "Heard Desk" });
			await card.getByRole("button", { name: /^(Enter|Resume)$/ }).click();
			const composer = page.locator("textarea").first();
			await composer.waitFor({ timeout: 15_000 });
			const send = page.locator('button.send-btn[title="Send"]');
			await send.waitFor({ timeout: 15_000 });
			holding = true;
			await composer.fill("Take your time.");
			await send.click();
			await waitUntil(() => heldAnswers.length > 0, "the room is answering");
			await page.locator(".stop-btn").first().waitFor({ timeout: 10_000 });
			await page.getByRole("button", { name: "Room settings" }).first().click();
			await page.locator(".settings-dialog-nav-item").filter({ hasText: /^Folder$/ }).first().click();
			const pane = page.locator(".room-settings-section:not([hidden])");
			await commandsSwitch(pane).waitFor({ timeout: 10_000 });
			for (const control of await paneControls(pane).all()) assert(await describedBy(control) === ROOM_ANSWERING_CHANGE_LINE, `a greyed control carries its reason, got ${await describedBy(control)}`);
			letAnswersFinish();
			await waitUntil(async () => await commandsSwitch(pane).isEnabled(), "the switch works again once the answer has finished");
			for (const control of await paneControls(pane).all()) assert(await describedBy(control) === null, "a control carries no reason once it works");
			const commandsRow = pane.locator("label.settings-row").filter({ has: page.getByRole("switch", { name: COMMANDS, exact: true }) });
			await page.route("**/api/persistent-agents/*/workspace-default", (route) => (route.request().method() === "PUT" ? route.fulfill({ status: 500, body: "" }) : route.continue()));
			await commandsSwitch(pane).click();
			const failLine = commandsRow.getByText(CHANGE_SAVE_FAILED, { exact: true });
			await failLine.waitFor({ timeout: 10_000 });
			assert(await failLine.getAttribute("role") === "alert", `a failed save is announced, got role ${await failLine.getAttribute("role")}`);
			await page.unroute("**/api/persistent-agents/*/workspace-default");
			await page.route("**/api/persistent-agents/*/workspace-default", (route) => (route.request().method() === "PUT" ? route.fulfill({ status: 409, contentType: "application/json", body: JSON.stringify({ error: SERVER_ANSWERING_LINE, code: "active_turn_in_flight" }) }) : route.continue()));
			await commandsSwitch(pane).click();
			const waitLine = commandsRow.getByText(ROOM_ANSWERING_CHANGE_LINE, { exact: true });
			await waitLine.waitFor({ timeout: 10_000 });
			assert(await waitLine.getAttribute("role") === "status", `a wait stays a quiet status, got role ${await waitLine.getAttribute("role")}`);
			await page.unroute("**/api/persistent-agents/*/workspace-default");
			await closeSettings(page);
			await page.evaluate(() => { window.location.hash = "#/"; });
			await page.locator(".persistent-agent-card").first().waitFor({ timeout: 10_000 });
			console.log("  ok  a greyed control carries its reason; a failed save is announced");
		}

		// 12. On a shared server an allowed skill's files never run, and the line says so in the shape of the others.
		if (!only || only === "shared") {
			const sharedContext = await browser.newContext({ viewport: { width: 1280, height: 900 } });
			try {
				const sharedPage = await sharedContext.newPage();
				await sharedPage.route("**/api/remote/client-context", (route) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ remote: false, capability: "full", sharedServer: true }) }));
				await sharedPage.goto(`${baseUrl}/auth/session?token=${SMOKE_AUTH_TOKEN}`);
				await sharedPage.waitForLoadState("networkidle");
				const close = sharedPage.locator(".whats-new-close");
				if (await close.count()) await close.click();
				const skills = await openPane(sharedPage, "Shared Desk", "Skills");
				const filesLine = (name: string) => skills.locator(".room-skill").filter({ hasText: name }).locator(".room-skill-files-row .settings-row-sub");
				await filesLine(skillName).waitFor({ timeout: 10_000 });
				await waitUntil(async () => /^Allowed\. On a shared server, its file never runs\./.test(String(await filesLine(skillName).textContent())), `one file on a shared server, got ${await filesLine(skillName).textContent()}`);
				await waitUntil(async () => /^Allowed\. On a shared server, its 2 files never run\./.test(String(await filesLine(pairSkillName).textContent())), `two files on a shared server, got ${await filesLine(pairSkillName).textContent()}`);
			} finally {
				await closeContext(sharedContext);
			}
			console.log("  ok  on a shared server, a skill's files line says they never run");
		}

		// 13. On this computer Location shows the folder's name, with its full path, as the computer writes
		// it, on the name for the pointer, and no line about a hidden path; at 390 px a long name stays
		// inside the row and the page never scrolls sideways.
		if (!only || only === "fullpath") {
			const pane = await openPane(page, "Path Desk", "Folder");
			const row = locationRow(pane);
			const shownName = row.locator(".workspace-folder-name");
			await shownName.waitFor({ timeout: 10_000 });
			assert(await shownName.textContent() === path.basename(deepFolder) && await shownName.getAttribute("title") === deepFolder, `Location shows the folder's name with its full path on it, got ${await row.innerText()} / ${await shownName.getAttribute("title")}`);
			assert(!(await row.innerText()).includes(projects), `no path shows in the row, got ${await row.innerText()}`);
			assert(!(await pane.innerText()).includes(HIDDEN_PATH_LINE), `no line says the path is not shown, got: ${await pane.innerText()}`);
			await page.setViewportSize({ width: 390, height: 844 });
			const rowBox = await row.boundingBox();
			const nameBox = await shownName.boundingBox();
			assert(rowBox && nameBox, "Location and its name are laid out at 390 px");
			assert(nameBox.x + nameBox.width <= rowBox.x + rowBox.width + 1, `the name stays inside the row at 390 px (name right ${nameBox.x + nameBox.width}, row right ${rowBox.x + rowBox.width})`);
			assert(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), "the page does not scroll sideways at 390 px");
			await page.setViewportSize({ width: 1280, height: 900 });
			await closeSettings(page);
			console.log("  ok  on this computer Location shows the folder's name with its full path on it, inside the row on a narrow screen");
		}

		// 14. A reload asks nothing: every change has saved on its click.
		if (!only || only === "reload") {
			const pane = await openPane(page, "Bounded Desk", "Folder");
			await canChangeSwitch(pane).click();
			await waitUntil(async () => !((await roomFolder(boundedDesk))?.policy?.allowedToolNames ?? []).includes("write"), "Can change files saves on its click");
			let asked = false;
			page.on("dialog", (dialog) => {
				if (dialog.type() === "beforeunload") asked = true;
				void dialog.dismiss();
			});
			await page.close({ runBeforeUnload: true });
			// A question would come as the page closes; none came by the time it has.
			await page.waitForEvent("close", { timeout: 5_000 }).catch(() => {});
			assert(page.isClosed() && !asked, "leaving the page asks nothing");
			console.log("  ok  a reload asks nothing");
		}
	} finally {
		await closeBrowser(browser);
	}
	console.log("room workspace pane words smoke: ok");
} catch (error) {
	console.error(serverOutput.join("").slice(-3000));
	throw error;
} finally {
	letAnswersFinish();
	gateway.closeAllConnections();
	gateway.close();
	await stopSmokeServer(server);
	fs.rmSync(tempRoot, { recursive: true, force: true });
}
