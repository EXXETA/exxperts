// Home's room card on a real Home: its buttons and its memory line's words.
// Two rooms, one fresh and one with three remembered conversations waiting.
// The card's buttons (Enter, Maintain) are in the card's own face, Sen Bold
// 13px, 29px tall, at desktop and phone width, and "Entering…" fits on one
// line in Enter; the Create room buttons beside the cards keep the display
// face. The memory line says "nothing to memorize" and "3 to memorize", and
// the bar is named "Conversations to memorize: N of <limit>".
// The one-line form, drawn when the status has no hard cap, is never sent by
// this server; its words are checked by taking the hard cap out of the status
// answers the page reads, the one stub in this smoke.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { fileURLToPath } from "node:url";
import { chromium, type Browser, type Page } from "playwright";
import { SMOKE_AUTH_TOKEN, SMOKE_SERVER_AUTH_ENV, SMOKE_SERVER_SPAWN_TREE_OPTIONS, smokeHomeEnv, stopSmokeServer, freePort } from "./smoke-server-process.js";
import { closeBrowser, closeContext } from "./smoke-close-context.js";
import { waitEvery } from "./smoke-wait.js";

const waitUntil = waitEvery(100);

function assert(condition: unknown, message: string): asserts condition {
	if (!condition) throw new Error(message);
}

// A machine without Chromium cannot run a browser assertion at all; skip whole.
{
	const p = typeof chromium?.executablePath === "function" ? chromium.executablePath() : "";
	if (!p || !fs.existsSync(p)) {
		console.log("home card look smoke skipped (Chromium not installed)");
		process.exit(0);
	}
}

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const webServerDir = path.resolve(scriptDir, "..");
const repoRoot = path.resolve(webServerDir, "..", "..");
const port = await freePort();
const baseUrl = `http://127.0.0.1:${port}`;

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "exxperts-home-card-look-"));
const tempHome = path.join(tempRoot, "home");
const agentsRoot = path.join(tempHome, ".exxperts", "app", "personalized-agents");
const agentDir = path.join(tempHome, ".exxperts", "agent");
const appDir = path.join(tempHome, ".exxperts", "app");
for (const dir of [agentsRoot, agentDir]) fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
process.env.HOME = tempHome;
process.env.USERPROFILE = tempHome;
process.env.EXXPERTS_CODING_AGENT_DIR = agentDir;
process.env.EXXETA_PERSISTENT_AGENTS_ROOT = agentsRoot;

const MODEL = { provider: "fake-claude", model: "claude-fake" };
// No message is ever sent, so the provider's address is never called.
fs.writeFileSync(path.join(agentDir, "models.json"), JSON.stringify({
	providers: { "fake-claude": { name: "Fake Claude", baseUrl: "http://127.0.0.1:9", api: "anthropic-messages", models: [{ id: "claude-fake", name: "Claude Fake", input: ["text"], contextWindow: 200000, maxTokens: 32000 }] } },
}, null, 2), { mode: 0o600 });
fs.writeFileSync(path.join(agentDir, "auth.json"), JSON.stringify({ "fake-claude": { type: "api_key", key: "synthetic-claude" } }, null, 2), { mode: 0o600 });
fs.writeFileSync(path.join(appDir, "custom-ai-profiles.json"), JSON.stringify({ version: 1, profiles: [
	{ id: "custom-fake-claude", providerId: "fake-claude", label: "Fake Claude", roomModels: ["claude-fake"], learnModel: "claude-fake", reviewMemoryModel: "claude-fake" },
] }, null, 2), { mode: 0o600 });
fs.writeFileSync(path.join(appDir, "persistent-agent-ai-profile.json"), JSON.stringify({ profileId: "custom-fake-claude" }, null, 2), { mode: 0o600 });

const agents = await import("../src/persistent-agents.js");
const roomModels = await import("../src/room-models.js");
const conversationPage = (id: string, title: string) => [`### ${id} | CLOSED | 2026-09-09 | ${title}`, "", `**Session arc:** ${title}.`, "", "**Body:**", `- ${title}.`, "", "**Parked:**", "None", ""].join("\n");
function createRoom(name: string, pages: string[]): void {
	const agentId = agents.createPersistentAgentFromScaffoldInput({ displayName: name, userName: "Synthetic User", preferredUserAddress: "Synthetic User" }).agent.agentId;
	roomModels.writeRoomModels(agentId, { conversation: MODEL, memory: MODEL });
	if (pages.length === 0) return;
	const l1bPath = path.join(agentsRoot, agentId, "L1b", "current.md");
	const text = fs.readFileSync(l1bPath, "utf-8");
	const recent = /^##\s+Recent Context\s*$/m.exec(text);
	assert(recent, "the scaffold has a Recent Context section");
	fs.writeFileSync(l1bPath, `${text.slice(0, recent.index + recent[0].length)}\n\n${pages.join("\n")}\n`, "utf-8");
}
createRoom("Fresh Room", []);
createRoom("Client Notes", [conversationPage("RC-0001", "The kickoff call"), conversationPage("RC-0002", "The budget review"), conversationPage("RC-0003", "The venue plan")]);

type ButtonLook = { text: string; fontFamily: string; fontSize: string; fontWeight: string; height: number; fitsOneLine: boolean };
/** What a button shows: its computed face, size and weight, its height, and whether its words fit on one line. */
async function buttonLook(page: Page, selector: string): Promise<ButtonLook> {
	return page.locator(selector).first().evaluate((el) => {
		const style = getComputedStyle(el);
		const box = el.getBoundingClientRect();
		const range = document.createRange();
		range.selectNodeContents(el);
		const lines = new Set([...range.getClientRects()].map((rect) => Math.round(rect.top))).size;
		return { text: (el.textContent ?? "").trim(), fontFamily: style.fontFamily, fontSize: style.fontSize, fontWeight: style.fontWeight, height: Math.round(box.height * 10) / 10, fitsOneLine: lines === 1 && el.scrollWidth <= el.clientWidth };
	});
}
const firstFace = (fontFamily: string) => fontFamily.split(",")[0].trim().replace(/^["']|["']$/g, "");

const card = (name: string) => `.persistent-agent-card:has(h2:text-is("${name}"))`;

/** A signed-in Home; `beforeLoad` runs on the page first, so a route it adds sees the page's first requests. */
async function openHome(browser: Browser, width: number, colorScheme: "light" | "dark", beforeLoad?: (page: Page) => Promise<unknown>) {
	const context = await browser.newContext({ viewport: { width, height: 900 }, colorScheme });
	const page = await context.newPage();
	await beforeLoad?.(page);
	await page.goto(`${baseUrl}/auth/session?token=${SMOKE_AUTH_TOKEN}`);
	return { context, page };
}
async function waitForCards(page: Page): Promise<void> {
	for (const name of ["Fresh Room", "Client Notes"]) await page.locator(`${card(name)} .persistent-agent-meta .memory-meter-checkpoint`).first().waitFor({ timeout: 20_000 });
	const dismiss = page.locator(".whats-new-close");
	if (await dismiss.count()) await dismiss.click();
	await page.evaluate(() => document.fonts.ready);
}

let server: ChildProcessWithoutNullStreams | undefined;
const serverOutput: string[] = [];
let browser: Browser | undefined;
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

	browser = await chromium.launch();

	// The memory line's words, in the bar form, and the bar's name.
	{
		const { context, page } = await openHome(browser, 1440, "light");
		await waitForCards(page);
		const labelOf = (name: string) => page.locator(`${card(name)} .memory-meter-label`).textContent().then((text) => (text ?? "").trim());
		const barNameOf = (name: string) => page.locator(`${card(name)} .memory-meter-track`).getAttribute("aria-label");
		const fresh = await labelOf("Fresh Room");
		assert(fresh === "nothing to memorize", `a fresh room's memory line says "nothing to memorize", got ${JSON.stringify(fresh)}`);
		const three = await labelOf("Client Notes");
		assert(three === "3 to memorize", `a room with three waiting says "3 to memorize", got ${JSON.stringify(three)}`);
		const limit = await page.locator(`${card("Client Notes")} .memory-meter-track`).getAttribute("aria-valuemax");
		assert(limit && Number(limit) > 3, `the bar has a limit above the count, got ${JSON.stringify(limit)}`);
		const barName = await barNameOf("Client Notes");
		assert(barName === `Conversations to memorize: 3 of ${limit}`, `the bar is named for what it counts, got ${JSON.stringify(barName)}`);
		const freshBarName = await barNameOf("Fresh Room");
		assert(freshBarName === `Conversations to memorize: 0 of ${limit}`, `the fresh room's bar says 0, got ${JSON.stringify(freshBarName)}`);
		await closeContext(context);
		console.log("ok the bar form says \"nothing to memorize\" and \"3 to memorize\", and the bar's name follows");
	}

	// The one-line form: the same words, then the memory's age.
	{
		const dropHardCap = (value: unknown): void => {
			if (!value || typeof value !== "object") return;
			const memory = (value as { memoryStatus?: Record<string, unknown> }).memoryStatus;
			if (memory && typeof memory === "object") delete memory.recentContextHardCap;
			for (const child of Object.values(value)) dropHardCap(child);
		};
		const { context, page } = await openHome(browser, 1440, "light", (page) => page.route(/\/api\/persistent-agents(\/|\?|$)/, async (route) => {
			const response = await route.fetch();
			if (route.request().method() !== "GET" || !(response.headers()["content-type"] ?? "").includes("json")) return route.fulfill({ response });
			const body = await response.json();
			dropHardCap(body);
			await route.fulfill({ response, json: body });
		}));
		await waitForCards(page);
		const lineOf = (name: string) => page.locator(`${card(name)} .persistent-agent-meta > .memory-meter-checkpoint`).textContent().then((text) => (text ?? "").trim());
		assert(await page.locator(".memory-meter-track").count() === 0, "with no hard cap in the status, no card draws the bar");
		const fresh = await lineOf("Fresh Room");
		assert(fresh === "nothing to memorize · no memories saved yet", `a fresh room's one line, got ${JSON.stringify(fresh)}`);
		const three = await lineOf("Client Notes");
		assert(/^3 to memorize · (no memories saved yet|memory saved .+)$/.test(three), `a room with three waiting, one line, got ${JSON.stringify(three)}`);
		await closeContext(context);
		console.log("ok the one-line form starts with the same words");
	}

	// The card's buttons, at desktop and phone width, light and dark.
	for (const width of [1440, 390]) {
		for (const colorScheme of ["light", "dark"] as const) {
			const where = `${width}px ${colorScheme}`;
			const { context, page } = await openHome(browser, width, colorScheme);
			await waitForCards(page);
			assert(await page.evaluate(() => document.fonts.check("700 13px Sen")), `${where}: Sen Bold is loaded`);
			for (const [name, kind, text] of [["Fresh Room", "landing-action", "Enter"], ["Client Notes", "landing-action", "Enter"], ["Client Notes", "inline-action", "Maintain"]] as const) {
				const look = await buttonLook(page, `${card(name)} .persistent-agent-actions .${kind}`);
				assert(look.text === text, `${where}: ${name}'s ${kind} reads ${text}, got ${JSON.stringify(look.text)}`);
				assert(firstFace(look.fontFamily) === "Sen" && look.fontSize === "13px" && look.fontWeight === "700", `${where}: ${name}'s ${text} is Sen Bold 13px, got ${JSON.stringify(look)}`);
				assert(look.height === 29, `${where}: ${name}'s ${text} keeps the row's 29px, got ${look.height}`);
				assert(look.fitsOneLine, `${where}: ${name}'s ${text} fits on one line, got ${JSON.stringify(look)}`);
			}
			// The allowed neighbour: the same two looks in Home's Create room dialog keep the display face.
			await page.getByRole("button", { name: "Create a new room" }).click();
			for (const [kind, text] of [["landing-action", "Create room"], ["inline-action", "Cancel"]] as const) {
				const look = await buttonLook(page, `.create-room-overlay .create-room-actions .${kind}`);
				assert(look.text === text && firstFace(look.fontFamily) === "Bandeins Strange", `${where}: Create room's ${text} keeps the display face, got ${JSON.stringify(look)}`);
			}
			await closeContext(context);
		}
	}
	console.log("ok the card's buttons are Sen Bold 13px and 29px tall at desktop and phone width, light and dark");

	// "Entering…" in Enter: the page's requests are held from the click on, so the word stays to be measured.
	// Each width enters a room of its own: a room once entered holds its conversation and offers Resume.
	for (const [width, room] of [[1440, "Fresh Room"], [390, "Client Notes"]] as const) {
		const { context, page } = await openHome(browser, width, "light");
		await waitForCards(page);
		const enter = `${card(room)} .persistent-agent-actions .landing-action`;
		const widthOf = () => page.locator(enter).evaluate((el) => el.getBoundingClientRect().width);
		const enterWidth = await widthOf();
		let release: () => void = () => {};
		const released = new Promise<void>((resolve) => { release = resolve; });
		await page.route(/\/api\//, async (route) => { await released; await route.continue().catch(() => {}); });
		await page.locator(enter).click();
		await page.locator(enter, { hasText: "Entering…" }).waitFor({ timeout: 5_000 });
		const entering = await buttonLook(page, enter);
		const enteringWidth = await widthOf();
		release();
		assert(entering.fitsOneLine && entering.height === 29, `${width}px: "Entering…" fits on one line at 29px, got ${JSON.stringify(entering)}`);
		assert(Math.abs(enteringWidth - enterWidth) < 0.5, `${width}px: Enter keeps its width while entering, so the row does not jump: ${enterWidth}px, then ${enteringWidth}px`);
		await closeContext(context);
	}
	console.log("ok \"Entering…\" fits in Enter on one line");

	console.log("home-card-look smoke: ok");
} catch (error) {
	console.error(serverOutput.join("").slice(-6000));
	throw error;
} finally {
	if (browser) await closeBrowser(browser);
	await stopSmokeServer(server);
	fs.rmSync(tempRoot, { recursive: true, force: true });
}
