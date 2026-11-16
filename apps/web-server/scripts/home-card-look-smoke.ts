// Home's room card on a real Home: its buttons and its memory line's words.
// Two rooms, one fresh and one with three remembered conversations waiting.
// The card's buttons (Enter, Maintain) are the button family's small size,
// Sen Medium 13px, at desktop and phone width, 28px tall on a desktop and 44px
// at phone width, a finger's target, and "Entering…" fits on one line in
// Enter; the Create room dialog's buttons are in Sen too, not the display
// face. The memory line says "nothing to memorize" and "3 to memorize", and
// the bar is named "Conversations to memorize: N of <limit>". A card's name
// shares one centre line with its status mark and gear (its first line when
// it wraps), and a finger's gear leaves the name the width a mouse's gear
// does. Where cards stand side by side, the New room tile alone in its row is
// as tall as the card before it, also when that card grows or Sort puts a
// taller card there; in one column (a phone, a narrow window) it keeps its 85 px.
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
function same(actual: unknown, expected: unknown, what: string): void {
	assert(JSON.stringify(actual) === JSON.stringify(expected), `${what}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
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
// A desktop has the family's small 28px; at phone width a finger needs 44.
const buttonHeight = (width: number) => (width === 390 ? 44 : 28);

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

/** Where each card's head sits: the middle of its name's first line and of each thing at its end (status mark, gear), and how many lines the name takes. */
async function readHeads(page: Page) {
	return page.evaluate(() => [...document.querySelectorAll(".persistent-agent-card")].map((card) => {
		const name = card.querySelector(".persistent-agent-header h2")!;
		const range = document.createRange();
		range.selectNodeContents(name);
		const lines = [...range.getClientRects()].filter((rect) => rect.width > 0);
		return {
			name: (name.textContent ?? "").slice(0, 24),
			lines: new Set(lines.map((rect) => Math.round(rect.top))).size,
			line: (lines[0].top + lines[0].bottom) / 2,
			ends: [...card.querySelectorAll(".persistent-agent-header-end > *")].map((element) => { const box = element.getBoundingClientRect(); return `${element.className.split(" ").pop()}:${((box.top + box.bottom) / 2).toFixed(1)}`; }),
		};
	}));
}
// A long name, to wrap: set on the page's own heading and put back after.
const LONG_NAME = "The quarterly planning room for the northern region's client contracts";
async function renameOnPage(page: Page, index: number, name: string | null): Promise<string> {
	return page.evaluate(([at, next]) => {
		const heading = document.querySelectorAll(".persistent-agent-card .persistent-agent-header h2")[at as number]!;
		const before = heading.textContent ?? "";
		if (next !== null) heading.textContent = next as string;
		return before;
	}, [index, name] as const);
}

/** A card's name sits on one centre line with its status mark and gear; a name that wraps keeps them on its first line. */
async function checkHeadLine(page: Page, where: string): Promise<void> {
	const offLine = (heads: Awaited<ReturnType<typeof readHeads>>) => heads.flatMap((head) => head.ends.filter((end) => Math.abs(Number(end.split(":")[1]) - head.line) > 1).map((end) => `${head.name}: name's line at ${head.line.toFixed(1)}, ${end}`));
	const heads = await readHeads(page);
	assert(heads.length === 2 && heads.every((head) => head.lines === 1 && head.ends.length > 0), `${where}: two cards, each name on one line with a mark or gear at its end, got ${JSON.stringify(heads)}`);
	same(offLine(heads), [], `${where}: a name and its mark and gear on one centre line`);
	const before = await renameOnPage(page, 0, LONG_NAME);
	const wrapped = (await readHeads(page))[0];
	await renameOnPage(page, 0, before);
	assert(wrapped.lines > 1, `${where}: the long name wraps, got ${JSON.stringify(wrapped)}`);
	same(offLine([wrapped]), [], `${where}: a name that wraps keeps its mark and gear on its first line`);
	// A finger's gear reaches into the space around it, so the name keeps the width it has beside the 28 px gear a mouse gets.
	const room = await page.evaluate(() => {
		const name = document.querySelector(".persistent-agent-card .persistent-agent-header h2")!;
		const gear = name.closest(".persistent-agent-card")!.querySelector<HTMLElement>(".card-gear-btn")!;
		const now = name.getBoundingClientRect().width;
		const pulls = [gear, gear.parentElement!];
		for (const element of pulls) element.style.setProperty("margin", "0", "important");
		gear.style.setProperty("width", "28px", "important");
		gear.style.setProperty("min-width", "0", "important");
		const beside28 = name.getBoundingClientRect().width;
		for (const element of pulls) element.style.removeProperty("margin");
		gear.style.removeProperty("width");
		gear.style.removeProperty("min-width");
		return { now, beside28 };
	});
	assert(Math.abs(room.now - room.beside28) <= 0.5, `${where}: the name is ${room.now} px wide, ${room.beside28} px beside a 28 px gear`);
	// Every card's gear is the family's size and its mark sits as far from its card's right edge, with a status mark beside it or none.
	const gears = await page.locator(".persistent-agent-card .card-gear-btn").evaluateAll((all) => all.map((gear) => { const box = gear.getBoundingClientRect(); const mark = gear.querySelector("svg")!.getBoundingClientRect(); const card = gear.closest(".persistent-agent-card")!.getBoundingClientRect(); return { size: `${box.width}x${box.height}`, mark: +(card.right - mark.left - mark.width / 2).toFixed(1), marked: gear.parentElement!.children.length > 1 }; }));
	const size = where.startsWith("390") ? "44x44" : "28x28";
	assert(gears.every((gear) => gear.size === size) && gears.every((gear) => Math.abs(gear.mark - gears[0].mark) <= 0.5), `${where}: every card's gear is ${size} with its mark in one column, got ${JSON.stringify(gears)}`);
}

/** The height the New room tile has always had in a phone's or a narrow window's one column. */
const PHONE_TILE_HEIGHT = 85;
/** Where cards stand side by side, the New room tile alone in its row is as tall as the room card before it, also once that card grows; beside a card it is the row's height. In one column (a phone, a narrow window) it keeps its own 85 px. */
async function checkTileHeight(page: Page, where: string, mustBeAlone: boolean): Promise<void> {
	const read = () => page.evaluate(() => {
		const tile = document.querySelector(".landing-grid > .add-room-card")!;
		const card = tile.previousElementSibling!;
		const [t, c] = [tile.getBoundingClientRect(), card.getBoundingClientRect()];
		const inside = [...tile.children].map((child) => child.getBoundingClientRect()).filter((box) => box.height > 0);
		const above = Math.min(...inside.map((box) => box.top)) - t.top;
		const below = t.bottom - Math.max(...inside.map((box) => box.bottom));
		return { alone: t.top >= c.bottom, column: t.left === c.left, tile: Math.round(t.height * 10) / 10, card: Math.round(c.height * 10) / 10, offCentre: Math.round((above - below) * 10) / 10 };
	});
	const first = await read();
	if (mustBeAlone) assert(first.alone, `${where}: the New room tile has a row of its own, got ${JSON.stringify(first)}`);
	if (first.column) {
		assert(Math.abs(first.tile - PHONE_TILE_HEIGHT) <= 1 && Math.abs(first.offCentre) <= 1, `${where}: in one column the New room tile is ${PHONE_TILE_HEIGHT} px tall with its plus and words centred, got ${JSON.stringify(first)}`);
		return;
	}
	assert(Math.abs(first.tile - first.card) <= 1, `${where}: the New room tile ${first.alone ? "alone in its row" : "beside the cards"} is ${first.tile} px tall, the room card ${first.card} px`);
	if (!first.alone) return;
	const before = await renameOnPage(page, 1, LONG_NAME);
	let grown = await read();
	await waitUntil(async () => { grown = await read(); return grown.card > first.card && Math.abs(grown.tile - grown.card) <= 1; }, `${where}: the tile follows the card it sits under`, 5000).catch(() => {});
	await renameOnPage(page, 1, before);
	assert(grown.card > first.card && Math.abs(grown.tile - grown.card) <= 1, `${where}: the card grew to ${grown.card} px and the tile is ${grown.tile} px`);

	// The first card made taller, then the order turned round with Sort: the tall card now sits over the tile, with no box resized.
	const names = () => page.locator(".persistent-agent-card h2").allInnerTexts();
	const order = await names();
	const tall = await renameOnPage(page, 0, LONG_NAME);
	const turned = [...order].reverse();
	await page.locator(".room-sort-row .room-sort-btn").first().click();
	await page.getByRole("menuitemradio", { name: turned[0] === [...order].sort()[0] ? "Name A→Z" : "Name Z→A" }).click();
	await waitUntil(async () => (await names()).at(-1) === LONG_NAME, `${where}: the cards change places`, 5000);
	let swapped = await read();
	await waitUntil(async () => { swapped = await read(); return Math.abs(swapped.tile - swapped.card) <= 1; }, `${where}: the tile follows its new neighbour`, 3000).catch(() => {});
	await page.evaluate(([long, text]) => { for (const heading of document.querySelectorAll(".persistent-agent-card .persistent-agent-header h2")) if (heading.textContent === long) heading.textContent = text; }, [LONG_NAME, tall]);
	assert(Math.abs(swapped.tile - swapped.card) <= 1, `${where}: after Sort put the tall card over the tile, the card is ${swapped.card} px and the tile ${swapped.tile} px`);
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
			// A face that matches, loaded: fonts.check alone answers yes when none matches.
			const faces = await page.evaluate(() => [...document.fonts].filter((face) => face.family.replace(/["']/g, "") === "Sen").map((face) => `${face.weight}:${face.status}`));
			assert(faces.includes("500:loaded"), `${where}: Sen Medium is loaded, the faces are ${faces.join(", ")}`);
			for (const [name, kind, text] of [["Fresh Room", "landing-action", "Enter"], ["Client Notes", "landing-action", "Enter"], ["Client Notes", "inline-action", "Maintain"]] as const) {
				const look = await buttonLook(page, `${card(name)} .persistent-agent-actions .${kind}`);
				assert(look.text === text, `${where}: ${name}'s ${kind} reads ${text}, got ${JSON.stringify(look.text)}`);
				assert(firstFace(look.fontFamily) === "Sen" && look.fontSize === "13px" && look.fontWeight === "500", `${where}: ${name}'s ${text} is Sen Medium 13px, got ${JSON.stringify(look)}`);
				assert(look.height === buttonHeight(width), `${where}: ${name}'s ${text} is ${buttonHeight(width)}px tall, got ${look.height}`);
				assert(look.fitsOneLine, `${where}: ${name}'s ${text} fits on one line, got ${JSON.stringify(look)}`);
			}
			await checkHeadLine(page, where);
			await checkTileHeight(page, where, width === 390);
			// Home's Create room dialog: its two buttons are the family's regular size, in Sen, not the display face.
			await page.getByRole("button", { name: "Create a new room" }).click();
			for (const [kind, text] of [["landing-action", "Create room"], ["inline-action", "Cancel"]] as const) {
				const look = await buttonLook(page, `.create-room-overlay .create-room-actions .${kind}`);
				assert(look.text === text && firstFace(look.fontFamily) === "Sen" && look.fontWeight === "500" && look.height === (width === 390 ? 44 : 32), `${where}: Create room's ${text} is Sen Medium at the regular size, got ${JSON.stringify(look)}`);
			}
			await closeContext(context);
		}
	}
	console.log("ok the card's buttons are Sen Medium 13px, 28px tall on a desktop and 44px at phone width, light and dark");
	// At 1280 two cards fill a row, so the tile has one of its own on a desktop too; at 800 a narrow window stands the cards in one column, as a phone does.
	for (const width of [1280, 800]) {
		const { context, page } = await openHome(browser, width, "light");
		await waitForCards(page);
		await checkTileHeight(page, `${width}px light`, true);
		await closeContext(context);
	}
	console.log("ok a card's name, status mark and gear share one centre line, wrapped or not, and the New room tile alone in its row is a card's height");

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
		assert(entering.fitsOneLine && entering.height === buttonHeight(width), `${width}px: "Entering…" fits on one line at ${buttonHeight(width)}px, got ${JSON.stringify(entering)}`);
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
