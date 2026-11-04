// The gear menu's Help › and the Shortcuts window, in the browser against a
// real spawned server, once as a Mac and once as Windows, then on a phone:
//
// - Help opens two rows, How it works and Shortcuts with its key (⌘/ on a
//   Mac, Ctrl+/ elsewhere): beside the menu on hover, and by keyboard with
//   the arrow keys, Enter and Esc; on a touch screen they show in place under
//   Help when it is tapped, with no key, and Shortcuts is left out until a
//   hardware keyboard presses a key (typing in the box is the screen's own
//   keyboard and does not count);
// - ⌘/ (Ctrl+/) opens the window on Home, over Settings and in a room, also as
//   a German keyboard types / (Shift+7); the same key and Esc close it; the
//   other platform's chord does nothing; it does nothing while a list, a
//   popover (the model and effort panel) or the diagram viewer is open; a question that
//   arrives behind it does not take its Esc;
// - the window lists its keys under two headings a screen reader takes as
//   row-group headers, General and In rooms, and every row does what it
//   says, with the keys it shows on that platform.
//
// Offline: the model is a synthetic gateway on this machine.
// Run: npm run smokes -- help-shortcuts   (or tsx this file)
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, type Browser, type BrowserContextOptions, type Page } from "playwright";
import { authedFetch, SMOKE_AUTH_TOKEN, SMOKE_SERVER_AUTH_ENV, SMOKE_SERVER_SPAWN_TREE_OPTIONS, smokeHomeEnv, stopSmokeServer, freePort, waitForServer } from "./smoke-server-process.js";
import { waitEvery } from "./smoke-wait.js";

const waitUntil = waitEvery(100, 15_000);

{
	const p = typeof chromium?.executablePath === "function" ? chromium.executablePath() : "";
	if (!p || !fs.existsSync(p)) {
		console.log("help shortcuts ui smoke skipped (Chromium not installed)");
		process.exit(0);
	}
}

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const webServerDir = path.resolve(scriptDir, "..");
const repoRoot = path.resolve(webServerDir, "..", "..");
const port = await freePort();
const baseUrl = `http://127.0.0.1:${port}`;

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "exxperts-help-shortcuts-ui-"));
const tempHome = path.join(tempRoot, "home");
const agentsRoot = path.join(tempHome, ".exxperts", "app", "personalized-agents");
const agentDir = path.join(tempHome, ".exxperts", "agent");
const appDir = path.join(tempHome, ".exxperts", "app");
for (const dir of [agentsRoot, agentDir]) fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
process.env.HOME = tempHome;
process.env.USERPROFILE = tempHome;
process.env.EXXPERTS_CODING_AGENT_DIR = agentDir;
process.env.EXXETA_PERSISTENT_AGENTS_ROOT = agentsRoot;

const MAC = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36";
const WINDOWS = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36";
const PHONE = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1";
const ASK_FOR_DIAGRAM = "Please draw the diagram";
const ASK_FOR_COMMAND = "Please list the folder";
// A denied step: its row while the turn runs, its folded card after.
const NOT_RUN = /Not done · you said no|not run/;
const DIAGRAM = "```mermaid\nflowchart LR\n  A[Start] --> B[Middle] --> C[End]\n```";
const LONG_MESSAGE = Array.from({ length: 40 }, (_, i) => `Line ${i + 1} of a long message.`).join("\n");

type ListedSection = { heading: string; scope: string; rows: [string, string][] };
/** The sections the Shortcuts window lists, as each platform writes them: each heading, then its rows, the action and its keys as shown. */
function expectedSections(mac: boolean): ListedSection[] {
	const enter = mac ? "↵" : "Enter";
	const sendNow = mac ? "⌘↵" : "Ctrl+Enter";
	return [
		{
			heading: "General",
			scope: "rowgroup",
			rows: [
				["Shortcuts (this list)", mac ? "⌘/" : "Ctrl+/"],
				["Settings", mac ? "⌘," : "Ctrl+,"],
			],
		},
		{
			heading: "In rooms",
			scope: "rowgroup",
			rows: [
				["Send, or queue it while the room answers", enter],
				["New line", mac ? "⇧↵" : "Shift+Enter"],
				["Send now, stopping the answer", sendNow],
				["Stop the answer", "Esc"],
				["Allow a waiting step", enter],
				["Deny a waiting step", "Esc"],
				["Open or close a card or a row you reached with Tab", `${enter} or Space`],
				["This room's settings", mac ? "⇧⌘," : "Ctrl+Shift+,"],
				["Diagram viewer: zoom in, zoom out, actual size, fit, close", "+ − 0 F Esc"],
			],
		},
	];
}

// The gateway: a message asking for the diagram gets one mermaid fence; one
// asking to list the folder gets one bash call, held back while `holdAsk` is
// set until `releaseAsk` runs, so a window can be opened before the room asks
// about it; anything else "Done.".
const askGate: { hold: boolean; held: (() => void) | null } = { hold: false, held: null };
async function releaseAsk(): Promise<void> {
	await waitUntil(() => askGate.held !== null, "the room's command request reaches the gateway");
	const send = askGate.held!;
	askGate.hold = false;
	askGate.held = null;
	send();
}
const gateway = http.createServer((req, res) => {
	if (req.method !== "POST" || !String(req.url ?? "").endsWith("/chat/completions")) {
		res.writeHead(404).end();
		return;
	}
	let raw = "";
	req.on("data", (chunk) => { raw += chunk; });
	req.on("end", () => {
		let body: any = {};
		try { body = JSON.parse(raw); } catch {}
		const messages: any[] = Array.isArray(body?.messages) ? body.messages : [];
		const last = messages.filter((message) => message?.role === "user").at(-1);
		const asked = typeof last?.content === "string" ? last.content : JSON.stringify(last?.content ?? "");
		const sse = (payload: unknown) => res.write(`data: ${JSON.stringify(payload)}\n\n`);
		res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
		const base = { id: `cmpl_${Date.now()}`, object: "chat.completion.chunk", created: Math.floor(Date.now() / 1000), model: String(body?.model ?? "room-model") };
		if (asked.includes(ASK_FOR_COMMAND) && messages.at(-1)?.role !== "tool") {
			const send = () => {
				sse({ ...base, choices: [{ index: 0, delta: { role: "assistant", tool_calls: [{ index: 0, id: `call_ls_${Date.now()}`, type: "function", function: { name: "bash", arguments: JSON.stringify({ command: "ls" }) } }] }, finish_reason: null }] });
				sse({ ...base, choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }], usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 } });
				res.write("data: [DONE]\n\n");
				res.end();
			};
			if (askGate.hold) askGate.held = send;
			else send();
			return;
		}
		const answer = asked.includes(ASK_FOR_DIAGRAM) ? `Here it is.\n\n${DIAGRAM}\n` : "Done.";
		sse({ ...base, choices: [{ index: 0, delta: { role: "assistant", content: answer }, finish_reason: null }] });
		sse({ ...base, choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 100, completion_tokens: 5, total_tokens: 105 } });
		res.write("data: [DONE]\n\n");
		res.end();
	});
});

let server: ChildProcessWithoutNullStreams | undefined;
const serverOutput: string[] = [];
const failures: string[] = [];
const expect = (condition: unknown, message: string) => {
	if (!condition) failures.push(message);
	console.log(`${condition ? "  ok  " : "FAIL  "}${message}`);
};

try {
	const gatewayPort = await freePort();
	await new Promise<void>((resolve) => gateway.listen(gatewayPort, "127.0.0.1", resolve));
	fs.writeFileSync(path.join(agentDir, "models.json"), JSON.stringify({
		providers: { "fake-gpt": { name: "Fake GPT", baseUrl: `http://127.0.0.1:${gatewayPort}/v1`, api: "openai-completions", models: [{ id: "gpt-fake", name: "GPT Fake", reasoning: true, input: ["text"], contextWindow: 128000, maxTokens: 16000 }] } },
	}, null, 2), { mode: 0o600 });
	fs.writeFileSync(path.join(agentDir, "auth.json"), JSON.stringify({ "fake-gpt": { type: "api_key", key: "synthetic-help-shortcuts" } }, null, 2), { mode: 0o600 });
	fs.writeFileSync(path.join(appDir, "custom-ai-profiles.json"), JSON.stringify({ version: 1, profiles: [
		{ id: "custom-fake-gpt", providerId: "fake-gpt", label: "Fake GPT", roomModels: ["gpt-fake"], learnModel: "gpt-fake", reviewMemoryModel: "gpt-fake" },
	] }, null, 2), { mode: 0o600 });
	fs.writeFileSync(path.join(appDir, "persistent-agent-ai-profile.json"), JSON.stringify({ profileId: "custom-fake-gpt" }, null, 2), { mode: 0o600 });

	const agents = await import("../src/persistent-agents.js");
	const roomModels = await import("../src/room-models.js");
	const create = (displayName: string) => {
		const agentId = agents.createPersistentAgentFromScaffoldInput({ displayName, userName: "Synthetic User", preferredUserAddress: "Synthetic User" }).agent.agentId;
		roomModels.writeRoomModels(agentId, { conversation: { provider: "fake-gpt", model: "gpt-fake" } });
		return agentId;
	};
	// One room per platform, so each opens a fresh conversation; a third gives the @ list a room to offer.
	const platformRooms = ["Mac Room", "Windows Room"].map(create);
	create("Other Room");
	const workspaceRoot = path.join(tempRoot, "workspace");
	fs.mkdirSync(workspaceRoot, { recursive: true, mode: 0o700 });

	server = spawn("npx", ["tsx", "src/index.ts"], {
		shell: process.platform === "win32",
		...SMOKE_SERVER_SPAWN_TREE_OPTIONS,
		cwd: webServerDir,
		env: smokeHomeEnv(tempHome, { PORT: String(port), ...SMOKE_SERVER_AUTH_ENV, EXXETA_HOME: repoRoot, EXXPERTS_CODING_AGENT_DIR: agentDir, EXXETA_PERSISTENT_AGENTS_ROOT: agentsRoot }) as NodeJS.ProcessEnv,
	});
	server.stdout.on("data", (chunk) => serverOutput.push(String(chunk)));
	server.stderr.on("data", (chunk) => serverOutput.push(String(chunk)));
	await waitForServer(server, baseUrl, 30_000);
	// Full access with the terminal on, so each room asks before it runs a command.
	for (const roomId of platformRooms) {
		const workspace = await authedFetch(`${baseUrl}/api/persistent-agents/${encodeURIComponent(roomId)}/workspace-default`, {
			method: "PUT",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ root: workspaceRoot, displayLabel: "Keys Workspace", workspaceAccessMode: "localFiles", bashEnabled: true }),
		});
		if (!workspace.ok) throw new Error(`the room's folder is set, got ${workspace.status}`);
	}

	const browser = await chromium.launch();
	try {
		await checkDesktop(browser, "Mac", MAC, "Mac Room");
		await checkDesktop(browser, "Windows", WINDOWS, "Windows Room");
		await checkPhone(browser);
	} finally {
		await browser.close();
	}
	if (failures.length) throw new Error(`${failures.length} check(s) failed:\n- ${failures.join("\n- ")}`);
	console.log("help-shortcuts-ui smoke: ok");
} catch (error) {
	console.error(serverOutput.join("").split("\n").filter((line) => !line.includes("token=")).join("\n").slice(-4000));
	throw error;
} finally {
	await stopSmokeServer(server);
	await new Promise<void>((resolve) => gateway.close(() => resolve()));
	fs.rmSync(tempRoot, { recursive: true, force: true });
}

async function openApp(browser: Browser, options: BrowserContextOptions): Promise<{ page: Page; close: () => Promise<void> }> {
	const ctx = await browser.newContext(options);
	const page = await ctx.newPage();
	await page.goto(`${baseUrl}/auth/session?token=${SMOKE_AUTH_TOKEN}`);
	await page.waitForLoadState("networkidle");
	const dismiss = page.locator(".whats-new-close");
	if (await dismiss.count()) await dismiss.click();
	await page.locator(".persistent-agent-card").first().waitFor({ timeout: 20_000 });
	return { page, close: () => ctx.close() };
}

function shortcutsWindow(page: Page) {
	return page.getByRole("dialog", { name: "Shortcuts" });
}
async function shortcutsShown(page: Page): Promise<boolean> {
	return (await shortcutsWindow(page).count()) > 0;
}
/** The window is open and on top: what is drawn at its centre is the window, not a dialog over it. */
async function shortcutsSeen(page: Page): Promise<boolean> {
	if (!(await shortcutsShown(page))) return false;
	return shortcutsWindow(page).evaluate((dialog) => {
		const box = dialog.getBoundingClientRect();
		return dialog.contains(document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2));
	});
}

/** Each row group of the window: its heading cell (words and scope, as a screen reader takes them) and the rows under it. */
async function listedSections(page: Page): Promise<ListedSection[]> {
	return shortcutsWindow(page).locator("tbody").evaluateAll((groups) => groups.map((group) => {
		const heading = group.querySelector("th");
		const rows = [...group.querySelectorAll("tr")].filter((row) => row.querySelector("td")).map((row) => {
			const cells = row.querySelectorAll("td");
			return [cells[0]?.textContent?.trim() ?? "", (cells[1]?.textContent ?? "").replace(/\s+/g, " ").trim()] as [string, string];
		});
		return { heading: heading?.textContent?.trim() ?? "", scope: heading?.getAttribute("scope") ?? "", rows };
	}));
}

/** Presses the chord as a German keyboard types /: Shift+7, which gives the character "/". */
async function pressGermanSlash(page: Page, mac: boolean): Promise<void> {
	await page.evaluate((onMac) => {
		const target = document.activeElement ?? document.body;
		target.dispatchEvent(new KeyboardEvent("keydown", { key: "/", code: "Digit7", shiftKey: true, metaKey: onMac, ctrlKey: !onMac, bubbles: true, cancelable: true }));
	}, mac);
}

async function checkDesktop(browser: Browser, platform: "Mac" | "Windows", userAgent: string, roomName: string): Promise<void> {
	const mac = platform === "Mac";
	const mod = mac ? "Meta" : "Control";
	const otherMod = mac ? "Control" : "Meta";
	const { page, close } = await openApp(browser, { viewport: { width: 1280, height: 900 }, userAgent });
	try {
		const gear = page.locator("button.sidebar-config-gear").first();
		const menu = page.locator(".sidebar-config-menu");
		const help = menu.getByRole("menuitem", { name: /^Help/ });
		const rows = menu.locator(".menu-sub");
		const howItWorks = rows.getByRole("menuitem", { name: "How it works" });
		const shortcutsRow = rows.getByRole("menuitem", { name: /^Shortcuts/ });

		// The menu shows Help ›, its rows closed.
		await gear.click();
		await help.waitFor({ timeout: 10_000 });
		const helpWords = (await help.innerText()).replace(/\s+/g, " ").trim();
		expect(helpWords === "Help ›", `${platform}: the gear menu shows "Help ›", got "${helpWords}"`);
		expect((await rows.count()) === 0, `${platform}: Help's rows are closed until Help is pointed at`);

		// By mouse: hovering Help opens its rows beside the menu, Shortcuts with its key; leaving for Settings closes them.
		await help.hover();
		await howItWorks.waitFor({ timeout: 5000 });
		const menuBox = await menu.boundingBox();
		const rowsBox = await rows.boundingBox();
		expect(menuBox && rowsBox && rowsBox.x >= menuBox.x + menuBox.width, `${platform}: Help's rows open beside the menu: menu ${JSON.stringify(menuBox)}, rows ${JSON.stringify(rowsBox)}`);
		const rowKey = (await shortcutsRow.locator(".menu-item-kbd").innerText().catch(() => "")).trim();
		expect(rowKey === (mac ? "⌘/" : "Ctrl+/"), `${platform}: the Shortcuts row shows ${mac ? "⌘/" : "Ctrl+/"}, got "${rowKey}"`);
		await help.click();
		expect(await howItWorks.isVisible(), `${platform}: a click on Help after the hover keeps its rows open`);
		await shortcutsRow.hover();
		expect(await shortcutsRow.isVisible(), `${platform}: the rows stay open while the pointer crosses over to them`);
		await menu.getByRole("menuitem", { name: /^Settings/ }).hover();
		await waitUntil(async () => (await rows.count()) === 0, `${platform}: the rows close when the pointer leaves for Settings`).catch(() => {});
		expect((await rows.count()) === 0, `${platform}: leaving Help for Settings closes its rows`);

		// By mouse: How it works opens today's Help window.
		await help.hover();
		await howItWorks.click();
		const helpWindow = page.getByRole("dialog", { name: "How exxperts works" });
		await helpWindow.waitFor({ timeout: 5000 });
		expect((await menu.count()) === 0 && (await helpWindow.getByRole("heading", { name: "How exxperts works" }).count()) === 1, `${platform}: How it works opens the Help window and closes the menu`);
		await page.keyboard.press("Escape");
		await waitUntil(async () => (await helpWindow.count()) === 0, `${platform}: Esc closes the Help window`);

		// By keyboard: → opens the rows on the first, ↓ ↑ move, Esc goes back to Help with the menu open, Enter opens them again.
		await page.mouse.move(900, 450);
		await gear.click();
		await help.focus();
		await page.keyboard.press("ArrowRight");
		await waitUntil(async () => howItWorks.evaluate((node) => node === document.activeElement).catch(() => false), `${platform}: → opens the rows with How it works focused`);
		await page.keyboard.press("ArrowDown");
		expect(await shortcutsRow.evaluate((node) => node === document.activeElement), `${platform}: ↓ moves to Shortcuts`);
		await page.keyboard.press("ArrowUp");
		expect(await howItWorks.evaluate((node) => node === document.activeElement), `${platform}: ↑ moves back to How it works`);
		await page.keyboard.press("Escape");
		await waitUntil(async () => (await rows.count()) === 0, `${platform}: Esc closes the rows`);
		expect((await menu.count()) === 1 && (await help.evaluate((node) => node === document.activeElement)), `${platform}: Esc closes only Help's rows; the menu stays, Help focused`);
		await page.keyboard.press("Enter");
		await waitUntil(async () => howItWorks.evaluate((node) => node === document.activeElement).catch(() => false), `${platform}: Enter on Help opens its rows`);
		await page.keyboard.press("ArrowDown");
		await page.keyboard.press("Enter");
		await shortcutsWindow(page).waitFor({ timeout: 5000 });
		expect((await menu.count()) === 0, `${platform}: Enter on Shortcuts opens the Shortcuts window and closes the menu`);

		// The window lists every key as this platform writes it.
		const listed = await listedSections(page);
		expect(JSON.stringify(listed) === JSON.stringify(expectedSections(mac)), `${platform}: the Shortcuts window lists the keys under General and In rooms as ${platform} writes them, got ${JSON.stringify(listed)}`);
		await page.keyboard.press("Escape");
		await waitUntil(async () => !(await shortcutsShown(page)), `${platform}: Esc closes the Shortcuts window`);

		// The chord on Home: opens, the same key closes; the other platform's chord does nothing; a German / opens it.
		await page.keyboard.press(`${mod}+Slash`);
		await waitUntil(() => shortcutsSeen(page), `${platform}: ${mod}+/ opens the Shortcuts window on Home`).catch(() => {});
		expect(await shortcutsSeen(page), `${platform}: ${mac ? "⌘/" : "Ctrl+/"} opens the Shortcuts window on Home`);
		await page.keyboard.press(`${mod}+Slash`);
		await waitUntil(async () => !(await shortcutsShown(page)), `${platform}: the same key closes it`).catch(() => {});
		expect(!(await shortcutsShown(page)), `${platform}: the same key closes the Shortcuts window`);
		await page.keyboard.press(`${otherMod}+Slash`);
		await page.keyboard.press(`${otherMod}+Shift+Slash`);
		expect(!(await shortcutsShown(page)), `${platform}: ${otherMod}+/ does nothing`);
		await pressGermanSlash(page, mac);
		await waitUntil(() => shortcutsSeen(page), `${platform}: / typed as Shift+7 opens it`).catch(() => {});
		expect(await shortcutsSeen(page), `${platform}: the chord opens the window when / needs Shift (German keyboard)`);
		await pressGermanSlash(page, mac);
		await waitUntil(async () => !(await shortcutsShown(page)), `${platform}: the German / closes it`).catch(() => {});
		expect(!(await shortcutsShown(page)), `${platform}: the same German / closes it`);

		// Settings (its row's key): opens Settings; the chord opens Shortcuts over it, and Esc closes only Shortcuts.
		const settings = page.getByRole("dialog", { name: "Settings" });
		await page.keyboard.press(`${mod}+Comma`);
		await settings.waitFor({ timeout: 5000 }).catch(() => {});
		expect((await settings.count()) === 1, `${platform}: ${mac ? "⌘," : "Ctrl+,"} opens Settings`);
		await page.keyboard.press(`${mod}+Slash`);
		await waitUntil(() => shortcutsSeen(page), `${platform}: the chord opens Shortcuts over Settings`).catch(() => {});
		expect(await shortcutsSeen(page), `${platform}: the chord opens the Shortcuts window over Settings`);
		await page.keyboard.press("Escape");
		await waitUntil(async () => !(await shortcutsShown(page)), `${platform}: Esc closes Shortcuts over Settings`).catch(() => {});
		expect(!(await shortcutsShown(page)) && (await settings.count()) === 1, `${platform}: Esc over Settings closes only the Shortcuts window`);
		await page.keyboard.press("Escape");
		await waitUntil(async () => (await settings.count()) === 0, `${platform}: the next Esc closes Settings`);

		// A full screen with its own Esc (Memory's reading panel): the window opens over it, and Esc closes only the window.
		const nav = page.locator(".product-nav");
		await nav.getByRole("button", { name: "Memory" }).click();
		await page.getByRole("button", { name: "Expand Other Room" }).click();
		await page.getByRole("button", { name: "Full screen ⤢" }).click();
		const fullScreen = page.getByRole("dialog", { name: "Memory reading panel, full screen" });
		await fullScreen.waitFor({ timeout: 10_000 });
		await page.keyboard.press(`${mod}+Slash`);
		await waitUntil(() => shortcutsSeen(page), `${platform}: the chord opens Shortcuts over Memory's full screen`).catch(() => {});
		expect(await shortcutsSeen(page), `${platform}: the chord opens the Shortcuts window over Memory's full screen`);
		await page.keyboard.press("Escape");
		await waitUntil(async () => !(await shortcutsShown(page)), `${platform}: Esc closes Shortcuts over the full screen`).catch(() => {});
		expect(!(await shortcutsShown(page)) && (await fullScreen.count()) === 1, `${platform}: Esc over Memory's full screen closes only the Shortcuts window`);
		await page.keyboard.press("Escape");
		await waitUntil(async () => (await fullScreen.count()) === 0, `${platform}: the next Esc leaves the full screen`);
		await nav.getByRole("button", { name: "Rooms" }).click();

		// In a room.
		await page.locator(".persistent-agent-card").filter({ hasText: roomName }).getByRole("button", { name: "Enter" }).click();
		const composer = page.locator(".composer textarea").first();
		await composer.waitFor({ timeout: 20_000 });

		// The chord from the message box: opens, Esc closes and the box has the focus again, its text kept.
		await composer.fill("kept text");
		await composer.focus();
		await page.keyboard.press(`${mod}+Slash`);
		await waitUntil(() => shortcutsSeen(page), `${platform}: the chord opens Shortcuts in a room`).catch(() => {});
		expect(await shortcutsSeen(page), `${platform}: the chord opens the Shortcuts window in a room, from the message box`);
		await page.keyboard.press("Escape");
		await waitUntil(async () => !(await shortcutsShown(page)), `${platform}: Esc closes it in a room`).catch(() => {});
		expect(!(await shortcutsShown(page)) && (await composer.evaluate((node) => node === document.activeElement)) && (await composer.inputValue()) === "kept text", `${platform}: Esc closes it and the box has the focus back, its text kept`);

		// A list that takes keys: with the @ list open the chord does nothing; with it closed it works again.
		await composer.fill("@");
		const mentionList = page.locator(".mention-pop");
		await mentionList.waitFor({ timeout: 5000 });
		await page.keyboard.press(`${mod}+Slash`);
		expect(!(await shortcutsShown(page)) && (await mentionList.count()) === 1, `${platform}: the chord does nothing while the @ list is open`);
		await composer.fill("");
		await waitUntil(async () => (await mentionList.count()) === 0, `${platform}: the @ list closes`);
		await page.keyboard.press(`${mod}+Slash`);
		await waitUntil(() => shortcutsSeen(page), `${platform}: the chord opens Shortcuts once the list is closed`).catch(() => {});
		expect(await shortcutsSeen(page), `${platform}: with the @ list closed, the chord opens the window`);
		await page.keyboard.press(`${mod}+Slash`);
		await waitUntil(async () => !(await shortcutsShown(page)), `${platform}: the chord closes it`);

		// New line: Shift+Enter adds a line and sends nothing.
		const userMessages = page.locator(".user-message-content");
		const sentBefore = await userMessages.count();
		await composer.focus();
		await page.keyboard.type("first line");
		await page.keyboard.press("Shift+Enter");
		await page.keyboard.type("second line");
		expect((await composer.inputValue()) === "first line\nsecond line" && (await userMessages.count()) === sentBefore, `${platform}: Shift+Enter makes a new line and sends nothing`);

		// Send: Enter sends it, and the room answers.
		await waitUntil(() => page.locator("button.send-btn:not(.stop-btn)").isEnabled(), `${platform}: the room can take a message`, 20_000);
		await page.keyboard.press("Enter");
		await waitUntil(async () => (await userMessages.count()) === sentBefore + 1, `${platform}: Enter sends`).catch(() => {});
		expect((await userMessages.count()) === sentBefore + 1 && (await composer.inputValue()) === "", `${platform}: Enter sends the message`);
		await waitUntil(async () => (await page.locator("button.send-btn:not(.stop-btn)").count()) === 1 && (await page.getByText("Done.").count()) > 0, `${platform}: the room answers`, 20_000);

		// Open or close a row: a long message folds; Tab to its toggle, Enter opens it, Space closes it.
		await composer.fill(LONG_MESSAGE);
		await page.keyboard.press("Enter");
		const toggle = page.locator("button.user-message-toggle").last();
		await toggle.waitFor({ timeout: 10_000 });
		await waitUntil(async () => (await page.locator("button.send-btn:not(.stop-btn)").count()) === 1, `${platform}: the room is idle again`, 20_000);
		// Tab reaches the row: from the element just before it in the tab order.
		await toggle.evaluate((node) => {
			const before = document.createElement("button");
			before.id = "tab-start";
			node.parentElement!.insertBefore(before, node);
			before.focus();
		});
		await page.keyboard.press("Tab");
		await page.evaluate(() => document.getElementById("tab-start")?.remove());
		expect(await toggle.evaluate((node) => node === document.activeElement), `${platform}: Tab reaches the folded row's toggle`);
		const expandedBefore = await toggle.getAttribute("aria-expanded");
		await page.keyboard.press("Enter");
		const afterEnter = await toggle.getAttribute("aria-expanded");
		await page.keyboard.press("Space");
		const afterSpace = await toggle.getAttribute("aria-expanded");
		expect(expandedBefore === "false" && afterEnter === "true" && afterSpace === "false", `${platform}: Enter opens a folded row and Space closes it (${expandedBefore} → ${afterEnter} → ${afterSpace})`);

		// A popover with keys of its own: with the model and effort panel open the chord does nothing; once it is closed it works.
		const modelControl = page.getByRole("button", { name: /^Model( and effort)?: / }).first();
		await modelControl.click();
		const modelPanel = page.getByRole("dialog", { name: "Model and effort" });
		await modelPanel.waitFor({ timeout: 5000 });
		await page.keyboard.press(`${mod}+Slash`);
		expect(!(await shortcutsShown(page)) && (await modelPanel.count()) === 1, `${platform}: the chord does nothing while the model panel is open`);
		await page.keyboard.press("Escape");
		await waitUntil(async () => (await modelPanel.count()) === 0, `${platform}: Esc closes the model panel`);
		await page.keyboard.press(`${mod}+Slash`);
		await waitUntil(() => shortcutsSeen(page), `${platform}: the chord opens Shortcuts once the model panel is closed`).catch(() => {});
		expect(await shortcutsSeen(page), `${platform}: with the model panel closed, the chord opens the window`);
		await page.keyboard.press("Escape");
		await waitUntil(async () => !(await shortcutsShown(page)), `${platform}: Esc closes it again`);

		// A question that arrives behind the window: Esc closes the window only, and the question still waits.
		// Once the turn ends a card folds into one sentence: a denied step's says "not run".
		const allowedRows = () => page.locator(".wk-card").filter({ hasNotText: NOT_RUN }).count();
		const deniedRows = () => page.locator(".wk-card").filter({ hasText: NOT_RUN }).count();
		const asks = page.locator(".wk-ask .wk-btn.primary");
		askGate.hold = true;
		await composer.fill(ASK_FOR_COMMAND);
		await composer.press("Enter");
		await page.keyboard.press(`${mod}+Slash`);
		await waitUntil(() => shortcutsSeen(page), `${platform}: the window opens while the room works`);
		await releaseAsk();
		await waitUntil(async () => (await asks.count()) === 1, `${platform}: the room asks behind the window`, 20_000);
		expect(await shortcutsWindow(page).evaluate((dialog) => dialog.contains(document.activeElement)), `${platform}: the question behind the window does not take the focus from it`);
		await page.keyboard.press("Escape");
		await waitUntil(async () => !(await shortcutsShown(page)), `${platform}: Esc closes the window over the question`).catch(() => {});
		expect(!(await shortcutsShown(page)) && (await asks.count()) === 1 && (await deniedRows()) === 0, `${platform}: Esc closes only the window; the question still waits`);

		// The room's Attachments over a waiting question: Esc closes them only, from the page and from the box.
		const attachments = page.locator(".attachments-panel");
		for (const from of ["the page", "the box"]) {
			await page.locator(".attachments-entry").click();
			await attachments.waitFor({ timeout: 5000 });
			if (from === "the box") await composer.focus();
			await page.keyboard.press("Escape");
			await waitUntil(async () => (await attachments.count()) === 0, `${platform}: Esc from ${from} closes the Attachments`).catch(() => {});
			expect((await attachments.count()) === 0 && (await asks.count()) === 1 && (await deniedRows()) === 0, `${platform}: Esc from ${from} closes only the Attachments; the question still waits`);
		}
		await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());

		// Deny it: Esc, the box empty.
		await page.keyboard.press("Escape");
		await waitUntil(async () => (await deniedRows()) === 1, `${platform}: Esc denies the waiting step`).catch(() => {});
		expect((await deniedRows()) === 1 && (await allowedRows()) === 0, `${platform}: Esc, the box empty, denies the step that waits`);
		await waitUntil(async () => (await page.locator("button.send-btn:not(.stop-btn)").count()) === 1, `${platform}: the room is idle after the denial`, 20_000);

		// Allow it: Enter, the box empty.
		await composer.fill(ASK_FOR_COMMAND);
		await composer.press("Enter");
		await waitUntil(async () => (await asks.count()) === 1, `${platform}: the room asks again`, 20_000);
		await page.keyboard.press("Enter");
		await waitUntil(async () => (await allowedRows()) === 1, `${platform}: Enter allows the waiting step`).catch(() => {});
		expect((await allowedRows()) === 1, `${platform}: Enter, the box empty, allows the step that waits`);
		await waitUntil(async () => (await page.locator("button.send-btn:not(.stop-btn)").count()) === 1, `${platform}: the room is idle after the step`, 20_000);

		// This room's settings: ⇧⌘, (Ctrl+Shift+,) opens them; Esc closes them.
		const roomSettings = page.locator(".rs-shell[role='dialog']");
		await composer.focus();
		await page.keyboard.press(`${mod}+Shift+Comma`);
		await roomSettings.waitFor({ timeout: 5000 }).catch(() => {});
		expect((await roomSettings.count()) === 1, `${platform}: ${mac ? "⇧⌘," : "Ctrl+Shift+,"} opens this room's settings`);
		await page.keyboard.press("Escape");
		await waitUntil(async () => (await roomSettings.count()) === 0, `${platform}: Esc closes the room's settings`);

		// The diagram viewer: + − 0 F Esc; the chord does nothing while it is open.
		await composer.fill(ASK_FOR_DIAGRAM);
		await page.keyboard.press("Enter");
		const expand = page.getByRole("button", { name: "Open expanded diagram" }).last();
		await expand.waitFor({ timeout: 20_000 });
		await expand.click({ force: true });
		const viewer = page.locator(".mermaid-viewer-overlay");
		const zoom = viewer.locator(".mermaid-viewer-zoom-value");
		await zoom.waitFor({ timeout: 5000 });
		await waitUntil(async () => (await viewer.locator(".mermaid-viewer-svg svg").count()) === 1, `${platform}: the viewer draws the diagram`);
		const zoomText = async () => (await zoom.innerText()).trim();
		await page.keyboard.press(`${mod}+Slash`);
		expect(!(await shortcutsShown(page)) && (await viewer.count()) === 1, `${platform}: the chord does nothing while the diagram viewer is open`);
		const start = await zoomText();
		await page.keyboard.press("+");
		const zoomedIn = await zoomText();
		await page.keyboard.press("-");
		const zoomedBack = await zoomText();
		await page.keyboard.press("+");
		await page.keyboard.press("+");
		await page.keyboard.press("0");
		const actual = await zoomText();
		await page.keyboard.press("f");
		const fitByKey = await zoomText();
		await page.keyboard.press("+");
		await viewer.getByRole("button", { name: "Fit to window" }).click();
		const fitByButton = await zoomText();
		expect(parseInt(zoomedIn) > parseInt(start) && parseInt(zoomedBack) < parseInt(zoomedIn) && actual === "100%", `${platform}: + zooms in, − zooms out, 0 is actual size (${start}, ${zoomedIn}, ${zoomedBack}, ${actual})`);
		expect(fitByKey === fitByButton, `${platform}: F fits the diagram as Fit does (${fitByKey}, Fit ${fitByButton})`);
		await page.keyboard.press("Escape");
		await waitUntil(async () => (await viewer.count()) === 0, `${platform}: Esc closes the viewer`).catch(() => {});
		expect((await viewer.count()) === 0, `${platform}: Esc closes the diagram viewer`);
	} finally {
		await close();
	}
}

async function checkPhone(browser: Browser): Promise<void> {
	const { page, close } = await openApp(browser, { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, userAgent: PHONE });
	try {
		expect(await page.evaluate(() => window.matchMedia("(hover: none)").matches), "phone: the screen has no hover");
		const menu = page.locator(".sidebar-config-menu");
		const help = menu.getByRole("menuitem", { name: /^Help/ });
		const rows = menu.locator(".menu-sub");
		const shortcutsRow = rows.getByRole("menuitem", { name: /^Shortcuts/ });
		const helpRowNames = async () => (await rows.getByRole("menuitem").allInnerTexts()).map((text) => text.trim());
		const gear = page.locator("button.sidebar-config-gear").filter({ visible: true }).first();
		const openHelpRows = async () => {
			if (!(await gear.count())) await page.getByRole("button", { name: "Show sidebar" }).tap();
			await gear.tap();
			await help.waitFor({ timeout: 10_000 });
			await help.tap();
			await rows.getByRole("menuitem", { name: "How it works" }).waitFor({ timeout: 5000 });
		};
		const openHowItWorks = async () => {
			await rows.getByRole("menuitem", { name: "How it works" }).tap();
			const window = page.getByRole("dialog", { name: "How exxperts works" });
			await window.waitFor({ timeout: 5000 }).catch(() => {});
			const opened = (await window.count()) === 1;
			if (opened) {
				await window.getByRole("button", { name: "Close" }).first().tap();
				await waitUntil(async () => (await window.count()) === 0, "phone: the Help window closes");
			}
			return opened;
		};

		await gear.tap();
		await help.waitFor({ timeout: 10_000 });
		expect((await rows.count()) === 0, "phone: Help's rows are closed until Help is tapped");
		await help.tap();
		await rows.getByRole("menuitem", { name: "How it works" }).waitFor({ timeout: 5000 });
		const menuBox = await menu.boundingBox();
		const rowsBox = await rows.boundingBox();
		expect(menuBox && rowsBox && rowsBox.x >= menuBox.x && rowsBox.x + rowsBox.width <= menuBox.x + menuBox.width + 1, `phone: Help's rows show in place, inside the menu: menu ${JSON.stringify(menuBox)}, rows ${JSON.stringify(rowsBox)}`);
		expect(JSON.stringify(await helpRowNames()) === JSON.stringify(["How it works"]), `phone, no keyboard: Help shows How it works alone, without Shortcuts, got ${JSON.stringify(await helpRowNames())}`);
		expect(await openHowItWorks(), "phone: tapping How it works opens the Help window");

		// Typing in the box is the screen's own keyboard: Help still leaves Shortcuts out.
		await page.locator(".persistent-agent-card").filter({ hasText: "Other Room" }).getByRole("button", { name: "Enter" }).tap();
		const composer = page.locator("textarea").first();
		await composer.waitFor({ timeout: 15_000 });
		await composer.tap();
		await page.keyboard.type("Typed on the screen");
		expect((await composer.inputValue()) === "Typed on the screen", "phone: the words typed are in the box");
		await openHelpRows();
		expect(JSON.stringify(await helpRowNames()) === JSON.stringify(["How it works"]), `phone, after typing in the box: Help still shows How it works alone, got ${JSON.stringify(await helpRowNames())}`);
		expect(await openHowItWorks(), "phone, in the room: How it works still opens the Help window");

		// Shift alone in the box is a hardware keyboard, as on a tablet with one typing a capital: Shortcuts is offered from then on.
		const hideSidebar = page.getByRole("button", { name: "Hide sidebar" }).filter({ visible: true });
		if (await hideSidebar.count()) await hideSidebar.first().tap();
		await composer.tap();
		await page.keyboard.press("Shift");
		await openHelpRows();
		const offered = JSON.stringify(await helpRowNames()) === JSON.stringify(["How it works", "Shortcuts"]);
		expect(offered, `phone, after Shift in the box: Help shows How it works and Shortcuts, got ${JSON.stringify(await helpRowNames())}`);
		if (offered) {
			expect((await shortcutsRow.locator(".menu-item-kbd").count()) === 0, "phone: the Shortcuts row shows no key on a touch screen");
			await shortcutsRow.tap();
			await shortcutsWindow(page).waitFor({ timeout: 5000 }).catch(() => {});
			expect(await shortcutsSeen(page), "phone: tapping Shortcuts opens the Shortcuts window");
			await shortcutsWindow(page).getByRole("button", { name: "Close" }).tap();
			await waitUntil(async () => !(await shortcutsShown(page)), "phone: Close closes it");
		}
	} finally {
		await close();
	}
	// A fresh page: a key pressed outside any field is a hardware keyboard too.
	const fresh = await openApp(browser, { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, userAgent: PHONE });
	try {
		const menu = fresh.page.locator(".sidebar-config-menu");
		const rows = menu.locator(".menu-sub");
		await fresh.page.locator("h1, h2").first().tap();
		await fresh.page.keyboard.press("ArrowDown");
		await fresh.page.locator("button.sidebar-config-gear").filter({ visible: true }).first().tap();
		await menu.getByRole("menuitem", { name: /^Help/ }).tap();
		await rows.getByRole("menuitem", { name: "How it works" }).waitFor({ timeout: 5000 });
		const names = (await rows.getByRole("menuitem").allInnerTexts()).map((text) => text.trim());
		expect(JSON.stringify(names) === JSON.stringify(["How it works", "Shortcuts"]), `phone, after a key outside any field: Help shows How it works and Shortcuts, got ${JSON.stringify(names)}`);
	} finally {
		await fresh.close();
	}
}
