// Room settings' Workspace pane, and the Skills pane's files line, say what
// the room really has, in the page against a real server: the tools in one
// order and one access label; no tools reads as no tools; a long folder name
// stays inside the pane; a folder that is gone says so in its own row and
// lists no tools; Clear asks first; a failed load offers Try again; a reload
// with unsaved changes asks; an allowed skill's files say they run only while
// Bash is on, and on a shared server that they never run; a refusal shows by
// what it is about, a folder's under the folder box and its buttons, as wide
// as they are together, and a save's beside the buttons; while the room answers, saving is greyed with the reason beside
// the buttons, in the room and from Home, and a save the server refuses for an
// answer the page had not seen greys them too; a greyed button carries its
// reason for a screen reader. On this computer the Folder row shows the
// folder's full path, wrapped inside the row on a narrow screen, and the name
// does not repeat beside it; Edit opens with the path in a box as wide as the
// row, at its end, as does a path Choose folder… or Keep saved folder puts
// there, while a keystroke never moves it; a remote device shows the name alone.
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

const STANDING_NOTE = "Changes apply from your next message, also in a conversation you already started.";
const ANSWERING_LINE = "The room is answering. You can save when it has finished.";
const CLEAR_ANSWERING_LINE = "The room is answering. You can change this when it has finished.";
const SERVER_ANSWERING_LINE = "The room is answering right now. Save again when it has finished; nothing was changed.";
const GONE_FOLDER_LINE = "This folder was not found on this computer. Choose it again, or another one, in Edit\u00a0workspace.";
const BASH_ROW_LINE = "Lets the room run commands on this computer, like a terminal. Off by default. Whether each command asks you first is set at the top of the chat.";
const FULL_PATH_LINE = `Use the folder's full path, for example ${process.platform === "win32" ? "C:\\Users\\you\\Projects" : process.platform === "darwin" ? "/Users/you/Projects" : "/home/you/projects"}.`;
const HIDDEN_PATH_LINE = "The full path stays on this computer and is not shown here.";
const HOLDS_APP_DATA_LINE = "This folder contains exxperts' own data, so a room can't work in it. Choose a project folder instead, such as one in Documents.";

// A folder's refusal starts at the folder box's left edge, under the box and every button beside
// or under it, and ends at the buttons' right edge: it is not in the Folder label's column.
async function assertUnderFolderBox(folderRow: Locator, refusal: string): Promise<void> {
	const box = await folderRow.getByLabel("Workspace folder path").boundingBox();
	const controls = await folderRow.locator(".workspace-folder-controls").boundingBox();
	const line = await folderRow.getByText(refusal, { exact: true }).boundingBox();
	const label = await folderRow.locator(".settings-row-label").boundingBox();
	assert(box && controls && line && label, `the folder box, its buttons and the refusal are on screen: ${refusal}`);
	const buttonsBottom = Math.max(...(await folderRow.locator(".workspace-folder-controls .rs-btn").evaluateAll((els) => els.map((el) => el.getBoundingClientRect().bottom))));
	assert(line.y >= box.y + box.height - 0.5 && line.y >= buttonsBottom - 0.5, `the folder's refusal sits under the box and its buttons (line top ${line.y}, box bottom ${box.y + box.height}, buttons bottom ${buttonsBottom}): ${refusal}`);
	assert(Math.abs(line.x - box.x) <= 1, `the folder's refusal starts at the box's left edge (line ${line.x}, box ${box.x}): ${refusal}`);
	assert(Math.abs(line.x + line.width - (controls.x + controls.width)) <= 1, `the folder's refusal is as wide as the box and buttons together (line right ${line.x + line.width}, buttons right ${controls.x + controls.width}): ${refusal}`);
	assert(line.x > label.x + label.width || line.y >= label.y + label.height, `the folder's refusal is not in the Folder label's column: ${refusal}`);
}

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

async function createRoom(displayName: string): Promise<string> {
	const created = await api("/api/persistent-agents", { method: "POST", body: JSON.stringify({ displayName, userName: "Synthetic User", preferredUserAddress: "Synthetic User" }) });
	assert(created.status === 201, `${displayName} is created, got ${created.status}`);
	return String(created.body?.agent?.id ?? "");
}

async function saveWorkspace(agentId: string, body: Record<string, unknown>): Promise<void> {
	const saved = await api(`/api/persistent-agents/${encodeURIComponent(agentId)}/workspace-default`, { method: "PUT", body: JSON.stringify(body) });
	assert(saved.status === 200, `the workspace is saved, got ${saved.status} ${JSON.stringify(saved.body)}`);
}

async function openPane(page: Page, roomName: string, paneName: "Workspace" | "Skills") {
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

function rowValue(pane: ReturnType<Page["locator"]>, label: string) {
	return pane.locator(".settings-row").filter({ has: pane.page().locator(".settings-row-label", { hasText: new RegExp(`^${label}$`) }) }).locator(".settings-row-value");
}

// What a screen reader hears beside a button: the text of the element its aria-describedby names.
async function describedBy(button: Locator): Promise<string | null> {
	return button.evaluate((el) => {
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
	const noToolsDesk = await createRoom("No Tools Desk");
	await saveWorkspace(noToolsDesk, { root: demo, workspaceAccessMode: "localFiles", toolSelection: { kind: "custom", allowedToolNames: [] }, bashEnabled: false });
	const longDesk = await createRoom("Long Desk");
	await saveWorkspace(longDesk, { root: longFolder, workspaceAccessMode: "localFiles" });
	const goneDesk = await createRoom("Gone Desk");
	await saveWorkspace(goneDesk, { root: goneFolder, workspaceAccessMode: "localFiles" });
	fs.rmSync(goneFolder, { recursive: true, force: true });
	const clearDesk = await createRoom("Clear Desk");
	await saveWorkspace(clearDesk, { root: demo, workspaceAccessMode: "localFiles" });
	await createRoom("Empty Desk");
	const placeDesk = await createRoom("Place Desk");
	await saveWorkspace(placeDesk, { root: demo, workspaceAccessMode: "localFiles", bashEnabled: false });
	const busyDesk = await createRoom("Busy Desk");
	await saveWorkspace(busyDesk, { root: demo, workspaceAccessMode: "localFiles", bashEnabled: false });
	const heardDesk = await createRoom("Heard Desk");
	await saveWorkspace(heardDesk, { root: demo, workspaceAccessMode: "localFiles", bashEnabled: false });
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
	const bashOn = async (agentId: string) => (await api(`/api/persistent-agents/${encodeURIComponent(agentId)}/workspace-default`)).body?.policy?.bashEnabled === true;
	const savedRoot = async (agentId: string) => String((await api(`/api/persistent-agents/${encodeURIComponent(agentId)}/workspace-default`)).body?.policy?.roots?.[0]?.basename ?? "");

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

		// 1. One access label, the tools in the editor's order, one verb for setting the folder,
		// one word for the computer, and a standing note that says only when changes apply.
		if (!only || only === "labels") {
			const pane = await openPane(page, "Bounded Desk", "Workspace");
			await pane.locator(".settings-row-tag").first().waitFor({ timeout: 10_000 });
			const tag = await pane.locator(".settings-row-tag").first().textContent();
			assert(tag === "Bounded", `a Bounded room's tag says Bounded, as the editor does, got ${tag}`);
			const tools = await rowValue(pane, "Tools").textContent();
			assert(tools === "Read, List, Find, Search, Write, Edit", `the tools read in the editor's order, got ${tools}`);
			const text = await pane.innerText();
			assert(text.includes(STANDING_NOTE), `the pane says when changes apply, got: ${text}`);
			assert(!text.includes("saved while the room is answering"), `the standing note no longer warns about an answer that isn't running, got: ${text}`);
			await closeSettings(page);
			const card = page.locator(".persistent-agent-card").filter({ hasText: "Empty Desk" });
			await card.getByRole("button", { name: /^(Enter|Resume) →$/ }).click();
			const nudge = page.locator(".room-workspace-nudge-text");
			await nudge.waitFor({ timeout: 10_000 });
			assert(await nudge.textContent() === "Set a folder so this room can read and write files.", `the room's nudge uses the pane's verb, got ${await nudge.textContent()}`);
			await page.evaluate(() => { window.location.hash = "#/"; });
			console.log("  ok  one label, one tool order, one verb, one note on when changes apply");
		}

		// 2. A room with no tool at all is not called read-only.
		if (!only || only === "notools") {
			const pane = await openPane(page, "No Tools Desk", "Workspace");
			await rowValue(pane, "Tools").waitFor({ timeout: 10_000 });
			const text = await pane.innerText();
			assert(text.includes("With no tools on, this room can't see or change files here."), `no tools reads as no tools, got: ${text}`);
			assert(!text.includes("it can see files here"), "a room with no tools is never told it can see files");
			await closeSettings(page);
			console.log("  ok  no tools says the room can't see files");
		}

		// 3. A long folder name stays inside the pane, and the access tag stays in view. On this computer the
		// name ends the full path and does not repeat beside it; on a remote device, which is sent no path,
		// the name shows beside the tag, cut with "…", with the whole name in its tooltip.
		if (!only || only === "long") {
			const pane = await openPane(page, "Long Desk", "Workspace");
			const shownPath = pane.locator(".workspace-folder-path");
			await shownPath.waitFor({ timeout: 10_000 });
			const paneBox = await pane.locator(".room-workspace-section").boundingBox();
			const tagBox = await pane.locator(".settings-row-tag").first().boundingBox();
			const pathBox = await shownPath.boundingBox();
			assert(paneBox && tagBox && pathBox, "the folder row is laid out");
			assert(tagBox.x + tagBox.width <= paneBox.x + paneBox.width + 1, `the access tag stays inside the pane, its right edge ${tagBox.x + tagBox.width} against ${paneBox.x + paneBox.width}`);
			assert(pathBox.x + pathBox.width <= tagBox.x, "the path ends before the tag");
			assert(String(await shownPath.textContent()).endsWith(path.basename(longFolder)), `the path ends in the folder's name, got ${await shownPath.textContent()}`);
			assert(await pane.locator(".workspace-folder-name").count() === 0, "on this computer the folder's name does not repeat beside its path");
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
				const remotePane = await openPane(remotePage, "Long Desk", "Workspace");
				const name = remotePane.locator(".workspace-folder-name");
				await name.waitFor({ timeout: 10_000 });
				const remotePaneBox = await remotePane.locator(".room-workspace-section").boundingBox();
				const remoteTagBox = await remotePane.locator(".settings-row-tag").first().boundingBox();
				const nameBox = await name.boundingBox();
				assert(remotePaneBox && remoteTagBox && nameBox, "the remote folder row is laid out");
				assert(remoteTagBox.x + remoteTagBox.width <= remotePaneBox.x + remotePaneBox.width + 1, `on a remote device the access tag stays inside the pane, its right edge ${remoteTagBox.x + remoteTagBox.width} against ${remotePaneBox.x + remotePaneBox.width}`);
				assert(nameBox.x + nameBox.width <= remoteTagBox.x, "on a remote device the folder name ends before the tag");
				assert(await name.getAttribute("title") === path.basename(longFolder), "on a remote device the whole name is in the name's tooltip");
				assert(await remotePane.locator(".workspace-folder-path").count() === 0, "on a remote device the row shows no path");
			} finally {
				await remoteContext.close();
			}
			console.log("  ok  a long folder name stays inside the pane, once on this computer and beside the tag on a remote device");
		}

		// 4. A folder that is gone says so in its own row, in place of the access, and lists no tools;
		// no line under the pane repeats it; the editor says so too.
		if (!only || only === "gone") {
			const pane = await openPane(page, "Gone Desk", "Workspace");
			await rowValue(pane, "Tools").waitFor({ timeout: 10_000 });
			assert(await rowValue(pane, "Tools").textContent() === "Off until the folder is found", `a gone folder's tools are off, got ${await rowValue(pane, "Tools").textContent()}`);
			assert(await rowValue(pane, "Bash").count() === 0, "a gone folder shows no Bash row");
			const folderRow = pane.locator(".settings-row").filter({ has: page.locator(".settings-row-label", { hasText: /^Folder$/ }) });
			const tag = await folderRow.locator(".settings-row-tag").textContent();
			assert(tag === "Not found", `the Folder row's tag says Not found, in place of the access, got ${tag}`);
			const line = await folderRow.locator(".settings-row-sub").textContent();
			assert(line === GONE_FOLDER_LINE, `the Folder row says the folder was not found and where to choose it again, got ${line}`);
			assert(!(await folderRow.locator(".workspace-folder-name").evaluate((el) => el.scrollWidth > el.clientWidth)), "the folder's short name shows whole beside the longer line");
			const summary = await pane.innerText();
			assert(!summary.includes('The saved workspace folder "gone-soon"') && (await pane.locator("li").count()) === 0, `no line under the pane repeats it, got: ${summary}`);
			await pane.getByRole("button", { name: "Edit workspace" }).click();
			const text = await pane.innerText();
			assert(text.includes("gone-soon was not found on this computer. Pick it again, or another folder."), `the editor says the folder is gone, got: ${text}`);
			await pane.getByRole("button", { name: "Cancel" }).click();
			await closeSettings(page);
			console.log("  ok  a gone folder says so in its row and lists no tools");
		}

		// 5. Clear asks first, and says what happened in plain words.
		if (!only || only === "clear") {
			const pane = await openPane(page, "Clear Desk", "Workspace");
			await pane.getByRole("button", { name: "Clear" }).click();
			const question = page.getByRole("alertdialog", { name: "Clear this room's workspace?" });
			await question.waitFor({ timeout: 10_000 });
			await question.getByRole("button", { name: "Cancel" }).click();
			await page.waitForTimeout(400);
			assert(await savedRoot(clearDesk) === "demo", "Cancel keeps the folder");
			await pane.getByRole("button", { name: "Clear" }).click();
			await question.getByRole("button", { name: "Clear" }).click();
			await waitUntil(async () => (await savedRoot(clearDesk)) === "", "Clear removes the folder");
			await pane.getByText("Folder removed.", { exact: true }).waitFor({ timeout: 10_000 });
			assert(!(await pane.innerText()).includes("until you set one again"), "the line after Clear does not repeat the paragraph above it");
			await closeSettings(page);
			console.log("  ok  Clear asks first");
		}

		// 6. A failed load says so and offers Try again, never "No workspace yet".
		if (!only || only === "loadfail") {
			let failing = true;
			await page.route("**/api/persistent-agents/*/workspace-default", (route) => (failing && route.request().method() === "GET" ? route.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ error: "Bad Request" }) }) : route.continue()));
			const pane = await openPane(page, "Full Desk", "Workspace");
			await pane.getByText("Couldn't load this room's workspace.").waitFor({ timeout: 10_000 });
			const text = await pane.innerText();
			assert(!text.includes("No workspace yet") && !text.includes("Bad Request"), `a failed load is not "No workspace yet" nor the raw error, got: ${text}`);
			// While the room's Bash is unknown, the skill's files line says only what is true.
			await page.locator(".settings-dialog-nav-item").filter({ hasText: /^Skills/ }).first().click();
			const unknownLine = page.locator(".room-settings-section:not([hidden]) .room-skill-files-row .settings-row-sub");
			await unknownLine.waitFor({ timeout: 10_000 });
			await waitUntil(async () => /^Allowed\. Its files? runs? only while this room's Bash is on\./.test(String(await unknownLine.textContent())), "the files line says only what is true while Bash is unknown");
			await page.locator(".settings-dialog-nav-item").filter({ hasText: /^Workspace$/ }).first().click();
			failing = false;
			await pane.getByRole("button", { name: "Try again" }).click();
			await rowValue(pane, "Tools").waitFor({ timeout: 10_000 });
			await page.unroute("**/api/persistent-agents/*/workspace-default");
			await closeSettings(page);
			console.log("  ok  a failed load offers Try again");
		}

		// 7. An allowed skill's files say they run only with Bash on, and follow a Bash change at once.
		if (!only || only === "skills") {
			const skills = await openPane(page, "Full Desk", "Skills");
			const filesLine = skills.locator(".room-skill-files-row .settings-row-sub");
			await filesLine.waitFor({ timeout: 10_000 });
			await waitUntil(async () => /^Allowed\. Its (file runs|\d+ files run) only while this room's Bash is on; turn it on under Workspace\. /.test(String(await filesLine.textContent())), `with Bash off the files line says they run only with Bash on and where to turn it on, got ${await filesLine.textContent()}`);
			await page.locator(".settings-dialog-nav-item").filter({ hasText: /^Workspace$/ }).first().click();
			const pane = page.locator(".room-settings-section:not([hidden])");
			await pane.getByRole("button", { name: "Edit workspace" }).click();
			await pane.getByLabel("Bash shell access").check();
			await pane.getByRole("button", { name: "Save changes" }).click();
			await pane.getByText("Saved.", { exact: true }).waitFor({ timeout: 10_000 });
			await page.locator(".settings-dialog-nav-item").filter({ hasText: /^Skills/ }).first().click();
			await waitUntil(async () => /^Allowed\. The room may run its (file as it is|\d+ files as they are) now\. /.test(String(await filesLine.textContent())), `with Bash on the files line says they may run, got ${await filesLine.textContent()}`);
			await closeSettings(page);
			console.log("  ok  a skill's files line follows the room's Bash");
		}

		// 8. The editor's Bash row says what Bash is, in a person's words.
		if (!only || only === "bashrow") {
			const pane = await openPane(page, "Place Desk", "Workspace");
			await pane.getByRole("button", { name: "Edit workspace" }).click();
			const bashLine = pane.locator("label.settings-row").filter({ has: page.getByLabel("Bash shell access") }).locator(".settings-row-sub").first();
			assert(await bashLine.textContent() === BASH_ROW_LINE, `the editor's Bash row says what Bash is, got ${await bashLine.textContent()}`);
			await pane.getByRole("button", { name: "Cancel" }).click();
			await closeSettings(page);
			console.log("  ok  the editor's Bash row says what Bash is");
		}

		// 9. A refusal shows by what it is about: a folder's under the folder box and its buttons, from
		// the box's left edge to the buttons' right edge (at 390px under the buttons, which go under
		// the box there), a save's beside the buttons, a wait in the muted colour and any other
		// refusal in red.
		if (!only || only === "beside") {
			const pane = await openPane(page, "Place Desk", "Workspace");
			await pane.getByRole("button", { name: "Edit workspace" }).click();
			const head = pane.locator(".pane-head");
			const folderRow = pane.locator(".settings-row").filter({ has: page.locator(".settings-row-label", { hasText: /^Folder$/ }) });
			const folderBox = pane.getByLabel("Workspace folder path");
			const save = pane.getByRole("button", { name: "Save changes" });
			for (const [typed, refusal] of [["Projects/demo", FULL_PATH_LINE], [tempHome, HOLDS_APP_DATA_LINE]]) {
				await folderBox.fill(typed);
				await save.click();
				await folderRow.getByText(refusal, { exact: true }).waitFor({ timeout: 10_000 });
				assert(await pane.getByText(refusal, { exact: true }).count() === 1, `the folder's refusal shows once, under the Folder row: ${refusal}`);
				assert(!(await head.innerText()).includes(refusal), `the folder's refusal is not beside the buttons: ${refusal}`);
				await assertUnderFolderBox(folderRow, refusal);
			}
			await page.setViewportSize({ width: 390, height: 844 });
			await assertUnderFolderBox(folderRow, HOLDS_APP_DATA_LINE);
			await page.setViewportSize({ width: 1280, height: 900 });
			const muted = await head.locator(".pane-head-text p").first().evaluate((el) => getComputedStyle(el).color);
			// The server refuses a save that lands while the room answers; its line waits beside Save, muted.
			await page.route("**/api/persistent-agents/*/workspace-default", (route) => (route.request().method() === "PUT" ? route.fulfill({ status: 409, contentType: "application/json", body: JSON.stringify({ error: SERVER_ANSWERING_LINE, code: "active_turn_in_flight" }) }) : route.continue()));
			await folderBox.fill(projects);
			await save.click();
			const waitLine = head.getByText(SERVER_ANSWERING_LINE, { exact: true });
			await waitLine.waitFor({ timeout: 10_000 });
			assert(await pane.getByText(SERVER_ANSWERING_LINE, { exact: true }).count() === 1, "the server's wait line shows once, beside the buttons");
			assert(await waitLine.evaluate((el) => getComputedStyle(el).color) === muted, "the server's wait line is in the muted colour, not a refusal's red");
			await page.unroute("**/api/persistent-agents/*/workspace-default");
			// Any other failed save shows beside the buttons too, in red.
			await page.route("**/api/persistent-agents/*/workspace-default", (route) => (route.request().method() === "PUT" ? route.fulfill({ status: 500, body: "" }) : route.continue()));
			await save.click();
			const failLine = head.getByText("Couldn't save the workspace. Try again.", { exact: true });
			await failLine.waitFor({ timeout: 10_000 });
			assert(await failLine.evaluate((el) => getComputedStyle(el).color) !== muted, "a failed save beside the buttons is in a refusal's colour");
			await page.unroute("**/api/persistent-agents/*/workspace-default");
			await folderBox.fill(demo);
			await save.click();
			await pane.getByText("Saved.", { exact: true }).waitFor({ timeout: 10_000 });
			assert(!(await head.innerText()).includes("Couldn't save"), "a save that works takes the old line away");
			await closeSettings(page);
			console.log("  ok  a refusal shows by what it is about");
		}

		// 10. While the room answers, saving waits: Save changes, Save and close and Clear are greyed with
		// one muted line beside them, in the room and from Home, and Clear asks nothing; they work again
		// as soon as the answer has finished. Beside a greyed Clear the line says "change", not "save".
		if (!only || only === "answering") {
			const card = page.locator(".persistent-agent-card").filter({ hasText: "Busy Desk" });
			await card.getByRole("button", { name: /^(Enter|Resume) →$/ }).click();
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
			const pane = page.locator(".room-settings-section:not([hidden]) .room-workspace-section");
			const head = pane.locator(".pane-head");
			const clear = pane.getByRole("button", { name: "Clear" });
			await clear.waitFor({ timeout: 10_000 });
			const muted = await head.locator(".pane-head-text p").first().evaluate((el) => getComputedStyle(el).color);
			assert(await clear.isDisabled(), "Clear is greyed while the room answers");
			const line = head.getByText(CLEAR_ANSWERING_LINE, { exact: true });
			assert(await line.isVisible(), `the reason shows beside the buttons, for a change rather than a save, got: ${await head.innerText()}`);
			assert(await line.evaluate((el) => getComputedStyle(el).color) === muted, "the reason is in the muted colour");
			await clear.click({ force: true, timeout: 2_000 }).catch(() => {});
			await page.waitForTimeout(400);
			assert(await page.getByRole("alertdialog").count() === 0, "a greyed Clear asks no question");
			assert(await pane.getByRole("button", { name: "Edit workspace" }).isEnabled(), "Edit workspace stays open while the room answers");

			await pane.getByRole("button", { name: "Edit workspace" }).click();
			await pane.getByLabel("Bash shell access").check();
			const saveChanges = pane.getByRole("button", { name: "Save changes" });
			assert(await saveChanges.isDisabled(), "Save changes is greyed while the room answers");
			assert(await head.getByText(ANSWERING_LINE, { exact: true }).isVisible(), "the reason shows beside Save changes");
			await page.keyboard.press("Escape");
			const question = page.getByRole("alertdialog", { name: "Unsaved changes" });
			await question.waitFor({ timeout: 5_000 });
			const saveAndClose = question.getByRole("button", { name: "Save and close" });
			assert(await saveAndClose.isDisabled(), "Save and close is greyed while the room answers");
			assert(await question.getByText(ANSWERING_LINE, { exact: true }).isVisible(), "the question says why beside its buttons");

			letAnswersFinish();
			await waitUntil(async () => await saveAndClose.isEnabled(), "Save and close works again once the answer has finished");
			assert(await question.getByText(ANSWERING_LINE, { exact: true }).count() === 0, "the question's reason goes with the answer");
			await question.getByRole("button", { name: "Keep editing" }).click();
			await waitUntil(async () => await saveChanges.isEnabled(), "Save changes works again once the answer has finished");
			assert(await head.getByText(ANSWERING_LINE, { exact: true }).count() === 0, "the reason beside the buttons goes with the answer");
			await saveChanges.click();
			await pane.getByText("Saved.", { exact: true }).waitFor({ timeout: 10_000 });
			assert(await bashOn(busyDesk), "the save went through once the answer had finished");
			await closeSettings(page);

			// From Home, while the room goes on answering with nobody inside, Clear is greyed the same way.
			holding = true;
			await composer.fill("And one more, slowly.");
			await send.click();
			await waitUntil(() => heldAnswers.length > 0, "the room is answering again");
			await page.locator(".stop-btn").first().waitFor({ timeout: 10_000 });
			await page.evaluate(() => { window.location.hash = "#/"; });
			const home = await openPane(page, "Busy Desk", "Workspace");
			const homeClear = home.getByRole("button", { name: "Clear" });
			await homeClear.waitFor({ timeout: 10_000 });
			await waitUntil(async () => await homeClear.isDisabled(), "from Home, Clear is greyed while the room answers");
			assert(await home.locator(".pane-head").getByText(CLEAR_ANSWERING_LINE, { exact: true }).isVisible(), "from Home, the reason shows beside the buttons");
			letAnswersFinish();
			await waitUntil(async () => await homeClear.isEnabled(), "from Home, Clear works again once the answer has finished", 20_000);
			assert(await home.locator(".pane-head").getByText(CLEAR_ANSWERING_LINE, { exact: true }).count() === 0, "from Home, the reason goes with the answer");
			await closeSettings(page);
			console.log("  ok  while the room answers, saving waits greyed with the reason beside it");
		}

		// 11. A save the server refuses for an answer the page had not seen: from Home, the room starts
		// answering elsewhere; the refusal makes the page look again, so the buttons grey with the page's
		// own line and come back by themselves once the answer has finished.
		if (!only || only === "refused") {
			const pane = await openPane(page, "Edge Desk", "Workspace");
			await pane.getByRole("button", { name: "Edit workspace" }).click();
			await pane.getByLabel("Bash shell access").check();
			const head = pane.locator(".pane-head");
			const saveChanges = pane.getByRole("button", { name: "Save changes" });
			assert(await saveChanges.isEnabled(), "Save changes works while the page knows of no answer");
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
				await saveChanges.click();
				await waitUntil(async () => await saveChanges.isDisabled(), "after the refusal, Save changes is greyed while the room answers");
				assert(await head.getByText(ANSWERING_LINE, { exact: true }).isVisible(), `after the refusal, the page's own line shows, got: ${await head.innerText()}`);
				letAnswersFinish();
				await waitUntil(async () => await saveChanges.isEnabled(), "Save changes comes back by itself once the answer has finished", 20_000);
				await saveChanges.click();
				await pane.getByText("Saved.", { exact: true }).waitFor({ timeout: 10_000 });
				assert(await bashOn(edgeDesk), "the save went through once the answer had finished");
			} finally {
				socket.close();
			}
			await closeSettings(page);
			console.log("  ok  a save refused for an answer the page had not seen greys the buttons until it has finished");
		}

		// 12. A greyed button carries its reason for a screen reader; a failed save beside the buttons is
		// announced at once, and the server's wait line stays a quiet status.
		if (!only || only === "heard") {
			const card = page.locator(".persistent-agent-card").filter({ hasText: "Heard Desk" });
			await card.getByRole("button", { name: /^(Enter|Resume) →$/ }).click();
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
			const pane = page.locator(".room-settings-section:not([hidden]) .room-workspace-section");
			const head = pane.locator(".pane-head");
			const clear = pane.getByRole("button", { name: "Clear" });
			await clear.waitFor({ timeout: 10_000 });
			assert(await describedBy(clear) === CLEAR_ANSWERING_LINE, `a greyed Clear carries its reason, got ${await describedBy(clear)}`);
			await pane.getByRole("button", { name: "Edit workspace" }).click();
			await pane.getByLabel("Bash shell access").check();
			const saveChanges = pane.getByRole("button", { name: "Save changes" });
			assert(await describedBy(saveChanges) === ANSWERING_LINE, `a greyed Save changes carries its reason, got ${await describedBy(saveChanges)}`);
			await page.keyboard.press("Escape");
			const question = page.getByRole("alertdialog", { name: "Unsaved changes" });
			await question.waitFor({ timeout: 5_000 });
			const saveAndClose = question.getByRole("button", { name: "Save and close" });
			assert(await describedBy(saveAndClose) === ANSWERING_LINE, `a greyed Save and close carries its reason, got ${await describedBy(saveAndClose)}`);
			letAnswersFinish();
			await waitUntil(async () => await saveAndClose.isEnabled(), "Save and close works again once the answer has finished");
			assert(await describedBy(saveAndClose) === null, "Save and close carries no reason once it works");
			await question.getByRole("button", { name: "Keep editing" }).click();
			await waitUntil(async () => await saveChanges.isEnabled(), "Save changes works again once the answer has finished");
			assert(await describedBy(saveChanges) === null, "Save changes carries no reason once it works");
			await page.route("**/api/persistent-agents/*/workspace-default", (route) => (route.request().method() === "PUT" ? route.fulfill({ status: 500, body: "" }) : route.continue()));
			await saveChanges.click();
			const failLine = head.getByText("Couldn't save the workspace. Try again.", { exact: true });
			await failLine.waitFor({ timeout: 10_000 });
			assert(await failLine.getAttribute("role") === "alert", `a failed save beside the buttons is announced, got role ${await failLine.getAttribute("role")}`);
			await page.unroute("**/api/persistent-agents/*/workspace-default");
			await page.route("**/api/persistent-agents/*/workspace-default", (route) => (route.request().method() === "PUT" ? route.fulfill({ status: 409, contentType: "application/json", body: JSON.stringify({ error: SERVER_ANSWERING_LINE, code: "active_turn_in_flight" }) }) : route.continue()));
			await saveChanges.click();
			const waitLine = head.getByText(SERVER_ANSWERING_LINE, { exact: true });
			await waitLine.waitFor({ timeout: 10_000 });
			assert(await waitLine.getAttribute("role") === "status", `the server's wait line stays a quiet status, got role ${await waitLine.getAttribute("role")}`);
			await page.unroute("**/api/persistent-agents/*/workspace-default");
			await pane.getByRole("button", { name: "Cancel" }).click();
			await closeSettings(page);
			await page.evaluate(() => { window.location.hash = "#/"; });
			await page.locator(".persistent-agent-card").first().waitFor({ timeout: 10_000 });
			console.log("  ok  a greyed button carries its reason; a failed save is announced");
		}

		// 13. On a shared server an allowed skill's files never run, and the line says so in the shape of the others.
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
				await waitUntil(async () => /^Allowed\. On a shared server, its file never runs\. /.test(String(await filesLine(skillName).textContent())), `one file on a shared server, got ${await filesLine(skillName).textContent()}`);
				await waitUntil(async () => /^Allowed\. On a shared server, its 2 files never run\. /.test(String(await filesLine(pairSkillName).textContent())), `two files on a shared server, got ${await filesLine(pairSkillName).textContent()}`);
			} finally {
				await sharedContext.close();
			}
			console.log("  ok  on a shared server, a skill's files line says they never run");
		}

		// 14. On this computer the Folder row shows the folder's full path, as the computer writes it, with
		// the access tag and not the name beside it, and no line about a hidden path; Edit opens with the
		// path in a box as wide as the row, at the path's end, and nothing unsaved; at 390 px a long path
		// wraps inside the row and the page never scrolls sideways.
		if (!only || only === "fullpath") {
			const pane = await openPane(page, "Path Desk", "Workspace");
			await rowValue(pane, "Tools").waitFor({ timeout: 10_000 });
			const folderRow = pane.locator(".settings-row").filter({ has: page.locator(".settings-row-label", { hasText: /^Folder$/ }) });
			const shownPath = folderRow.locator(".workspace-folder-path");
			assert(await shownPath.count() === 1 && await shownPath.textContent() === deepFolder, `the Folder row shows the folder's full path, got ${await folderRow.innerText()}`);
			assert(!(await pane.innerText()).includes(HIDDEN_PATH_LINE), `no line says the path is not shown, got: ${await pane.innerText()}`);
			assert(await folderRow.locator(".workspace-folder-name").count() === 0, `the folder's name does not repeat beside its path, got ${await folderRow.innerText()}`);
			assert(await folderRow.locator(".settings-row-tag").textContent() === "Full access", `the access tag stays beside the path, got ${await folderRow.locator(".settings-row-tag").textContent()}`);
			await pane.getByRole("button", { name: "Edit workspace" }).click();
			const folderBox = pane.getByLabel("Workspace folder path");
			assert(await folderBox.inputValue() === deepFolder, `Edit opens with the saved path in its box, got ${await folderBox.inputValue()}`);
			assert(await pane.locator(".workspace-unsaved-hint").count() === 0, "the saved path in the box is not an unsaved change");
			assert(await pane.getByRole("button", { name: "Keep saved folder" }).count() === 0, "the saved path in the box offers no Keep saved folder");
			// The box takes the row's width on its own line under Folder and its sentence, with Choose folder… beside it at its end.
			const editRowBox = await folderRow.boundingBox();
			const sentenceBox = await folderRow.locator(".settings-row-sub").first().boundingBox();
			const folderBoxBox = await folderBox.boundingBox();
			const chooseBox = await folderRow.getByRole("button", { name: "Choose folder…" }).boundingBox();
			assert(editRowBox && sentenceBox && folderBoxBox && chooseBox, "the Folder row, its sentence, the box and Choose folder… are laid out");
			assert(folderBoxBox.y >= sentenceBox.y + sentenceBox.height - 0.5, `the box is on its own line under Folder and its sentence (box top ${folderBoxBox.y}, sentence bottom ${sentenceBox.y + sentenceBox.height})`);
			assert(Math.abs(folderBoxBox.x - editRowBox.x) <= 1, `the box starts at the row's left edge (box ${folderBoxBox.x}, row ${editRowBox.x})`);
			assert(Math.abs(chooseBox.x + chooseBox.width - (editRowBox.x + editRowBox.width)) <= 1, `Choose folder… ends at the row's right edge (button right ${chooseBox.x + chooseBox.width}, row right ${editRowBox.x + editRowBox.width})`);
			assert(chooseBox.x >= folderBoxBox.x + folderBoxBox.width && Math.abs(chooseBox.y + chooseBox.height / 2 - (folderBoxBox.y + folderBoxBox.height / 2)) <= 2, "Choose folder… sits beside the box, at its end");
			assert(folderBoxBox.width + chooseBox.width + 24 >= editRowBox.width, `the box takes the row's width beside its button (box ${folderBoxBox.width}, button ${chooseBox.width}, row ${editRowBox.width})`);
			// A path longer than the box opens at its end, so the folder's name is in view.
			const boxScroll = async () => folderBox.evaluate((el) => ({ left: (el as HTMLInputElement).scrollLeft, max: (el as HTMLInputElement).scrollWidth - (el as HTMLInputElement).clientWidth }));
			const wideScroll = await boxScroll();
			assert(wideScroll.max > 0, `the long path is longer than the box at 1280 px, got ${JSON.stringify(wideScroll)}`);
			assert(wideScroll.left >= wideScroll.max - 1, `the box opens at the path's end, got ${JSON.stringify(wideScroll)}`);
			await pane.getByRole("button", { name: "Cancel" }).click();
			await page.setViewportSize({ width: 390, height: 844 });
			await pane.getByRole("button", { name: "Edit workspace" }).click();
			const narrowScroll = await boxScroll();
			assert(narrowScroll.max > 0 && narrowScroll.left >= narrowScroll.max - 1, `at 390 px the box opens at the path's end, got ${JSON.stringify(narrowScroll)}`);
			assert(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), "the editor does not scroll sideways at 390 px");
			await pane.getByRole("button", { name: "Cancel" }).click();
			await shownPath.waitFor({ timeout: 10_000 });
			const rowBox = await folderRow.boundingBox();
			const pathBox = await shownPath.boundingBox();
			assert(rowBox && pathBox, "the Folder row and its path are laid out at 390 px");
			assert(pathBox.x + pathBox.width <= rowBox.x + rowBox.width + 1, `the path stays inside the row at 390 px (path right ${pathBox.x + pathBox.width}, row right ${rowBox.x + rowBox.width})`);
			const lineHeight = await shownPath.evaluate((el) => parseFloat(getComputedStyle(el).lineHeight) || 19);
			assert(pathBox.height > lineHeight * 1.5, `the long path wraps onto more lines at 390 px, got height ${pathBox.height}`);
			assert(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), "the page does not scroll sideways at 390 px");
			await page.setViewportSize({ width: 1280, height: 900 });
			await closeSettings(page);
			console.log("  ok  on this computer the Folder row shows the full path and Edit holds it");
		}

		// 14b. A path the app puts in the box shows its end, as on open: one from Choose folder… (the system
		// dialog stood in for) and the saved one put back by Keep saved folder; a keystroke never moves the box.
		if (!only || only === "choosepath") {
			const pane = await openPane(page, "Path Desk", "Workspace");
			await rowValue(pane, "Tools").waitFor({ timeout: 10_000 });
			await pane.getByRole("button", { name: "Edit workspace" }).click();
			const folderBox = pane.getByLabel("Workspace folder path");
			const boxScroll = async () => folderBox.evaluate((el) => ({ left: (el as HTMLInputElement).scrollLeft, max: (el as HTMLInputElement).scrollWidth - (el as HTMLInputElement).clientWidth }));
			// Longer than the saved path, so the box's old place is not already its end.
			const chosenFolder = path.join(longFolder, "Entwürfe und Fassungen für die Kunden im Herbst");
			await page.route("**/api/system/choose-folder", (route) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ supported: true, cancelled: false, path: chosenFolder }) }));
			try {
				await pane.getByRole("button", { name: "Choose folder…" }).click();
				await waitUntil(async () => (await folderBox.inputValue()) === chosenFolder && await folderBox.isEnabled(), `the chosen path is in the box, got ${await folderBox.inputValue()}`);
			} finally {
				await page.unroute("**/api/system/choose-folder");
			}
			const chosenScroll = await boxScroll();
			assert(chosenScroll.max > 0, `the chosen path is longer than the box at 1280 px, got ${JSON.stringify(chosenScroll)}`);
			assert(chosenScroll.left >= chosenScroll.max - 1, `a chosen path shows its end, got ${JSON.stringify(chosenScroll)}`);
			// Typing at the path's start keeps the caret and the view there.
			await folderBox.focus();
			await folderBox.press("Home");
			await folderBox.press("x");
			const typed = await folderBox.evaluate((el) => ({ caret: (el as HTMLInputElement).selectionStart, left: (el as HTMLInputElement).scrollLeft }));
			assert(typed.caret === 1 && typed.left <= 1, `a keystroke leaves the caret and the view where the person typed, got ${JSON.stringify(typed)}`);
			await folderBox.fill(projects);
			await pane.getByRole("button", { name: "Keep saved folder" }).click();
			assert(await folderBox.inputValue() === deepFolder, `Keep saved folder puts the saved path back, got ${await folderBox.inputValue()}`);
			const keptScroll = await boxScroll();
			assert(keptScroll.max > 0 && keptScroll.left >= keptScroll.max - 1, `the saved path put back shows its end, got ${JSON.stringify(keptScroll)}`);
			await pane.getByRole("button", { name: "Cancel" }).click();
			await closeSettings(page);
			console.log("  ok  a chosen or put-back path shows its end, and typing never moves the box");
		}

		// 15. A reload with unsaved workspace changes asks first.
		if (!only || only === "reload") {
			const pane = await openPane(page, "Bounded Desk", "Workspace");
			await pane.getByRole("button", { name: "Edit workspace" }).click();
			await pane.getByLabel("Workspace folder path").fill(projects);
			let asked = false;
			page.on("dialog", (dialog) => {
				if (dialog.type() === "beforeunload") asked = true;
				void dialog.dismiss();
			});
			await page.close({ runBeforeUnload: true });
			await waitUntil(() => asked, "leaving the page with unsaved changes asks first", 5_000);
			assert(await savedRoot(boundedDesk) === "demo", "nothing was saved");
			console.log("  ok  a reload with unsaved changes asks first");
		}
	} finally {
		await browser.close();
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
