// Keyboard hints only where there is a keyboard. On a touch screen (no hover)
// the command question's Allow and Deny show no keys and the @ list no
// "↑↓ choose · Enter select · Esc dismiss", while the list's "The room's
// memory is read, never changed" stays; with a mouse both hints show. The @
// list also shows each room's full name, with "remembered …" on its own line
// under it, at phone width as well.
//
// Offline: the model is a synthetic gateway on this machine that asks to run
// one command, so the room asks about it in its work card.
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, type Browser, type BrowserContextOptions } from "playwright";
import { authedFetch, SMOKE_AUTH_TOKEN, SMOKE_SERVER_AUTH_ENV, SMOKE_SERVER_SPAWN_TREE_OPTIONS, smokeHomeEnv, stopSmokeServer, freePort, waitForServer } from "./smoke-server-process.js";
import { waitEvery } from "./smoke-wait.js";

const waitUntil = waitEvery(150);

function assert(condition: unknown, message: string): asserts condition {
	if (!condition) throw new Error(message);
}

{
	const p = typeof chromium?.executablePath === "function" ? chromium.executablePath() : "";
	if (!p || !fs.existsSync(p)) {
		console.log("touch hints ui smoke skipped (Chromium not installed)");
		process.exit(0);
	}
}

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const webServerDir = path.resolve(scriptDir, "..");
const repoRoot = path.resolve(webServerDir, "..", "..");
const port = await freePort();
const baseUrl = `http://127.0.0.1:${port}`;

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "exxperts-touch-hints-ui-"));
const tempHome = path.join(tempRoot, "home");
const agentsRoot = path.join(tempHome, ".exxperts", "app", "personalized-agents");
const agentDir = path.join(tempHome, ".exxperts", "agent");
const appDir = path.join(tempHome, ".exxperts", "app");
for (const dir of [agentsRoot, agentDir]) fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
process.env.HOME = tempHome;
process.env.USERPROFILE = tempHome;
process.env.EXXPERTS_CODING_AGENT_DIR = agentDir;
process.env.EXXETA_PERSISTENT_AGENTS_ROOT = agentsRoot;

const ASK_FOR_COMMAND = "Please list the folder";
const CONSULTED_ROOM = "Client Contracts and Procurement Archive";
const KEYS_HINT = "↑↓ choose · Enter select · Esc dismiss";
const MEMORY_LINE = "The room's memory is read, never changed";

// The gateway: the person's message gets one bash call; anything after the
// command's result gets a short answer.
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
		const sse = (payload: unknown) => res.write(`data: ${JSON.stringify(payload)}\n\n`);
		res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
		const base = { id: `cmpl_${Date.now()}`, object: "chat.completion.chunk", created: Math.floor(Date.now() / 1000), model: String(body?.model ?? "room-model") };
		if (raw.includes(ASK_FOR_COMMAND) && messages.at(-1)?.role !== "tool") {
			sse({ ...base, choices: [{ index: 0, delta: { role: "assistant", tool_calls: [{ index: 0, id: `call_ls_${Date.now()}`, type: "function", function: { name: "bash", arguments: JSON.stringify({ command: "ls" }) } }] }, finish_reason: null }] });
			sse({ ...base, choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }], usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 } });
		} else {
			sse({ ...base, choices: [{ index: 0, delta: { role: "assistant", content: "Done." }, finish_reason: null }] });
			sse({ ...base, choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 100, completion_tokens: 5, total_tokens: 105 } });
		}
		res.write("data: [DONE]\n\n");
		res.end();
	});
});

let server: ChildProcessWithoutNullStreams | undefined;
const serverOutput: string[] = [];

try {
	const gatewayPort = await freePort();
	await new Promise<void>((resolve) => gateway.listen(gatewayPort, "127.0.0.1", resolve));
	fs.writeFileSync(path.join(agentDir, "models.json"), JSON.stringify({
		providers: { "fake-gpt": { name: "Fake GPT", baseUrl: `http://127.0.0.1:${gatewayPort}/v1`, api: "openai-completions", models: [{ id: "gpt-fake", name: "GPT Fake", input: ["text"], contextWindow: 128000, maxTokens: 16000 }] } },
	}, null, 2), { mode: 0o600 });
	fs.writeFileSync(path.join(agentDir, "auth.json"), JSON.stringify({ "fake-gpt": { type: "api_key", key: "synthetic-touch-hints" } }, null, 2), { mode: 0o600 });
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
	// One room per device, so each opens a fresh conversation of its own.
	const mouseRoomId = create("Mouse Room");
	const touchRoomId = create("Touch Room");
	// The consulted room remembered something two days ago, so the @ list has a
	// "remembered …" line to place under its long name.
	const consultedId = create(CONSULTED_ROOM);
	const consulted = agents.createPersistentAgentInstance(consultedId);
	const l1bPath = consulted.l1bCurrentPath(consulted.readAgentJson());
	const l1b = fs.readFileSync(l1bPath, "utf-8");
	const stamp = `- Last checkpoint at: ${new Date(Date.now() - 2 * 86_400_000).toISOString()}`;
	const stamped = /^- Last checkpoint at:.*$/m.test(l1b) ? l1b.replace(/^- Last checkpoint at:.*$/m, stamp) : l1b.replace(/^##[ \t]+Chronos[ \t]*$/m, (heading) => `${heading}\n\n${stamp}`);
	assert(stamped !== l1b, "the consulted room's memory takes a checkpoint stamp");
	fs.writeFileSync(l1bPath, stamped, "utf-8");

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
	const workspaceRoot = path.join(tempRoot, "workspace");
	fs.mkdirSync(workspaceRoot, { recursive: true });
	fs.writeFileSync(path.join(workspaceRoot, "notes.txt"), "notes\n");
	for (const roomId of [mouseRoomId, touchRoomId]) {
		const workspace = await authedFetch(`${baseUrl}/api/persistent-agents/${encodeURIComponent(roomId)}/workspace-default`, {
			method: "PUT",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ root: workspaceRoot, displayLabel: "Hint Workspace", workspaceAccessMode: "localFiles", bashEnabled: true }),
		});
		assert(workspace.status === 200, `full access with the terminal on, got ${workspace.status}`);
	}

	const browser = await chromium.launch();
	try {
		await checkDevice(browser, "touch screen", "Touch Room", { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true }, true);
		await checkDevice(browser, "mouse", "Mouse Room", { viewport: { width: 1280, height: 900 } }, false);
	} finally {
		await browser.close();
	}
	console.log("touch-hints-ui smoke: ok");
} catch (error) {
	console.error(serverOutput.join("").split("\n").filter((line) => !line.includes("token=")).join("\n").slice(-4000));
	throw error;
} finally {
	await stopSmokeServer(server);
	await new Promise<void>((resolve) => gateway.close(() => resolve()));
	fs.rmSync(tempRoot, { recursive: true, force: true });
}

async function checkDevice(browser: Browser, device: string, roomName: string, options: BrowserContextOptions, touch: boolean): Promise<void> {
	const ctx = await browser.newContext(options);
	try {
		const page = await ctx.newPage();
		await page.goto(`${baseUrl}/auth/session?token=${SMOKE_AUTH_TOKEN}`);
		await page.waitForLoadState("networkidle");
		assert(await page.evaluate(() => window.matchMedia("(hover: none)").matches) === touch, `the ${device} ${touch ? "has" : "has no"} (hover: none)`);
		const dismiss = page.locator(".whats-new-close");
		if (await dismiss.count()) await dismiss.click();
		const card = page.locator(".persistent-agent-card").filter({ hasText: roomName });
		await card.waitFor({ timeout: 20000 });
		await card.getByRole("button", { name: "Enter" }).click();
		const composer = page.locator(".composer textarea").first();
		await composer.waitFor({ timeout: 20000 });

		// The @ list: the memory line on every device, the keys only with a mouse.
		await composer.click();
		await composer.fill("@");
		const list = page.locator(".mention-pop");
		await list.waitFor({ timeout: 10000 });
		const foot = list.locator(".pop-foot");
		const footText = (await foot.innerText()).trim();
		assert(footText.includes(MEMORY_LINE), `the @ list says "${MEMORY_LINE}" on a ${device}, got "${footText}"`);
		assert(footText.includes(KEYS_HINT) === !touch, `the @ list ${touch ? "hides" : "shows"} "${KEYS_HINT}" on a ${device}, got "${footText}"`);
		console.log(`  ok  ${device}: the @ list ${touch ? "has no keys line" : "names its keys"} and says the memory is only read`);

		// Full names: the row shows the whole room name, never cut, and its
		// "remembered …" line sits under the name.
		const row = list.locator(".mention-row").filter({ hasText: CONSULTED_ROOM.slice(0, 12) });
		await row.waitFor({ timeout: 5000 });
		const name = row.locator(".m-name");
		const fresh = row.locator(".m-fresh");
		assert((await name.innerText()).trim() === CONSULTED_ROOM, `the row shows the full name on a ${device}, got "${await name.innerText()}"`);
		const cut = await name.evaluate((node) => node.scrollWidth > node.clientWidth + 1);
		assert(!cut, `the name is not cut short on a ${device}`);
		assert(/^remembered /.test((await fresh.innerText()).trim()), `the row says when the room last remembered, got "${await fresh.innerText()}"`);
		const nameBox = await name.boundingBox();
		const freshBox = await fresh.boundingBox();
		assert(nameBox && freshBox && freshBox.y >= nameBox.y + nameBox.height - 1, `"remembered …" sits under the name on a ${device}: name ${JSON.stringify(nameBox)}, line ${JSON.stringify(freshBox)}`);
		console.log(`  ok  ${device}: the @ list shows the full room name with "remembered …" under it`);
		await composer.fill("");
		await waitUntil(async () => (await list.count()) === 0, "the @ list closes once the @ is gone");

		// The command question: Allow and Deny show their keys only with a mouse.
		await composer.fill(ASK_FOR_COMMAND);
		await page.locator("button.send-btn").click();
		const deny = page.locator(".wk-ask .wk-btn").filter({ hasText: /^Deny/ });
		const allow = page.locator(".wk-ask .wk-btn.primary").filter({ hasText: /^Allow/ });
		await deny.waitFor({ timeout: 20000 });
		const keys = async (button: typeof deny) => (await button.locator("kbd").allInnerTexts()).map((key) => key.trim());
		if (touch) {
			const shown = [...(await keys(allow)), ...(await keys(deny))];
			assert(shown.length === 0, `the command question shows no keys on a ${device}, got ${JSON.stringify(shown)}`);
			// At phone width the question's card spans the column, as the message box does.
			const width = await page.locator(".wk-card").filter({ has: page.locator(".wk-ask") }).last().evaluate((card) => {
				const column = card.parentElement!;
				const style = getComputedStyle(column);
				return { card: card.getBoundingClientRect().width, column: column.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight) };
			});
			assert(width.card >= width.column - 1, `the command question's card spans the phone's column: ${JSON.stringify(width)}`);
		} else {
			await waitUntil(async () => (await keys(allow)).length > 0, "Allow shows its key", 3000);
			assert(["↵", "Enter"].includes((await keys(allow))[0]) && (await keys(deny)).includes("Esc"), `with a mouse Allow shows Enter and Deny shows Esc, got ${JSON.stringify({ allow: await keys(allow), deny: await keys(deny) })}`);
		}
		console.log(`  ok  ${device}: the command question ${touch ? "shows no keys" : "names its keys"}`);
		await deny.click();
		await page.locator("button.send-btn").waitFor({ timeout: 20000 });
	} finally {
		await ctx.close();
	}
}
