// A room's protection being off outside Room settings: no "Unprotected" mark
// anywhere, beside its commands chip or on Home; the question before Run without
// asking while protection is off; and a new room's no-folder notice, which says
// the no-folder line alone, with a cross to dismiss it.
//
// A server on this Mac, in its own process, where protection runs: a room is
// On, and the route turns it off as the person does. No message is ever sent,
// so no room runs a command or a file tool and no box starts. A second server
// acts as Linux (the test switch), where the computer is why protection is
// off. The folder cause and the cause not known can't be reached on a real
// server here: a page stand-in answers the chip's read with them. A phone and
// a shared server are page stand-ins of the client context.
// Run: npm run smokes -- room-protection-marks
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, type Browser, type Page, type Request } from "playwright";
import {
	ALLOW, CANCEL, CHANGE_SAVE_FAILED, CHANGEABLE_AT_COMPUTER, CHOOSE_FOLDER, type CommandMode, COMMANDS_NO_PROTECTION_REACH, COMMANDS_UNPROTECTED_REACH, DISMISS, FREE_CONFIRM_BODY, FREE_CONFIRM_TITLE,
	MODE_LINES_PROTECTED, MODE_LINES_UNPROTECTED, MODE_NAMES, MODES_PROTECTED_LINE, MODES_PROTECTED_STAY_LINE, NO_FOLDER_LINE, RUN_WITHOUT_ASKING, RUN_WITHOUT_ASKING_BODY, RUN_WITHOUT_ASKING_TITLE,
} from "../src/room-box/card-text.js";
import { authedFetch, freePort, SMOKE_AUTH_TOKEN, SMOKE_SERVER_AUTH_ENV, SMOKE_SERVER_SPAWN_TREE_OPTIONS, smokeHomeEnv, stopSmokeServer, type AuthedFetchInit } from "./smoke-server-process.js";
import { waitEvery } from "./smoke-wait.js";

function assert(condition: unknown, message: string): asserts condition {
	if (!condition) throw new Error(message);
}

if (process.platform !== "darwin") {
	console.log("room protection marks ui smoke skipped (macOS only): protection runs only on a Mac");
	process.exit(0);
}
{
	const p = typeof chromium?.executablePath === "function" ? chromium.executablePath() : "";
	if (!p || !fs.existsSync(p)) {
		console.log("room protection marks ui smoke skipped (Chromium not installed)");
		process.exit(0);
	}
}

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const webServerDir = path.resolve(scriptDir, "..");
const repoRoot = path.resolve(webServerDir, "..", "..");
const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "exxperts-protection-marks-"));
const waitUntil = waitEvery(100, 15_000);

type Server = { baseUrl: string; home: string; process: ChildProcessWithoutNullStreams; output: string[] };
/** A server in its own process on its own home. `acting` "linux": the test switch makes this Mac read as Linux, where protection can't run. */
async function startServer(name: string, acting: "mac" | "linux"): Promise<Server> {
	const home = path.join(tempRoot, name);
	const agentDir = path.join(home, ".exxperts", "agent");
	const appDir = path.join(home, ".exxperts", "app");
	const agentsRoot = path.join(appDir, "personalized-agents");
	for (const dir of [agentDir, agentsRoot]) fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
	// A provider at an address nobody answers: the rooms only have to open, never answer.
	fs.writeFileSync(path.join(agentDir, "models.json"), JSON.stringify({ providers: { "fake-claude": { name: "Fake Claude", baseUrl: "http://127.0.0.1:9", api: "anthropic-messages", models: [{ id: "claude-fake", name: "Claude Fake", input: ["text"], contextWindow: 200000, maxTokens: 32000 }] } } }, null, 2), { mode: 0o600 });
	fs.writeFileSync(path.join(agentDir, "auth.json"), JSON.stringify({ "fake-claude": { type: "api_key", key: "synthetic-claude" } }, null, 2), { mode: 0o600 });
	fs.writeFileSync(path.join(appDir, "custom-ai-profiles.json"), JSON.stringify({ version: 1, profiles: [{ id: "custom-fake-claude", providerId: "fake-claude", label: "Fake Claude", roomModels: ["claude-fake"], learnModel: "claude-fake", reviewMemoryModel: "claude-fake" }] }, null, 2), { mode: 0o600 });
	fs.writeFileSync(path.join(appDir, "persistent-agent-ai-profile.json"), JSON.stringify({ profileId: "custom-fake-claude" }, null, 2), { mode: 0o600 });
	const port = await freePort();
	const baseUrl = `http://127.0.0.1:${port}`;
	// The Mac server drops the switch a caller may have exported, so it reads as the Mac it runs on.
	const platform = acting === "linux" ? { EXXPERTS_TEST_INTROSPECTION: "1", EXXPERTS_TEST_SHELL_PLATFORM: "linux" } : { EXXPERTS_TEST_INTROSPECTION: undefined, EXXPERTS_TEST_SHELL_PLATFORM: undefined };
	const child = spawn("npx", ["tsx", "src/index.ts"], {
		...SMOKE_SERVER_SPAWN_TREE_OPTIONS,
		cwd: webServerDir,
		env: smokeHomeEnv(home, { PORT: String(port), ...SMOKE_SERVER_AUTH_ENV, EXXETA_HOME: repoRoot, EXXPERTS_CODING_AGENT_DIR: agentDir, EXXETA_PERSISTENT_AGENTS_ROOT: agentsRoot, ...platform }) as NodeJS.ProcessEnv,
	});
	const output: string[] = [];
	child.stdout.on("data", (chunk) => output.push(String(chunk)));
	child.stderr.on("data", (chunk) => output.push(String(chunk)));
	await waitUntil(() => fetch(`${baseUrl}/healthz`).then((r) => r.ok).catch(() => false), `the ${name} server is up`, 60_000);
	return { baseUrl, home, process: child, output };
}

async function api(server: Server, pathname: string, init: AuthedFetchInit = {}): Promise<{ status: number; body: any }> {
	const response = await authedFetch(`${server.baseUrl}${pathname}`, { ...init, headers: { ...(init.body ? { "content-type": "application/json" } : {}), ...init.headers } });
	const text = await response.text();
	return { status: response.status, body: text ? JSON.parse(text) : null };
}
const roomPath = (id: string, tail = "") => `/api/persistent-agents/${encodeURIComponent(id)}${tail}`;
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/** A room as the page makes one; with a folder, in Full access, and commands on where they don't start on by themselves. */
async function createRoom(server: Server, displayName: string, withFolder: boolean): Promise<string> {
	const created = await api(server, "/api/persistent-agents", { method: "POST", body: JSON.stringify({ displayName, userName: "Synthetic User", preferredUserAddress: "Synthetic User" }) });
	assert(created.status === 201, `${displayName} is created, got ${created.status}`);
	const id = String(created.body?.agent?.id ?? "");
	if (withFolder) {
		const folder = path.join(server.home, "Projects", displayName.replace(/\W+/g, "-"));
		fs.mkdirSync(folder, { recursive: true });
		const saved = await api(server, roomPath(id, "/workspace-default"), { method: "PUT", body: JSON.stringify({ root: folder, workspaceAccessMode: "localFiles", bashEnabled: true }) });
		assert(saved.status === 200 && saved.body?.policy?.bashEnabled === true, `${displayName}'s folder with commands on, got ${saved.status} ${JSON.stringify(saved.body)}`);
	}
	return id;
}
async function turnProtection(server: Server, id: string, state: "on" | "off"): Promise<void> {
	const answer = await api(server, roomPath(id, "/protection"), { method: "PUT", body: JSON.stringify({ state }) });
	assert(answer.status === 200 && answer.body?.protection?.state === state, `Turn ${state}: ${answer.status} ${JSON.stringify(answer.body)}`);
}

/** The page at the computer, or as a phone or a shared server's member sees it through a stand-in of its client context. */
async function openPage(browser: Browser, server: Server, as: { width?: number; context?: Record<string, unknown> } = {}): Promise<{ page: Page; close: () => Promise<void> }> {
	const context = await browser.newContext({ viewport: { width: as.width ?? 1280, height: 900 } });
	const page = await context.newPage();
	if (as.context) {
		const answer = as.context;
		await page.route("**/api/remote/client-context", (route) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ capability: "full", ...answer }) }));
	}
	// Each room connection the page opens, so a row can drop one as a lost network would.
	await page.addInitScript(() => {
		const Native = window.WebSocket;
		const opened: WebSocket[] = [];
		(window as any).__roomSockets = opened;
		window.WebSocket = class extends Native {
			constructor(url: string | URL, protocols?: string | string[]) {
				super(url, protocols);
				opened.push(this);
			}
		} as typeof WebSocket;
	});
	countChipReads(page);
	await page.goto(`${server.baseUrl}/auth/session?token=${SMOKE_AUTH_TOKEN}`);
	await page.waitForLoadState("networkidle");
	const dismiss = page.locator(".whats-new-close");
	if (await dismiss.count()) await dismiss.click();
	return { page, close: () => context.close() };
}

// The page has applied an answer it has fully read: React renders it within the next frames.
async function settled(page: Page): Promise<void> {
	await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
}
const answered = (page: Page, method: string, pathname: string) => page.waitForResponse((response) => response.request().method() === method && response.url().endsWith(pathname), { timeout: 15_000 });

/** The chip's reads still on their way, by page: a row's next step waits for none. */
const chipReadsOut = new Map<Page, number>();
function countChipReads(page: Page): void {
	chipReadsOut.set(page, 0);
	const isRead = (request: Request) => request.method() === "GET" && request.url().endsWith("/bash-settings");
	page.on("request", (request) => { if (isRead(request)) chipReadsOut.set(page, (chipReadsOut.get(page) ?? 0) + 1); });
	const settles = (request: Request) => { if (isRead(request)) chipReadsOut.set(page, (chipReadsOut.get(page) ?? 0) - 1); };
	page.on("requestfinished", settles);
	page.on("requestfailed", settles);
}
/** The room's connection is open and the chip has no read out, so what it shows is what it last read. */
async function chipQuiet(page: Page): Promise<void> {
	await waitUntil(async () => (chipReadsOut.get(page) ?? 0) === 0 && await page.evaluate(() => ((window as any).__roomSockets as WebSocket[]).some((ws) => ws.url.includes("persistentAgentId=") && ws.readyState === WebSocket.OPEN)), "the room is connected and the chip has read");
	await settled(page);
}

/** Enters a room from Home and waits for its folder answer and, with `chip`, the chip shown and its reads in. */
const OPEN_NAME = "Open Desk";

async function enterRoom(page: Page, name: string, id: string, { chip }: { chip: boolean }): Promise<void> {
	await page.evaluate(() => { window.location.hash = "#/"; });
	const card = page.locator(".persistent-agent-card").filter({ has: page.locator("h2", { hasText: new RegExp(`^${name}$`) }) });
	await card.waitFor({ timeout: 10_000 });
	const folder = answered(page, "GET", roomPath(id, "/workspace-default"));
	await card.getByRole("button", { name: /^(Enter|Resume)$/ }).click();
	await (await folder).finished();
	if (chip) {
		await page.locator(".bash-mode-chip").waitFor({ timeout: 10_000 });
		await chipQuiet(page);
	}
	await settled(page);
}
/** The chip shows this mode. */
const modeShows = (page: Page, mode: CommandMode, label: string) => waitUntil(async () => (await page.locator(".bash-mode-chip-label").textContent()) === MODE_NAMES[mode], label);
const ASK = MODE_NAMES.ask;
const SEMI = MODE_NAMES.semi;
const AUTO = MODE_NAMES.auto;
/** The selector as it shows: each item's name and line, and the line under them. */
async function selectorShows(page: Page): Promise<{ items: Array<[string, string]>; under: string }> {
	const items = await page.locator(".bash-mode-option").evaluateAll((options) => options.map((option) => [option.querySelector(".bash-mode-option-name")?.textContent ?? "", option.querySelector(".bash-mode-option-line")?.textContent ?? ""] as [string, string]));
	return { items, under: (await page.locator(".bash-mode-menu-line").textContent()) ?? "" };
}

/** The chip's writes the page sends, from now on. */
function chipWrites(page: Page, id: string): Request[] {
	const sent: Request[] = [];
	page.on("request", (request) => { if (request.method() === "PUT" && request.url().endsWith(roomPath(id, "/bash-settings"))) sent.push(request); });
	return sent;
}
/** The marks the page draws, found by their word: no room carries one, so none may show anywhere. */
const marks = (page: Page) => page.getByText("Unprotected", { exact: true });
const notice = (page: Page) => page.locator(".room-workspace-nudge[role=note]");
/** The notice's words outside its buttons: the no-folder line and anything else it says. */
async function noticeWords(page: Page): Promise<string> {
	await notice(page).locator(".room-workspace-nudge-text").waitFor({ timeout: 10_000 });
	return notice(page).evaluate((element) => {
		const words = element.cloneNode(true) as HTMLElement;
		words.querySelector(".room-workspace-nudge-actions")?.remove();
		return (words.textContent ?? "").trim();
	});
}
const question = (page: Page) => page.getByRole("alertdialog", { name: RUN_WITHOUT_ASKING_TITLE });
async function openMenu(page: Page, id: string): Promise<void> {
	const read = answered(page, "GET", roomPath(id, "/bash-settings"));
	await page.locator(".bash-mode-chip").click();
	await (await read).finished();
	await chipQuiet(page);
}
/** A mode in the open selector, by its name alone: Semi's line holds the word "Asks". */
const option = (page: Page, name: string) => page.locator(".bash-mode-option").filter({ has: page.locator(".bash-mode-option-name", { hasText: new RegExp(`^${name}$`) }) });
/** Picks an option in the open menu; read on, its write leaves at once. */
async function pickNow(page: Page, id: string, label: string): Promise<any> {
	const sent = answered(page, "PUT", roomPath(id, "/bash-settings"));
	await option(page, label).click();
	const response = await sent;
	assert(response.status() === 200, `${label}: ${response.status()}`);
	assert((await question(page).count()) === 0, `${label} asked a question`);
	return JSON.parse(response.request().postData() ?? "{}");
}
/** The chip reads again, as on returning to the page. */
async function refocus(page: Page, id: string): Promise<void> {
	const read = answered(page, "GET", roomPath(id, "/bash-settings"));
	await page.evaluate(() => window.dispatchEvent(new Event("focus")));
	await (await read).finished();
	await chipQuiet(page);
}

let passed = 0;
const failures: string[] = [];
async function row(name: string, body: () => Promise<void>): Promise<void> {
	try {
		await body();
		passed += 1;
		console.log(`  ok   ${name}`);
	} catch (error) {
		failures.push(name);
		console.log(`  FAIL ${name}: ${(error as Error).message}`);
	}
}

const servers: Server[] = [];
console.log("room protection marks ui smoke");
try {
	const mac = await startServer("mac", "mac");
	servers.push(mac);
	const guarded = await createRoom(mac, "Guarded Desk", true);
	const open = await createRoom(mac, OPEN_NAME, true);
	const turning = await createRoom(mac, "Turning Desk", true);
	await turnProtection(mac, open, "off");
	const empty = await createRoom(mac, "Fresh Room", false);
	const offEmpty = await createRoom(mac, "Switched Room", false);
	await turnProtection(mac, offEmpty, "off");
	// Her Run without asking while off: its first folder's commands would run without asking, and the notice still says only the no-folder line.
	const offYes = await api(mac, roomPath(offEmpty, "/bash-settings"), { method: "PUT", body: JSON.stringify({ autoApprove: true, protection: { state: "off" } }) });
	assert(offYes.status === 200 && offYes.body?.settings?.autoApprove === true, `Switched Room runs without asking while off, got ${offYes.status} ${JSON.stringify(offYes.body)}`);
	const phoneEmpty = await createRoom(mac, "Pocket Room", false);
	const sharedEmpty = await createRoom(mac, "Member Room", false);
	for (const [id, what] of [[empty, "Fresh Room"], [offEmpty, "Switched Room"], [phoneEmpty, "Pocket Room"]] as const) {
		const read = (await api(mac, roomPath(id, "/workspace-default"))).body;
		assert(read?.commandsStartOn === true && read?.policy === null, `${what}'s first folder starts with commands on, so its row proves something: ${JSON.stringify(read)}`);
	}

	const browser = await chromium.launch();
	try {
		const { page, close } = await openPage(browser, mac);

		await row("no mark for any protection the chip reads: none read, on, this computer, not known, off by the person, the folder; with none read, no chip", async () => {
			let answer: unknown = { state: "on" };
			await page.route(`**${roomPath(guarded, "/bash-settings")}`, async (route) => {
				if (route.request().method() !== "GET") return route.continue();
				const real = await (await route.fetch()).json();
				const { protection: _real, ...rest } = real;
				await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(answer === undefined ? rest : { ...rest, protection: answer }) });
			});
			try {
				await enterRoom(page, "Guarded Desk", guarded, { chip: true });
				for (const protection of [undefined, { state: "on" }, { state: "off", cause: "computer" }, { state: "off", cause: "unknown" }, { state: "off" }, { state: "off", cause: "folder" }] as const) {
					answer = protection;
					await refocus(page, guarded);
					assert(await marks(page).count() === 0, `${JSON.stringify(protection) ?? "no protection"}: the page shows a mark`);
					assert(await page.locator(".bash-mode-chip").count() === (protection === undefined ? 0 : 1), `${JSON.stringify(protection) ?? "no protection"}: the chip ${protection === undefined ? "shows a mode it can't write" : "is gone"}`);
				}
			} finally {
				await page.unroute(`**${roomPath(guarded, "/bash-settings")}`);
			}
		});

		await row("a room turned off: no mark on Home's card or anywhere on Home, nor in the room, its header or beside its chip", async () => {
			assert(same((await api(mac, roomPath(open, "/bash-settings"))).body?.protection, { state: "off" }), "Open Desk isn't turned off, so this row proves nothing");
			await page.evaluate(() => { window.location.hash = "#/"; });
			const openCard = page.locator(".persistent-agent-card").filter({ hasText: OPEN_NAME });
			await openCard.waitFor({ timeout: 10_000 });
			await settled(page);
			assert(await marks(page).count() === 0, `Home shows ${await marks(page).count()} marks`);
			await enterRoom(page, OPEN_NAME, open, { chip: true });
			assert(await marks(page).count() === 0, `the room shows ${await marks(page).count()} marks`);
		});

		await row("the chip while On: no mark, and Ask and Semi are each one click with no question, sent in the protection read", async () => {
			await enterRoom(page, "Guarded Desk", guarded, { chip: true });
			assert(await marks(page).count() === 0, "a protected room shows a mark");
			await openMenu(page, guarded);
			const asked = await pickNow(page, guarded, ASK);
			await openMenu(page, guarded);
			const yes = await pickNow(page, guarded, SEMI);
			assert(same(asked, { autoApprove: false, protection: { state: "on" } }) && same(yes, { autoApprove: true, protection: { state: "on" } }), `On, the chip sent ${JSON.stringify(asked)} then ${JSON.stringify(yes)}`);
			await modeShows(page, "semi", "Semi");
		});

		await row("the chip while off by the person: no mark beside it; Auto asks first in the agreed words, red, with the focus on Cancel; Cancel, Escape and the backdrop send nothing; its own button sends one write in the protection read; Ask stays one click", async () => {
			await enterRoom(page, OPEN_NAME, open, { chip: true });
			assert(await marks(page).count() === 0, "a room turned off shows a mark beside its chip");
			await modeShows(page, "ask", "Ask");
			const writes = chipWrites(page, open);
			await openMenu(page, open);
			const ask = question(page);
			for (const answer of ["Cancel", "Escape", "the backdrop"] as const) {
				await option(page, AUTO).click();
				await ask.waitFor({ timeout: 10_000 });
				if (answer === "Cancel") {
					assert(await ask.locator("h2").textContent() === RUN_WITHOUT_ASKING_TITLE && await ask.locator("p").first().textContent() === RUN_WITHOUT_ASKING_BODY, `the question reads ${await ask.innerText()}`);
					assert(same(await ask.getByRole("button").allTextContents(), [CANCEL, RUN_WITHOUT_ASKING]), `its buttons: ${JSON.stringify(await ask.getByRole("button").allTextContents())}`);
					assert(await ask.getByRole("button", { name: RUN_WITHOUT_ASKING }).evaluate((button) => button.classList.contains("rs-btn-danger")), "Run without asking isn't red");
					assert(await page.evaluate(() => document.activeElement?.textContent) === CANCEL, `the focus starts on ${await page.evaluate(() => document.activeElement?.textContent)}`);
					await ask.getByRole("button", { name: CANCEL }).click();
				} else if (answer === "Escape") await page.keyboard.press("Escape");
				else await ask.click({ position: { x: 4, y: 4 } });
				await ask.waitFor({ state: "detached", timeout: 10_000 });
				await settled(page);
				assert(writes.length === 0, `${answer} sent a write`);
				assert(await page.locator(".bash-mode-menu").count() === 1, `${answer} closed the menu under the question`);
			}
			const sent = answered(page, "PUT", roomPath(open, "/bash-settings"));
			await option(page, AUTO).click();
			await ask.getByRole("button", { name: RUN_WITHOUT_ASKING }).click();
			const response = await sent;
			assert(response.status() === 200 && same(JSON.parse(response.request().postData() ?? "{}"), { autoApprove: true, protection: { state: "off" } }), `the question's yes sent ${response.request().postData()}: ${response.status()}`);
			await modeShows(page, "auto", "Auto");
			assert(writes.length === 1, `the yes sent ${writes.length} writes`);
			await openMenu(page, open);
			const asked = await pickNow(page, open, ASK);
			assert(same(asked, { autoApprove: false, protection: { state: "off" } }), `off, Ask sent ${JSON.stringify(asked)}`);
		});

		await row("the folder cause and the cause not known (a stand-in of the chip's read): the question, with no mark", async () => {
			let cause: "folder" | "unknown" = "folder";
			await page.route(`**${roomPath(guarded, "/bash-settings")}`, async (route) => {
				if (route.request().method() !== "GET") return route.continue();
				const real = await (await route.fetch()).json();
				await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ...real, settings: { ...real.settings, autoApprove: false }, protection: { state: "off", cause } }) });
			});
			try {
				await enterRoom(page, "Guarded Desk", guarded, { chip: true });
				const writes = chipWrites(page, guarded);
				for (const each of ["folder", "unknown"] as const) {
					cause = each;
					await openMenu(page, guarded);
					assert(await marks(page).count() === 0, `the ${each} cause: ${await marks(page).count()} marks`);
					await option(page, AUTO).click();
					await question(page).waitFor({ timeout: 10_000 });
					await question(page).getByRole("button", { name: CANCEL }).click();
					await question(page).waitFor({ state: "detached", timeout: 10_000 });
					await page.keyboard.press("Escape");
				}
				assert(writes.length === 0, `Cancel sent ${writes.length} writes`);
			} finally {
				await page.unroute(`**${roomPath(guarded, "/bash-settings")}`);
			}
		});

		await row("the chip reads again on returning to the page, on visibility and when the room's connection comes back: a Turn off and a Turn on made through the route show in its mode", async () => {
			// A Run without asking given while protected holds only while it is: off, the chip reads Ask, and Semi again once on.
			await enterRoom(page, "Guarded Desk", guarded, { chip: true });
			if (await page.locator(".bash-mode-chip-label").textContent() !== SEMI) {
				await openMenu(page, guarded);
				await pickNow(page, guarded, SEMI);
			}
			await modeShows(page, "semi", "On, Run without asking");
			await turnProtection(mac, guarded, "off");
			await refocus(page, guarded);
			await modeShows(page, "ask", "after a Turn off and a return to the page, Ask");
			await turnProtection(mac, guarded, "on");
			const shown = answered(page, "GET", roomPath(guarded, "/bash-settings"));
			await page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
			await (await shown).finished();
			await modeShows(page, "semi", "after a Turn on and the page shown again, Semi");
			await turnProtection(mac, guarded, "off");
			const back = answered(page, "GET", roomPath(guarded, "/bash-settings"));
			const dropped = await page.evaluate(() => {
				const live = ((window as any).__roomSockets as WebSocket[]).filter((ws) => ws.url.includes("persistentAgentId=") && ws.readyState === WebSocket.OPEN);
				for (const ws of live) ws.close();
				return live.length;
			});
			assert(dropped === 1, `${dropped} room connections were open`);
			await (await back).finished();
			await modeShows(page, "ask", "after a Turn off and the connection back, Ask");
			await turnProtection(mac, guarded, "on");
			await refocus(page, guarded);
		});

		await row("the chip's name through each change of protection: Ask, Semi and Auto each read Ask while protection is off and come back on again; Auto chosen while off is Auto there, and once on the room is back on Semi, then Ask when off again", async () => {
			await enterRoom(page, "Turning Desk", turning, { chip: true });
			const store = async (mode: CommandMode, state: "on" | "off") => {
				const body = { autoApprove: mode !== "ask", ...(mode === "auto" && state === "on" ? { free: true } : {}), protection: { state } };
				const put = await api(mac, roomPath(turning, "/bash-settings"), { method: "PUT", body: JSON.stringify(body) });
				assert(put.status === 200, `${MODE_NAMES[mode]} with protection ${state}: ${put.status} ${JSON.stringify(put.body)}`);
			};
			const turnAndShow = async (state: "on" | "off", mode: CommandMode, label: string) => {
				await turnProtection(mac, turning, state);
				await refocus(page, turning);
				await modeShows(page, mode, label);
			};
			for (const mode of ["ask", "semi", "auto"] as const) {
				await store(mode, "on");
				await refocus(page, turning);
				await modeShows(page, mode, `${MODE_NAMES[mode]}, protected`);
				await turnAndShow("off", "ask", `${MODE_NAMES[mode]}, then protection off: Ask`);
				await turnAndShow("on", mode, `${MODE_NAMES[mode]}, then protection on again`);
			}
			await store("semi", "on");
			await turnAndShow("off", "ask", "Semi, then protection off: Ask");
			await store("auto", "off");
			await refocus(page, turning);
			await modeShows(page, "auto", "Auto chosen while protection is off");
			await turnAndShow("on", "semi", "Auto chosen while off, then protection on: Semi");
			await turnAndShow("off", "ask", "on and off again: Ask, the yes given while off is gone");
			await turnProtection(mac, turning, "on");
		});

		await row("the chip shows no mode it hasn't read: none before the first good read, none after a failed one, and the mode again after a good read", async () => {
			let failing = true;
			await page.route(`**${roomPath(open, "/bash-settings")}`, (route) => {
				if (route.request().method() !== "GET" || !failing) return route.continue();
				return route.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ error: "unreadable" }) });
			});
			try {
				await enterRoom(page, OPEN_NAME, open, { chip: false });
				await chipQuiet(page);
				assert(await page.locator(".bash-mode-chip").count() === 0, "a chip that never read shows a mode");
				failing = false;
				await refocus(page, open);
				await page.locator(".bash-mode-chip").waitFor({ timeout: 10_000 });
				failing = true;
				await refocus(page, open);
				await waitUntil(async () => (await page.locator(".bash-mode-chip").count()) === 0, "a failed read still shows a mode");
				failing = false;
				await refocus(page, open);
				await page.locator(".bash-mode-chip").waitFor({ timeout: 10_000 });
			} finally {
				await page.unroute(`**${roomPath(open, "/bash-settings")}`);
			}
		});

		await row("a write whose answer is lost shows no mode until a read says what is stored: a failed read after it shows none, a good one shows the stored mode, and a room on Auto is never drawn as Ask", async () => {
			await enterRoom(page, "Guarded Desk", guarded, { chip: true });
			const stored = await api(mac, roomPath(guarded, "/bash-settings"), { method: "PUT", body: JSON.stringify({ autoApprove: true, free: true, protection: { state: "on" } }) });
			assert(stored.status === 200 && stored.body?.settings?.free === true, `Guarded Desk is on Auto, so this row proves something: ${JSON.stringify(stored.body)}`);
			await refocus(page, guarded);
			await modeShows(page, "auto", "Auto, as stored");
			let readsFail = false;
			// Every mode the chip draws from here, read on each frame the page paints. A script's text, so the runner adds no helper the page lacks.
			await page.evaluate(`(() => {
				const drawn = [];
				window.__chipModes = drawn;
				const look = () => {
					const text = document.querySelector(".bash-mode-chip-label")?.textContent ?? "";
					if (text && drawn[drawn.length - 1] !== text) drawn.push(text);
					requestAnimationFrame(look);
				};
				look();
			})()`);
			try {
				// The write reaches the server and stores Ask; its answer never reaches the page, and the read after it fails.
				await page.route(`**${roomPath(guarded, "/bash-settings")}`, async (route) => {
					if (route.request().method() === "PUT") {
						await route.fetch();
						return route.abort("connectionreset");
					}
					if (readsFail) return route.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ error: "unreadable" }) });
					return route.continue();
				});
				await openMenu(page, guarded);
				readsFail = true;
				await option(page, ASK).click();
				await waitUntil(async () => (await page.locator(".bash-mode-chip").count()) === 0, "after a lost answer and a failed read the chip still shows a mode");
				readsFail = false;
				await refocus(page, guarded);
				await modeShows(page, "ask", "the stored Ask after a good read");
			} finally {
				await page.unroute(`**${roomPath(guarded, "/bash-settings")}`);
			}
			const drawn: string[] = await page.evaluate(() => (window as any).__chipModes);
			assert(same(drawn, [AUTO, ASK]), `the chip drew ${JSON.stringify(drawn)}, where Auto, nothing, then the stored Ask were due`);
			// A room on Auto, read again and again: drawn as Auto each time.
			await api(mac, roomPath(guarded, "/bash-settings"), { method: "PUT", body: JSON.stringify({ autoApprove: true, free: true, protection: { state: "on" } }) });
			for (let n = 0; n < 3; n++) {
				await refocus(page, guarded);
				await modeShows(page, "auto", `read ${n + 1} of a room on Auto`);
			}
			await api(mac, roomPath(guarded, "/bash-settings"), { method: "PUT", body: JSON.stringify({ autoApprove: false, protection: { state: "on" } }) });
			await refocus(page, guarded);
		});

		await row("the selector in a protected room: Ask, Semi and Auto, each with its line, and the line under them, which at the computer says they ask you first; Auto asks first in the agreed words, red, Cancel sends nothing, Allow sends Auto in the protection read and the chip shows Auto from the stored value; leaving Auto asks nothing", async () => {
			await enterRoom(page, "Guarded Desk", guarded, { chip: true });
			await openMenu(page, guarded);
			const shown = await selectorShows(page);
			assert(same(shown, { items: (["ask", "semi", "auto"] as const).map((mode) => [MODE_NAMES[mode], MODE_LINES_PROTECTED[mode]]), under: MODES_PROTECTED_LINE }), `the selector shows ${JSON.stringify(shown)}`);
			const writes = chipWrites(page, guarded);
			const ask = page.getByRole("alertdialog", { name: FREE_CONFIRM_TITLE });
			await option(page, AUTO).click();
			await ask.waitFor({ timeout: 10_000 });
			assert(await ask.locator("h2").textContent() === FREE_CONFIRM_TITLE && await ask.locator("p").first().textContent() === FREE_CONFIRM_BODY, `the question reads ${await ask.innerText()}`);
			assert(same(await ask.getByRole("button").allTextContents(), [CANCEL, ALLOW]), `its buttons: ${JSON.stringify(await ask.getByRole("button").allTextContents())}`);
			assert(await ask.getByRole("button", { name: ALLOW }).evaluate((button) => button.classList.contains("rs-btn-danger")), "Allow isn't red");
			await ask.getByRole("button", { name: CANCEL }).click();
			await ask.waitFor({ state: "detached", timeout: 10_000 });
			await settled(page);
			assert(writes.length === 0 && await page.locator(".bash-mode-chip-label").textContent() !== AUTO, "Cancel sent a write or changed the mode");
			const sent = answered(page, "PUT", roomPath(guarded, "/bash-settings"));
			await option(page, AUTO).click();
			await ask.getByRole("button", { name: ALLOW }).click();
			const response = await sent;
			assert(response.status() === 200 && same(JSON.parse(response.request().postData() ?? "{}"), { autoApprove: true, free: true, protection: { state: "on" } }), `Allow sent ${response.request().postData()}: ${response.status()}`);
			assert((await response.json())?.settings?.free === true, "the answer doesn't store Auto");
			await modeShows(page, "auto", "Auto, from the stored value");
			await openMenu(page, guarded);
			assert(await page.locator(".bash-mode-option.is-current .bash-mode-option-name").textContent() === AUTO, "Auto isn't the current item");
			const left = await pickNow(page, guarded, SEMI);
			assert(same(left, { autoApprove: true, protection: { state: "on" } }), `leaving Auto sent ${JSON.stringify(left)}`);
			await modeShows(page, "semi", "Semi after Auto");
			await openMenu(page, guarded);
			await pickNow(page, guarded, ASK);
		});

		await row("the selector in a room turned off by the person: Ask and Auto, each with its line, and the Folder page's line for that room under them; no Semi", async () => {
			await enterRoom(page, OPEN_NAME, open, { chip: true });
			await openMenu(page, open);
			const shown = await selectorShows(page);
			assert(same(shown, { items: (["ask", "auto"] as const).map((mode) => [MODE_NAMES[mode], MODE_LINES_UNPROTECTED[mode]]), under: COMMANDS_UNPROTECTED_REACH }), `the selector shows ${JSON.stringify(shown)}`);
			await page.keyboard.press("Escape");
		});

		await row("a write refused because protection changed says the app's sentence and reads again: the next Run without asking, now off, asks first; the error line wraps evenly", async () => {
			await enterRoom(page, "Guarded Desk", guarded, { chip: true });
			// A protected Run without asking comes back with a Turn on: Ask, so the next pick writes.
			if ((await api(mac, roomPath(guarded, "/bash-settings"))).body?.settings?.autoApprove === true) {
				await openMenu(page, guarded);
				await pickNow(page, guarded, ASK);
			}
			await openMenu(page, guarded);
			await turnProtection(mac, guarded, "off");
			const refused = answered(page, "PUT", roomPath(guarded, "/bash-settings"));
			const readAgain = answered(page, "GET", roomPath(guarded, "/bash-settings"));
			await option(page, SEMI).click();
			const response = await refused;
			assert(response.status() === 409 && (await response.json())?.code === "protection_changed", `the write read on, after a Turn off: ${response.status()}`);
			const error = page.locator(".bash-mode-menu-error");
			await error.waitFor({ timeout: 10_000 });
			assert(await error.textContent() === CHANGE_SAVE_FAILED, `the refusal reads ${await error.textContent()}`);
			assert(await error.evaluate((line) => getComputedStyle(line).getPropertyValue("text-wrap-style")) === "balance", "the error line doesn't wrap evenly");
			await (await readAgain).finished();
			await settled(page);
			await option(page, AUTO).click();
			await question(page).waitFor({ timeout: 10_000 });
			await question(page).getByRole("button", { name: CANCEL }).click();
			await page.keyboard.press("Escape");
			await turnProtection(mac, guarded, "on");
		});

		await row("the no-folder notice says the no-folder line alone, where commands start on and protection reads On and where it reads off; its cross, named Dismiss, sits beside Choose folder… and hides the notice for good", async () => {
			await enterRoom(page, "Fresh Room", empty, { chip: false });
			assert(await noticeWords(page) === NO_FOLDER_LINE, `protection On, the notice reads ${await noticeWords(page)}`);
			await enterRoom(page, "Switched Room", offEmpty, { chip: false });
			assert(await noticeWords(page) === NO_FOLDER_LINE, `protection off, the notice reads ${await noticeWords(page)}`);
			const choose = notice(page).getByRole("button", { name: CHOOSE_FOLDER });
			const cross = notice(page).getByRole("button", { name: DISMISS, exact: true });
			assert(await cross.count() === 1 && await cross.getAttribute("title") === DISMISS && (await cross.textContent())?.trim() === "" && await cross.locator("svg").count() === 1, "the way out is a cross named Dismiss, with Dismiss as its tooltip");
			const chooseBox = await choose.boundingBox();
			const crossBox = await cross.boundingBox();
			assert(chooseBox && crossBox && crossBox.x >= chooseBox.x + chooseBox.width && Math.abs((crossBox.y + crossBox.height / 2) - (chooseBox.y + chooseBox.height / 2)) <= 1 && crossBox.width >= 28 && crossBox.height >= 28, `the cross sits after Choose folder…, centred on it, at least 28px: ${JSON.stringify({ chooseBox, crossBox })}`);
			await cross.click();
			await waitUntil(async () => (await notice(page).count()) === 0, "the cross hides the notice");
			await enterRoom(page, "Switched Room", offEmpty, { chip: false });
			assert(await notice(page).count() === 0, "a dismissed notice comes back");
			// Choose folder… saves the pick at once: the notice goes with the hint.
			await enterRoom(page, "Fresh Room", empty, { chip: false });
			await notice(page).waitFor({ timeout: 10_000 });
			const chosen = path.join(mac.home, "Projects", "First Pick");
			fs.mkdirSync(chosen, { recursive: true });
			await page.route("**/api/system/choose-folder", (route) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ supported: true, cancelled: false, path: chosen }) }));
			await notice(page).getByRole("button", { name: CHOOSE_FOLDER }).click();
			await waitUntil(async () => (await notice(page).count()) === 0, "the hint leaves once a folder is saved");
			await page.unroute("**/api/system/choose-folder");
		});
		await close();

		await row("on a phone: the chip's options greyed with the computer-only line, no period, no mark beside it, three in a protected room, with the line under them saying only that commands stay in the room's folders, and two in one turned off; the no-folder notice says the no-folder line alone; the chip's tooltip says the mode with no Click to change, and the selector stays inside the screen, its greyed modes as legible as the line under them", async () => {
			const phone = await openPage(browser, mac, { width: 390, context: { remote: true, sharedServer: false } });
			try {
				await enterRoom(phone.page, OPEN_NAME, open, { chip: true });
				assert(await marks(phone.page).count() === 0, "the phone shows a mark beside the chip of a room turned off");
				const tooltip = await phone.page.locator(".bash-mode-chip").getAttribute("title");
				assert(tooltip !== null && tooltip !== "" && !tooltip.includes("Click to change"), `the phone's chip offers a change it can't make: ${tooltip}`);
				await openMenu(phone.page, open);
				assert(await phone.page.locator(".bash-mode-option:disabled").count() === 2, "the phone's options aren't greyed");
				assert(await phone.page.locator(".bash-mode-menu-note").textContent() === CHANGEABLE_AT_COMPUTER, `the phone's line reads ${await phone.page.locator(".bash-mode-menu-note").textContent()}`);
				await phone.page.keyboard.press("Escape");
				await enterRoom(phone.page, "Guarded Desk", guarded, { chip: true });
				await openMenu(phone.page, guarded);
				const items = await selectorShows(phone.page);
				assert(await phone.page.locator(".bash-mode-option:disabled").count() === 3 && items.items.length === 3 && items.under === MODES_PROTECTED_STAY_LINE, `a protected room's selector on the phone: ${JSON.stringify(items)}`);
				assert(await phone.page.locator(".bash-mode-menu-note").textContent() === CHANGEABLE_AT_COMPUTER, "the phone's protected selector has no computer-only line");
				const colours = await phone.page.evaluate(() => [".bash-mode-option-name", ".bash-mode-option-line", ".bash-mode-menu-line"].map((selector) => getComputedStyle(document.querySelector(selector)!).color));
				assert(colours[0] === colours[2] && colours[1] === colours[2], `the phone's modes read fainter than the line under them: ${JSON.stringify(colours)}`);
				const menuBox = await phone.page.locator(".bash-mode-menu").boundingBox();
				assert(menuBox && menuBox.x >= 0 && menuBox.x + menuBox.width <= 390, `the phone's selector runs off the screen: ${JSON.stringify(menuBox)}`);
				await phone.page.keyboard.press("Escape");
				await enterRoom(phone.page, "Pocket Room", phoneEmpty, { chip: false });
				assert(await noticeWords(phone.page) === NO_FOLDER_LINE, `the phone's notice reads ${await noticeWords(phone.page)}`);
				// Wrapped under the line, the cross still closes the notice from its right edge, with Choose folder… beside it.
				const box = await notice(phone.page).boundingBox();
				const choose = await notice(phone.page).getByRole("button", { name: CHOOSE_FOLDER }).boundingBox();
				const cross = await notice(phone.page).getByRole("button", { name: DISMISS, exact: true }).boundingBox();
				assert(box && choose && cross && box.x + box.width - (cross.x + cross.width) <= 12 && cross.x >= choose.x + choose.width && Math.abs((cross.y + cross.height / 2) - (choose.y + choose.height / 2)) <= 1, `the phone's cross sits at the notice's right edge, beside Choose folder…: ${JSON.stringify({ box, choose, cross })}`);
			} finally {
				await phone.close();
			}
		});

		await row("on a shared server (a stand-in of the client context): no chip, no mark and no no-folder notice in the room", async () => {
			const shared = await openPage(browser, mac, { context: { remote: false, sharedServer: true, person: { id: "synthetic-person", name: "Synthetic Person", admin: true } } });
			try {
				for (const [name, id] of [[OPEN_NAME, open], ["Member Room", sharedEmpty]] as const) {
					await enterRoom(shared.page, name, id, { chip: false });
					assert(await shared.page.locator(".bash-mode-chip").count() === 0 && await marks(shared.page).count() === 0 && await notice(shared.page).count() === 0, `${name} on a shared server shows the chip, a mark or the no-folder notice`);
				}
			} finally {
				await shared.close();
			}
		});
	} finally {
		await browser.close();
	}

	// A computer where protection can't run: this Mac acting as Linux.
	const linux = await startServer("linux", "linux");
	servers.push(linux);
	const linuxDesk = await createRoom(linux, "Linux Desk", true);
	const linuxEmpty = await createRoom(linux, "Linux Fresh", false);
	const linuxBrowser = await chromium.launch();
	try {
		await row("this computer as the cause (acting as Linux): no mark on Home or the chip, two modes with this computer's line under them, Run without asking still asks first, and the no-folder notice says the no-folder line alone", async () => {
			const read = (await api(linux, roomPath(linuxDesk, "/bash-settings"))).body;
			assert(same(read?.protection, { state: "off", cause: "computer" }), `the server reads the computer cause, so this row proves something: ${JSON.stringify(read?.protection)}`);
			const { page, close } = await openPage(linuxBrowser, linux);
			try {
				await page.locator(".persistent-agent-card").filter({ hasText: "Linux Desk" }).waitFor({ timeout: 10_000 });
				assert(await marks(page).count() === 0, "Home carries a mark for the computer");
				await enterRoom(page, "Linux Desk", linuxDesk, { chip: true });
				assert(await marks(page).count() === 0, "the chip carries a mark for the computer");
				const writes = chipWrites(page, linuxDesk);
				await openMenu(page, linuxDesk);
				const shown = await selectorShows(page);
				assert(same(shown, { items: (["ask", "auto"] as const).map((mode) => [MODE_NAMES[mode], MODE_LINES_UNPROTECTED[mode]]), under: COMMANDS_NO_PROTECTION_REACH }), `the computer cause's selector shows ${JSON.stringify(shown)}`);
				await option(page, AUTO).click();
				await question(page).waitFor({ timeout: 10_000 });
				await question(page).getByRole("button", { name: CANCEL }).click();
				await question(page).waitFor({ state: "detached", timeout: 10_000 });
				assert(writes.length === 0, "Cancel sent a write");
				await enterRoom(page, "Linux Fresh", linuxEmpty, { chip: false });
				assert(await noticeWords(page) === NO_FOLDER_LINE, `the computer cause's notice reads ${await noticeWords(page)}`);
			} finally {
				await close();
			}
		});
	} finally {
		await linuxBrowser.close();
	}

	console.log(`room protection marks ui smoke: ${passed} passed, ${failures.length} failed`);
	if (failures.length > 0) {
		for (const server of servers) console.error(server.output.join("").slice(-3000));
		process.exitCode = 1;
	}
} catch (error) {
	for (const server of servers) console.error(server.output.join("").slice(-3000));
	throw error;
} finally {
	for (const server of servers) await stopSmokeServer(server.process);
	fs.rmSync(tempRoot, { recursive: true, force: true });
}
