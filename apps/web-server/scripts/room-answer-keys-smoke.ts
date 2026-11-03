// The keys that answer the room's one waiting question, in the browser against
// a real spawned server and one synthetic Anthropic endpoint, once as a Mac
// and once as Windows:
//
// - Enter allows the waiting step from anywhere on the page and Esc denies it,
//   only while the message box is empty; Allow shows the Enter key (↵ on a Mac,
//   "Enter" on Windows) only where Enter works, not while another button has
//   the focus, and Deny shows Esc;
// - with another layer open (a menu), Esc closes that layer first and the
//   question stays;
// - Enter never sends, and never answers the question, while an input method
//   is composing;
// - on a touch screen no key hints show;
// - a command question shows its command and none of the facts the app wrote
//   (no Details, no "Runs in"); a specialist's keeps its facts behind Details,
//   apart from the brief the model wrote; and every question's answers sit
//   under everything else in it, at its right.
//
// Run: npm run smokes -- room-answer-keys   (or tsx this file)
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import { fileURLToPath } from "node:url";
import { chromium, type Page } from "playwright";
import { authedFetch, SMOKE_AUTH_TOKEN, SMOKE_SERVER_AUTH_ENV, SMOKE_SERVER_SPAWN_TREE_OPTIONS, smokeHomeEnv, stopSmokeServer, freePort } from "./smoke-server-process.js";

function assert(condition: unknown, message: string): asserts condition {
	if (!condition) throw new Error(message);
}

{
	const p = typeof chromium?.executablePath === "function" ? chromium.executablePath() : "";
	if (!p || !fs.existsSync(p)) {
		console.log("room answer keys smoke skipped (Chromium not installed)");
		process.exit(0);
	}
}

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const webServerDir = path.resolve(scriptDir, "..");
const repoRoot = path.resolve(webServerDir, "..", "..");
const port = await freePort();
const baseUrl = `http://127.0.0.1:${port}`;

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "exxperts-answer-keys-"));
const tempHome = path.join(tempRoot, "home");
const agentsRoot = path.join(tempHome, ".exxperts", "app", "personalized-agents");
const agentDir = path.join(tempHome, ".exxperts", "agent");
for (const dir of [agentsRoot, agentDir]) fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
process.env.HOME = tempHome;
process.env.USERPROFILE = tempHome;
process.env.EXXPERTS_CODING_AGENT_DIR = agentDir;
process.env.EXXETA_PERSISTENT_AGENTS_ROOT = agentsRoot;

const KEY_PROVIDER = "anthropic-api-key";
const ON_KEY = { provider: KEY_PROVIDER, model: "claude-sonnet-5-5" };
const ALLOWED = /^Allowed · /;
const NOT_DONE = /^Not done · you said no/;
// The line the server puts between the facts it wrote and the command the model wrote (persistent-room-bash-approval.ts).
const COMMAND_FENCE = "─── Command (written by the room's model; the app has not verified it) ───";
// A specialist's question as the room's delegate tool asks it: the app's facts, then the model's brief under its fence.
const SPECIALIST_BRIEF = "Chart the totals by month.";
const SPECIALIST_QUESTION = [
	"A separate specialist runs this task in isolation: no memory access, no web access, no shell.",
	"",
	"It can only write into one new folder made for this task: tasks/chart/ (at most 10 files). Approving starts it and grants that folder write access.",
	"",
	"─── Brief it will receive (written by the room's model; the app has not verified anything below this line) ───",
	SPECIALIST_BRIEF,
].join("\n");
const MAC = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36";
const WINDOWS = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36";
const PLATFORMS = [
	{ name: "Mac", userAgent: MAC, enter: "↵" },
	{ name: "Windows", userAgent: WINDOWS, enter: "Enter" },
] as const;

function sse(res: http.ServerResponse, event: string, payload: unknown): void {
	if (!res.destroyed) res.write(`event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`);
}

// A message with "slow" in it is answered in about 20 s, so a question can be handed the page meanwhile; any other at once.
const endpointState = { open: 0 };
const endpoint = http.createServer((req, res) => {
	let raw = "";
	req.on("data", (chunk) => { raw += chunk; });
	req.on("end", () => {
		const body = JSON.parse(raw || "{}");
		const user = [...(body.messages ?? [])].reverse().find((message: any) => message.role === "user");
		const asked = typeof user?.content === "string" ? user.content : Array.isArray(user?.content) ? user.content.map((part: any) => (typeof part?.text === "string" ? part.text : "")).join("\n") : "";
		const parts = /\bslow\b/.test(asked) ? 200 : 3;
		res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
		sse(res, "message_start", { type: "message_start", message: { id: `msg_keys_${Date.now()}`, type: "message", role: "assistant", model: body.model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 100, output_tokens: 1 } } });
		sse(res, "content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } });
		endpointState.open += 1;
		let index = 0;
		const timer = setInterval(() => {
			if (index < parts) {
				sse(res, "content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: `Word ${index + 1} of the answer. ` } });
				index += 1;
				return;
			}
			clearInterval(timer);
			sse(res, "content_block_stop", { type: "content_block_stop", index: 0 });
			sse(res, "message_delta", { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 40 } });
			sse(res, "message_stop", { type: "message_stop" });
			res.end();
		}, 100);
		res.on("close", () => {
			clearInterval(timer);
			endpointState.open -= 1;
		});
	});
});

// Where the waiting question's answers sit: under every other part of it (its title, the command's box, the facts, a text box), at the row's inner right edge.
const answersPlaced = (page: Page) => page.locator(".wk-ask").last().evaluate((row) => {
	const buttons = row.querySelector(".wk-ask-btns")!.getBoundingClientRect();
	const above = [...row.querySelectorAll(".wk-tx, .wk-ask-sub, .wk-ask-meta, .wk-ask-more, .wk-ask-facts, .wk-ask-input")].map((el) => el.getBoundingClientRect().bottom);
	const style = getComputedStyle(row);
	const inner = row.getBoundingClientRect().right - parseFloat(style.paddingRight) - parseFloat(style.borderRightWidth);
	return { below: above.length > 0 && buttons.top >= Math.max(...above) - 0.5, right: Math.abs(buttons.right - inner) <= 1 };
});
const placedWell = (placed: { below: boolean; right: boolean }) => placed.below && placed.right;

async function waitUntil(predicate: () => Promise<boolean> | boolean, label: string, timeoutMs = 20_000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (await predicate()) return;
		await new Promise((resolve) => setTimeout(resolve, 100));
	}
	throw new Error(`timed out waiting until ${label}`);
}

let server: ChildProcessWithoutNullStreams | undefined;
const serverOutput: string[] = [];
const failures: string[] = [];
const expect = (condition: unknown, message: string) => {
	if (!condition) failures.push(message);
	console.log(`${condition ? "  ok  " : "FAIL  "}${message}`);
};

try {
	await new Promise<void>((resolve) => endpoint.listen(0, "127.0.0.1", resolve));
	const endpointUrl = `http://127.0.0.1:${(endpoint.address() as AddressInfo).port}`;
	fs.writeFileSync(path.join(agentDir, "models.json"), JSON.stringify({ providers: { [KEY_PROVIDER]: { baseUrl: endpointUrl } } }, null, 2), { mode: 0o600 });
	fs.writeFileSync(path.join(agentDir, "auth.json"), JSON.stringify({ [KEY_PROVIDER]: { type: "api_key", key: "synthetic-anthropic-key" } }, null, 2), { mode: 0o600 });
	fs.writeFileSync(path.join(agentDir, "settings.json"), JSON.stringify({ retry: { baseDelayMs: 1000, provider: { maxRetries: 0 } } }, null, 2), { mode: 0o600 });
	const workspaceRoot = path.join(tempRoot, "workspace");
	fs.mkdirSync(workspaceRoot, { recursive: true, mode: 0o700 });
	const agents = await import("../src/persistent-agents.js");
	const agentId = agents.createPersistentAgentFromScaffoldInput({ displayName: "Keys Room", userName: "Synthetic User", preferredUserAddress: "Synthetic User" }).agent.agentId;
	server = spawn("npx", ["tsx", "src/index.ts"], {
		shell: process.platform === "win32",
		...SMOKE_SERVER_SPAWN_TREE_OPTIONS,
		cwd: webServerDir,
		env: smokeHomeEnv(tempHome, { PORT: String(port), ...SMOKE_SERVER_AUTH_ENV, EXXETA_HOME: repoRoot, EXXPERTS_CODING_AGENT_DIR: agentDir, EXXETA_PERSISTENT_AGENTS_ROOT: agentsRoot }) as NodeJS.ProcessEnv,
	});
	server.stdout.on("data", (chunk) => serverOutput.push(String(chunk)));
	server.stderr.on("data", (chunk) => serverOutput.push(String(chunk)));
	await waitUntil(() => fetch(`${baseUrl}/healthz`).then((r) => r.ok).catch(() => false), "server ready", 60_000);
	const approved = await authedFetch(`${baseUrl}/api/persistent-agent-ai-profiles/custom`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ providerId: KEY_PROVIDER, label: "Claude API key", roomModels: [ON_KEY.model], learnModel: ON_KEY.model }) });
	assert(approved.ok, `the key's model is approved, got ${approved.status}`);
	const picked = await authedFetch(`${baseUrl}/api/persistent-agents/${agentId}/models`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ conversation: ON_KEY }) });
	assert(picked.ok, `the room picks the key's model, got ${picked.status}`);
	// The room works in a folder of its own, as a room in use does.
	const workspace = await authedFetch(`${baseUrl}/api/persistent-agents/${agentId}/workspace-default`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ root: workspaceRoot, displayLabel: "Keys Workspace", workspaceAccessMode: "localFiles", bashEnabled: true }) });
	assert(workspace.ok, `the room's folder is set, got ${workspace.status}`);


	const browser = await chromium.launch();
	try {
		// Opens the page in a fresh context and enters the room; `send` hands the page a frame of its own on the room's socket.
		const openRoom = async (options: Parameters<typeof browser.newContext>[0]) => {
			const context = await browser.newContext(options);
			const page: Page = await context.newPage();
			let pageSocket: { send(message: string): void } | undefined;
			const socket = { readies: 0 };
			await page.routeWebSocket(/\/ws\?/, (ws) => {
				pageSocket = ws;
				const upstream = ws.connectToServer();
				ws.onMessage((message) => upstream.send(message));
				upstream.onMessage((message) => {
					if (String(message).includes('"type":"ready"')) socket.readies += 1;
					ws.send(message);
				});
				upstream.onClose((code, reason) => ws.close({ code, reason }));
				ws.onClose(() => upstream.close());
			});
			await page.goto(`${baseUrl}/auth/session?token=${SMOKE_AUTH_TOKEN}`);
			await page.waitForLoadState("networkidle");
			const dismiss = page.locator(".whats-new-close");
			if (await dismiss.count()) await dismiss.click();
			await page.locator(".persistent-agent-card").filter({ hasText: "Keys Room" }).getByRole("button", { name: /^(Enter|Resume)$/ }).click();
			await page.locator(".composer-box textarea").waitFor({ timeout: 15000 });
			await waitUntil(() => socket.readies > 0, "the room's connection is ready");
			const composer = page.locator(".composer-box textarea");
			const stopButton = page.locator(".composer-box .stop-btn");
			// Idle: no Stop, and the box no longer reads "Stopping current response…".
			const idle = async () => (await stopButton.count()) === 0 && (await composer.getAttribute("placeholder"))?.startsWith("Ask ") === true;
			const userBubbles = (text: string) => page.locator(".bubble.user").filter({ hasText: text }).count();
			const ask = async (text: string) => {
				await composer.fill(text);
				await composer.press("Enter");
				await waitUntil(async () => (await userBubbles(text)) > 0 && !(await idle()), `"${text}" is being answered`);
			};
			const answered = async () => {
				await waitUntil(async () => endpointState.open === 0 && (await idle()), "the room is idle", 40_000);
			};
			// Ends the slow answer a scene asked for, and waits until the room is idle again.
			const stop = async () => {
				if (await stopButton.count()) await stopButton.click().catch(() => {});
				await answered();
			};
			const send = (frame: unknown) => pageSocket?.send(JSON.stringify(frame));
			return { context, page, composer, stopButton, userBubbles, ask, answered, stop, send };
		};
		const question = (id: string) => ({ type: "ui_request", kind: "confirm", id, title: "Run this command?", message: `echo ${id}` });

		for (const platform of PLATFORMS) {
			const { context, page, composer, userBubbles, ask, answered, stop, send } = await openRoom({ viewport: { width: 1280, height: 900 }, userAgent: platform.userAgent });
			const allowedRows = () => page.locator(".wk-row").filter({ hasText: ALLOWED }).count();
			const deniedRows = () => page.locator(".wk-row").filter({ hasText: NOT_DONE }).count();
			const asks = page.locator(".wk-ask");
			const allow = page.locator(".wk-ask .wk-btn.primary").last();
			const deny = page.locator(".wk-ask .wk-btn:not(.primary)").last();
			const keyOn = async (button: typeof allow, key: string) => (await button.locator("kbd").allInnerTexts()).includes(key);
			const clickElsewhere = async () => {
				// A click on the conversation's empty space: the page's focus leaves the box for the page itself.
				await page.locator(".messages").click({ position: { x: 4, y: 4 } });
				return page.evaluate(() => !(document.activeElement instanceof HTMLButtonElement || document.activeElement instanceof HTMLTextAreaElement || document.activeElement instanceof HTMLInputElement));
			};
			// The question is on screen and its hints have settled.
			const waitingFor = async (id: string) => {
				send(question(id));
				await allow.waitFor({ timeout: 5000 });
				await waitUntil(async () => (await asks.count()) === 1, "one question waits", 3000);
			};
			const tag = `[${platform.name}]`;
			// A scene that fails says so and the next one still runs: the answer left running is stopped and the box emptied.
			const scene = async (name: string, run: () => Promise<void>) => {
				try {
					await run();
				} catch (error) {
					expect(false, `${tag} scene ${name}: ${(error as Error).message.split("\n")[0]}`);
				}
				await composer.fill("").catch(() => {});
				await stop().catch(() => {});
			};

			// A question waits and the person clicked somewhere else: Enter allows it from the page, Esc denies it.
			await scene("keys", async () => {
				await ask(`A slow answer with a question, please (${platform.name}).`);
				await waitingFor(`ask-1-${platform.name}`);
				expect((await page.locator(".wk-ask .wk-ask-more").count()) === 0, `${tag} a question with no facts of the app's has no Details`);
				expect(await clickElsewhere(), `${tag} a click on the conversation leaves the focus on the page`);
				expect(await keyOn(allow, platform.enter), `${tag} Allow shows ${platform.enter} with the focus on the page`);
				expect(await keyOn(deny, "Esc"), `${tag} Deny shows Esc`);
				const heights = await page.locator(".wk-ask .wk-btn").evaluateAll((buttons) => buttons.map((button) => Math.round(button.getBoundingClientRect().height)));
				expect(heights.length === 2 && heights.every((height) => height < 40), `${tag} with a mouse Deny and Allow keep their compact size (got ${JSON.stringify(heights)})`);
				const allowedBefore = await allowedRows();
				await page.keyboard.press("Enter");
				await waitUntil(async () => (await allowedRows()) > allowedBefore, "Enter answered the question", 3000).catch(() => {});
				expect((await allowedRows()) === allowedBefore + 1 && (await asks.count()) === 0, `${tag} Enter from the page allows the waiting question`);

				// Its neighbours: with Deny focused Enter is Deny's, so Allow shows no key; with text in the box Enter is the box's.
				await waitingFor(`ask-2-${platform.name}`);
				expect(await keyOn(allow, platform.enter), `${tag} the next question's Allow shows ${platform.enter} too`);
				await deny.focus();
				await waitUntil(async () => !(await keyOn(allow, platform.enter)), "Allow's key hint goes", 2000).catch(() => {});
				expect(!(await keyOn(allow, platform.enter)), `${tag} Allow shows no ${platform.enter} while Deny has the focus`);
				await composer.fill("a draft");
				await clickElsewhere();
				await waitUntil(async () => !(await keyOn(allow, platform.enter)) && !(await keyOn(deny, "Esc")), "the hints go with text in the box", 2000).catch(() => {});
				expect(!(await keyOn(allow, platform.enter)) && !(await keyOn(deny, "Esc")), `${tag} with text in the box, neither Allow nor Deny shows a key`);
				const allowedWithDraft = await allowedRows();
				await page.keyboard.press("Enter");
				await page.keyboard.press("Escape");
				// Neither key may answer it: a moment for the page to have acted on them.
				await page.waitForTimeout(300);
				expect((await allowedRows()) === allowedWithDraft && (await asks.count()) === 1, `${tag} Enter and Esc from the page leave the question alone while the box holds text`);
				await composer.fill("");
				await clickElsewhere();
				const deniedBefore = await deniedRows();
				await page.keyboard.press("Escape");
				await waitUntil(async () => (await asks.count()) === 0, "Esc answered the question", 3000).catch(() => {});
				expect((await asks.count()) === 0 && (await deniedRows()) === deniedBefore + 1, `${tag} Esc from the page denies the waiting question`);
			});

			// A command question as the server asks it, with the app's facts above the fence: it shows the command alone, with no Details, and
			// Deny and Allow under it at the right with their keys. A specialist's question keeps those facts behind Details; a typed answer's
			// Cancel and Submit sit under its box the same way.
			await scene("details", async () => {
				await ask(`A slow answer with questions and their details, please (${platform.name}).`);
				send({ type: "ui_request", kind: "confirm", id: `ask-details-${platform.name}`, title: "Run this command?", message: `Runs in: /work/keys\nYou can auto-approve bash for this room in Room settings, Folder.\n\n${COMMAND_FENCE}\necho details` });
				await allow.waitFor({ timeout: 5000 });
				const details = page.locator(".wk-ask button", { hasText: /^(Details|Hide details)$/ });
				const facts = page.locator(".wk-ask .wk-ask-facts");
				const command = (await page.locator(".wk-ask .wk-ask-sub").last().innerText().catch(() => "")).trim();
				const shown = await asks.last().innerText();
				expect((await details.count()) === 0 && (await facts.count()) === 0 && command === "echo details" && !shown.includes("Runs in") && !shown.includes("auto-approve"), `${tag} a command question shows its command, no Details and none of the app's facts (details ${await details.count()}, facts ${await facts.count()}, command ${JSON.stringify(command)}, shown ${JSON.stringify(shown)})`);
				await waitUntil(async () => (await keyOn(allow, platform.enter)) && (await keyOn(deny, "Esc")), "the keys show", 3000).catch(() => {});
				expect((await keyOn(allow, platform.enter)) && (await keyOn(deny, "Esc")), `${tag} the command question's Deny shows Esc and Allow ${platform.enter}`);
				const commandPlaced = await answersPlaced(page);
				expect(placedWell(commandPlaced), `${tag} the command question's Deny and Allow sit under its command, at its right (${JSON.stringify(commandPlaced)})`);
				// Allow shows its key: a press on Deny, beside it at the right, leaves the focus where it is, so Allow keeps its key and the click lands on Deny.
				const allowKeyed = await keyOn(allow, platform.enter);
				const deniedBefore = await deniedRows();
				await deny.click();
				await waitUntil(async () => (await asks.count()) === 0, "the command question is answered", 3000).catch(() => {});
				expect(allowKeyed && (await asks.count()) === 0 && (await deniedRows()) === deniedBefore + 1, `${tag} with Allow showing ${platform.enter}, a click on Deny denies the command question (key shown ${allowKeyed}, questions ${await asks.count()})`);

				send({ type: "ui_request", kind: "confirm", id: `ask-specialist-${platform.name}`, title: "Have a specialist create a chart?", message: SPECIALIST_QUESTION });
				await allow.waitFor({ timeout: 5000 });
				expect((await details.count()) === 1 && (await facts.count()) === 0, `${tag} a specialist's question offers Details, closed (details ${await details.count()}, facts ${await facts.count()})`);
				await details.first().click();
				await waitUntil(async () => (await facts.count()) === 1, "the facts show", 3000).catch(() => {});
				const said = (await facts.first().innerText().catch(() => "")).trim();
				expect(said.startsWith("A separate specialist runs this task in isolation") && !said.includes(SPECIALIST_BRIEF) && (await details.first().innerText()).trim() === "Hide details", `${tag} Details shows the app's facts, not the model's brief (got ${JSON.stringify(said)})`);
				const specialistPlaced = await answersPlaced(page);
				expect(placedWell(specialistPlaced), `${tag} with its Details open, the specialist's Deny and Allow sit under them, at its right (${JSON.stringify(specialistPlaced)})`);
				await deny.click();
				await waitUntil(async () => (await asks.count()) === 0, "the specialist's question is answered", 3000);

				send({ type: "ui_request", kind: "input", id: `ask-typed-${platform.name}`, title: "Edit the fact", placeholder: "The fact as it should read" });
				await page.locator(".wk-ask textarea").waitFor({ timeout: 5000 });
				const typedPlaced = await answersPlaced(page);
				const typedOrder = await page.locator(".wk-ask .wk-btn").allInnerTexts();
				expect(placedWell(typedPlaced) && typedOrder.join(" ") === "Cancel Submit", `${tag} a typed answer's Cancel and Submit sit under its box, at its right (${JSON.stringify({ ...typedPlaced, typedOrder })})`);
				await page.locator(".wk-ask .wk-btn", { hasText: /^Cancel$/ }).click();
				await waitUntil(async () => (await asks.count()) === 0, "the typed answer is cancelled", 3000);
			});

			// Another layer open over the room (a menu): Esc closes it first, and the question stays.
			await scene("layer", async () => {
				await ask(`A slow answer with a question under a menu, please (${platform.name}).`);
				await waitingFor(`ask-3-${platform.name}`);
				await page.locator(".sidebar-config-gear:visible").first().click();
				const menu = page.locator(".sidebar-config-menu");
				await menu.waitFor({ timeout: 3000 });
				await page.keyboard.press("Escape");
				await waitUntil(async () => (await menu.count()) === 0, "Esc closes the menu", 3000).catch(() => {});
				await page.waitForTimeout(300);
				expect((await menu.count()) === 0 && (await asks.count()) === 1, `${tag} with a menu open, Esc closes the menu and the question stays (menus ${await menu.count()}, questions ${await asks.count()})`);
				await clickElsewhere();
				await page.keyboard.press("Escape");
				await waitUntil(async () => (await asks.count()) === 0, "the next Esc denies", 3000).catch(() => {});
				expect((await asks.count()) === 0, `${tag} with the menu closed, the next Esc denies the question`);
			});

			// An input method composing: its Enter picks the word, so it never sends and never answers the question.
			await scene("composing", async () => {
				const composing = (target: string) => page.evaluate((selector) => {
					const el = selector ? document.querySelector(selector) : document.body;
					el?.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", code: "Enter", isComposing: true, bubbles: true, cancelable: true }));
				}, target);
				const draft = `Composed in pieces ${platform.name}`;
				await composer.fill(draft);
				await composing(".composer-box textarea");
				await page.waitForTimeout(300);
				expect((await userBubbles(draft)) === 0 && (await composer.inputValue()) === draft, `${tag} Enter while an input method composes does not send`);
				await composer.press("Enter");
				await waitUntil(async () => (await userBubbles(draft)) === 1, "a plain Enter sends", 5000).catch(() => {});
				expect((await userBubbles(draft)) === 1, `${tag} a plain Enter then sends the message`);
				await answered();

				await ask(`A slow answer with a question while composing, please (${platform.name}).`);
				await waitingFor(`ask-4-${platform.name}`);
				await clickElsewhere();
				const allowedBefore = await allowedRows();
				await composing("");
				await page.waitForTimeout(300);
				expect((await asks.count()) === 1 && (await allowedRows()) === allowedBefore, `${tag} Enter while an input method composes leaves the waiting question alone`);
				await page.keyboard.press("Enter");
				await waitUntil(async () => (await asks.count()) === 0, "a plain Enter answers", 3000).catch(() => {});
				expect((await allowedRows()) === allowedBefore + 1, `${tag} a plain Enter then allows it`);
			});
			await context.close();
		}

		// On a touch screen, at a phone's width: a waiting question shows no key hints.
		{
			const { context, page, ask, stop, send } = await openRoom({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true, userAgent: MAC });
			await ask("A slow answer with a question on a phone, please.");
			send(question("ask-touch"));
			await page.locator(".wk-ask .wk-btn.primary").waitFor({ timeout: 5000 });
			const hints = await page.locator(".wk-ask kbd").count();
			expect(hints === 0, `[touch] a waiting question shows no key hints (${hints} shown)`);
			// A finger's size: on a touch screen each answer is at least 40 px tall.
			const heights = await page.locator(".wk-ask .wk-btn").evaluateAll((buttons) => buttons.map((button) => Math.round(button.getBoundingClientRect().height)));
			expect(heights.length === 2 && heights.every((height) => height >= 40), `[touch] Deny and Allow are at least 40 px tall (got ${JSON.stringify(heights)})`);
			const placed = await answersPlaced(page);
			expect(placedWell(placed), `[touch] Deny and Allow sit under the question, at its right (${JSON.stringify(placed)})`);
			await page.locator(".wk-ask .wk-btn.primary").tap();
			await stop();
			await context.close();
		}
		assert(failures.length === 0, `the room's keys:\n  ${failures.join("\n  ")}`);
	} finally {
		await browser.close();
	}
	console.log("room-answer-keys smoke: ok");
} catch (error) {
	console.error(serverOutput.join("").slice(-4000));
	throw error;
} finally {
	try { (endpoint as any).closeAllConnections?.(); } catch {}
	try { endpoint.close(); } catch {}
	await stopSmokeServer(server);
	fs.rmSync(tempRoot, { recursive: true, force: true });
}
