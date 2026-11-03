// Messages sent while a room answers, in the browser against a real spawned
// server, as a Mac (⌘↵ is the chord):
//
// - Enter while the room writes queues the message: a filled bubble under
//   the answer with Edit, Copy and Remove beside it, "Queued" and Send now
//   under it, the answer goes on, and the bubble becomes the conversation's
//   own message once the room takes it; the chord's keys show beside Send now
//   on the first message queued for the answer only, and hide while the box
//   has text; Edit and Remove take a message back out of the running answer,
//   never reaching the model, and the others still go in, in order; one the
//   runtime already started goes as sent;
// - ⌘↵ stops the answer at the words on screen and sends the message, the
//   answer saying "Stopped here for your message."; Send now under a queued
//   bubble sends every queued message now, as one; ⌘↵ in an empty box during
//   a step sends the queued ones now;
// - the button is Stop with an empty box and Send once text is typed; Stop
//   and Esc put every queued message back into the box, in order, above what
//   is typed there;
// - the answer after a Stop can be stopped from its start, with Stop and with
//   Esc, though the page's last read of the room still says it is stopping;
// - a step that asked before the person typed is denied by their message, and
//   its card says so first; one that asked while they typed is not;
// - "@Room question" typed while the room answers waits, and goes to that room
//   once the answer ends;
// - a window reloaded into a running answer takes no message until the replay
//   of that answer is in: Send, Send now and ⌘↵ wait, then Enter queues,
//   never a new message, and the answer is never cut;
// - queued messages no answer took when the server stopped wait as held
//   messages: after the restart, a reload and a second window show them with
//   Edit, Copy, Remove and Send now (not on Windows, where a stop is a kill); the
//   cut answer's line leaves out "Send your message again if something is
//   missing." on the page while they wait under it, and once one is sent or a
//   message typed after the restart follows it; it keeps it in the saved
//   thread, and shows it while the line is the conversation's last;
// - the box's hint says what Enter does in each state, and never "Working".
//
// Offline: the model is a synthetic gateway on this machine that answers each
// call with the next leg of the scene; a held leg writes its lead, then waits
// until the scene lets it go.
// Run: npm run smokes -- room-send-edges   (or tsx this file)
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, type Page } from "playwright";
import { authedFetch, SMOKE_AUTH_TOKEN, SMOKE_SERVER_AUTH_ENV, SMOKE_SERVER_SPAWN_TREE_OPTIONS, smokeHomeEnv, stopSmokeServer, freePort, waitForServer } from "./smoke-server-process.js";
import { waitEvery } from "./smoke-wait.js";
import { closeBrowser } from "./smoke-close-context.js";
import { STOP_CUT_ANSWER_SENTENCE } from "../src/turn-ended-by.js";

function assert(condition: unknown, message: string): asserts condition {
	if (!condition) throw new Error(message);
}

{
	const p = typeof chromium?.executablePath === "function" ? chromium.executablePath() : "";
	if (!p || !fs.existsSync(p)) {
		console.log("room send edges smoke skipped (Chromium not installed)");
		process.exit(0);
	}
}

const waitUntil = waitEvery(100, 20_000);
const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const webServerDir = path.resolve(scriptDir, "..");
const repoRoot = path.resolve(webServerDir, "..", "..");
const port = await freePort();
const baseUrl = `http://127.0.0.1:${port}`;

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "exxperts-send-edges-"));
const tempHome = path.join(tempRoot, "home");
const agentsRoot = path.join(tempHome, ".exxperts", "app", "personalized-agents");
const agentDir = path.join(tempHome, ".exxperts", "agent");
const appDir = path.join(tempHome, ".exxperts", "app");
const workspaceRoot = path.join(tempRoot, "workspace");
for (const dir of [agentsRoot, agentDir, workspaceRoot]) fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
process.env.HOME = tempHome;
process.env.USERPROFILE = tempHome;
process.env.EXXPERTS_CODING_AGENT_DIR = agentDir;
process.env.EXXETA_PERSISTENT_AGENTS_ROOT = agentsRoot;

const MAC = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36";
const ROOM = "Edge Room";
const STOPPED_FOR_NEXT = "Stopped here for your message.";
// The server stop's line under a cut answer: its first sentence, and the one the page leaves out above held messages.
const STOP_CUT_FIRST = "exxperts stopped before this answer finished.";
const SEND_AGAIN = "Send your message again if something is missing.";
const DENIES_LINE = "Sending your message denies this step.";
const HINTS = {
	idle: `Ask ${ROOM}…`,
	answering: "Queue a message, ⌘↵ sends now",
	stepAsks: "Sending a message denies the step above",
	disconnected: /^(Waiting for the connection…|Not connected, press Reconnect)$/,
};

// The gateway: each model call takes the next leg, a tool call or text. A
// held leg writes its lead, then waits until the scene lets it go.
interface Leg { tool?: { name: string; args: Record<string, unknown> }; text?: string; lead?: string; held?: boolean }
let legs: Leg[] = [];
let release = () => {};
let held: Promise<void> = Promise.resolve();
const holdNextLeg = () => { held = new Promise<void>((resolve) => { release = resolve; }); };
// Every model call: its user messages and its tool results, in order.
const calls: { userTexts: string[]; toolTexts: string[] }[] = [];
const textOf = (content: unknown): string => typeof content === "string" ? content : Array.isArray(content) ? content.map((part: any) => (typeof part?.text === "string" ? part.text : "")).join("") : "";
const sseChunk = (payload: unknown): string => `data: ${JSON.stringify(payload)}\n\n`;
const gateway = http.createServer((req, res) => {
	if (req.method !== "POST" || !String(req.url ?? "").endsWith("/chat/completions")) { res.writeHead(404).end(); return; }
	let body = "";
	req.on("data", (chunk) => { body += chunk; });
	req.on("end", async () => {
		let parsed: any = {};
		try { parsed = JSON.parse(body); } catch {}
		const messages: any[] = Array.isArray(parsed?.messages) ? parsed.messages : [];
		calls.push({ userTexts: messages.filter((m) => m?.role === "user").map((m) => textOf(m.content)), toolTexts: messages.filter((m) => m?.role === "tool").map((m) => textOf(m.content)) });
		const leg = legs.shift() ?? { text: "Done." };
		res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
		const base = { id: `cmpl_${calls.length}`, object: "chat.completion.chunk", created: Math.floor(Date.now() / 1000), model: String(parsed?.model ?? "room-model") };
		if (leg.held) {
			res.write(sseChunk({ ...base, choices: [{ index: 0, delta: { role: "assistant", content: leg.lead ?? "" }, finish_reason: null }] }));
			await held;
			if (res.destroyed || res.writableEnded) return;
		}
		if (leg.tool) {
			if (!leg.held && leg.lead) res.write(sseChunk({ ...base, choices: [{ index: 0, delta: { role: "assistant", content: leg.lead }, finish_reason: null }] }));
			res.write(sseChunk({ ...base, choices: [{ index: 0, delta: { role: "assistant", tool_calls: [{ index: 0, id: `call_${calls.length}`, type: "function", function: { name: leg.tool.name, arguments: "" } }] }, finish_reason: null }] }));
			res.write(sseChunk({ ...base, choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: JSON.stringify(leg.tool.args) } }] }, finish_reason: null }] }));
			res.write(sseChunk({ ...base, choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }], usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 } }));
		} else {
			res.write(sseChunk({ ...base, choices: [{ index: 0, delta: { role: "assistant", content: leg.text ?? "Done." }, finish_reason: null }] }));
			res.write(sseChunk({ ...base, choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 150, completion_tokens: 12, total_tokens: 162 } }));
		}
		res.write("data: [DONE]\n\n");
		res.end();
	});
});

let server: ChildProcessWithoutNullStreams | undefined;
const serverOutput: string[] = [];
let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
const failed: string[] = [];

try {
	const gatewayPort = await freePort();
	await new Promise<void>((resolve) => gateway.listen(gatewayPort, "127.0.0.1", resolve));
	fs.writeFileSync(path.join(agentDir, "models.json"), JSON.stringify({
		providers: { "fake-gpt": { name: "Fake GPT", baseUrl: `http://127.0.0.1:${gatewayPort}/v1`, api: "openai-completions", models: [{ id: "gpt-fake", name: "GPT Fake", input: ["text"], contextWindow: 128000, maxTokens: 16000 }] } },
	}, null, 2), { mode: 0o600 });
	fs.writeFileSync(path.join(agentDir, "auth.json"), JSON.stringify({ "fake-gpt": { type: "api_key", key: "synthetic-send-edges" } }, null, 2), { mode: 0o600 });
	fs.writeFileSync(path.join(appDir, "custom-ai-profiles.json"), JSON.stringify({ version: 1, profiles: [
		{ id: "custom-fake-gpt", providerId: "fake-gpt", label: "Fake GPT", roomModels: ["gpt-fake"], learnModel: "gpt-fake", reviewMemoryModel: "gpt-fake" },
	] }, null, 2), { mode: 0o600 });
	fs.writeFileSync(path.join(appDir, "persistent-agent-ai-profile.json"), JSON.stringify({ profileId: "custom-fake-gpt" }, null, 2), { mode: 0o600 });
	const agents = await import("../src/persistent-agents.js");
	const roomModels = await import("../src/room-models.js");
	const { createPersistentAgentInstance } = await import("../src/persistent-agent-store.js");
	const create = (displayName: string) => {
		const agentId = agents.createPersistentAgentFromScaffoldInput({ displayName, userName: "Synthetic User", preferredUserAddress: "Synthetic User" }).agent.agentId;
		roomModels.writeRoomModels(agentId, { conversation: { provider: "fake-gpt", model: "gpt-fake" } });
		return agentId;
	};
	const roomId = create(ROOM);
	const otherId = create("Other Room");

	const startServer = async () => {
		server = spawn("npx", ["tsx", "src/index.ts"], {
			shell: process.platform === "win32",
			...SMOKE_SERVER_SPAWN_TREE_OPTIONS,
			cwd: webServerDir,
			env: smokeHomeEnv(tempHome, { PORT: String(port), ...SMOKE_SERVER_AUTH_ENV, EXXETA_HOME: repoRoot, EXXPERTS_CODING_AGENT_DIR: agentDir, EXXETA_PERSISTENT_AGENTS_ROOT: agentsRoot }) as NodeJS.ProcessEnv,
		});
		server.stdout.on("data", (chunk) => serverOutput.push(String(chunk)));
		server.stderr.on("data", (chunk) => serverOutput.push(String(chunk)));
		await waitForServer(server, baseUrl, 60_000);
	};
	await startServer();
	// Full access with the terminal on, so a command asks before it runs.
	const workspace = await authedFetch(`${baseUrl}/api/persistent-agents/${encodeURIComponent(roomId)}/workspace-default`, {
		method: "PUT",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ root: workspaceRoot, displayLabel: "Edge Workspace", workspaceAccessMode: "localFiles", bashEnabled: true }),
	});
	assert(workspace.ok, `the room's folder is set, got ${workspace.status}`);

	browser = await chromium.launch();
	const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 }, userAgent: MAC });
	// Every frame each page's room socket carries, both ways, passed through untouched;
	// while frames are held, a socket's frames from the named one on wait until they are let go.
	const frames: { out: boolean; frame: any }[] = [];
	let catchUpHeld: { from: string; frames: (() => void)[] } | null = null;
	const holdCatchUp = (from: "ready" | "turn_reattach" | "steer_taken" | "steer_withdrawn") => { catchUpHeld = { from, frames: [] }; };
	const letCatchUpGo = () => { const held = catchUpHeld?.frames ?? []; catchUpHeld = null; for (const deliver of held) deliver(); };
	// Each room socket, newest last, so a case can cut the link as a dropped connection does.
	const links: { close: () => void }[] = [];
	await ctx.routeWebSocket(/\/ws\?/, (ws) => {
		const upstream = ws.connectToServer();
		links.push({ close: () => { void ws.close().catch(() => {}); void upstream.close().catch(() => {}); } });
		let holding = false;
		const note = (out: boolean, message: string | Buffer): any => { try { const frame = JSON.parse(String(message)); frames.push({ out, frame }); return frame; } catch { return null; } };
		ws.onMessage((message) => { note(true, message); upstream.send(message); });
		upstream.onMessage((message) => {
			const type = note(false, message)?.type;
			if (catchUpHeld && type === catchUpHeld.from) holding = true;
			if (holding && catchUpHeld) catchUpHeld.frames.push(() => ws.send(message));
			else { holding = false; ws.send(message); }
		});
	});
	const enterRoom = async (page: Page) => {
		await page.goto(`${baseUrl}/auth/session?token=${SMOKE_AUTH_TOKEN}`);
		await page.waitForLoadState("networkidle");
		const dismiss = page.locator(".whats-new-close");
		if (await dismiss.count()) await dismiss.click();
		await page.locator(".persistent-agent-card").filter({ hasText: ROOM }).getByRole("button", { name: /^(Enter|Resume)$/ }).click();
		await page.locator("textarea").first().waitFor({ timeout: 15_000 });
	};
	const page = await ctx.newPage();
	await enterRoom(page);

	const composer = page.locator("textarea").first();
	const stopButton = page.locator(".composer-box .stop-btn");
	const sendButton = page.locator('.composer-box button.send-btn[aria-label="Send"]');
	const queued = (p: Page = page) => p.locator(".bubble-row.user.queued");
	const queuedTexts = async (p: Page = page) => (await queued(p).locator(".bubble.user").allInnerTexts()).map((text) => text.trim());
	const taken = (text: string) => page.locator(".bubble-row.user:not(.queued)", { hasText: text });
	// What one queued bubble offers: its icons by name, its caption's word, Send now, and whether the chord's keys show.
	const offers = async (bubble: ReturnType<Page["locator"]>) => {
		const tools = await bubble.locator(".queued-tools button").evaluateAll((buttons) => buttons.map((button) => button.getAttribute("aria-label") ?? ""));
		const word = (await bubble.locator(".bubble-queued-word").allInnerTexts()).join("|");
		const send = (await bubble.locator(".bubble-queued-action").count()) === 1;
		const keys = (await bubble.locator(".queued-keys kbd").allInnerTexts()).join("");
		return { tools: tools.join("|"), word, send, keys };
	};
	// Edit or Remove on a queued bubble, as a mouse reaches them: they show while the pointer is over its row,
	// so the pointer goes there again if the row moved from under it before the click.
	const useTool = (bubble: ReturnType<Page["locator"]>, name: "Edit" | "Remove") => waitUntil(async () => {
		await bubble.hover();
		return bubble.getByRole("button", { name }).click({ timeout: 1_000 }).then(() => true, () => false);
	}, `${name} on the queued message`);
	// Every queued bubble offers these; a held one never shows the keys.
	const ALL_TOOLS = "Edit|Copy message|Remove";
	const KEYS = "\u2318\u21b5";
	// Waits until the bubble offers what is expected: the keys follow the box a render after it changes.
	const offered = async (bubble: ReturnType<Page["locator"]>, expected: { tools: string; keys: string }, label: string) => {
		const want = JSON.stringify({ tools: expected.tools, word: "Queued", send: true, keys: expected.keys });
		let got = "";
		try {
			await waitUntil(async () => (got = JSON.stringify(await offers(bubble))) === want, label);
		} catch {
			const all = await queued().evaluateAll((rows) => rows.map((row) => `${row.hasAttribute("data-held") ? "held " : ""}${row.querySelector(".bubble")?.textContent?.trim()}`));
			throw new Error(`${label}: expected ${want}, got ${got}; queued: ${JSON.stringify(all)}`);
		}
	};
	const shown = async (text: string) => (await page.getByText(text, { exact: false }).count()) > 0;
	// Every hint the box showed, so none says "Working".
	const hintsSeen = new Set<string>();
	const hint = async (p: Page = page) => {
		const words = (await p.locator("textarea").first().getAttribute("placeholder")) ?? "";
		hintsSeen.add(words);
		return words;
	};
	const hintIs = (expected: string | RegExp, label: string, p: Page = page) => waitUntil(async () => {
		const words = await hint(p);
		return typeof expected === "string" ? words === expected : expected.test(words);
	}, `${label}: the box's hint is ${expected}, got ${JSON.stringify([...hintsSeen].at(-1))}`);
	const roomIdle = () => waitUntil(async () => {
		const status = await (await authedFetch(`${baseUrl}/api/persistent-agents/${roomId}/status`)).json().catch(() => null);
		return status?.activeThread?.inFlight === false && (await stopButton.count()) === 0;
	}, "the room is idle");
	const send = async (text: string) => {
		const before = calls.length;
		await composer.fill(text);
		await waitUntil(() => sendButton.isEnabled(), "Send is enabled with the message typed");
		await composer.press("Enter");
		await waitUntil(() => calls.slice(before).some((call) => call.userTexts.some((typed) => typed.includes(text))), `"${text}" reached the model`);
	};
	// Queues the typed message with Enter, once Send takes it, and waits until the server said where it waits.
	const queue = async (text: string) => {
		const count = await queued().count();
		await composer.fill(text);
		await waitUntil(() => sendButton.isEnabled(), `Send takes "${text}"`);
		await composer.press("Enter");
		await waitUntil(async () => (await queued().count()) === count + 1 && (await composer.inputValue()) === "", `"${text}" is queued and the box is empty`);
		const sent = frames.find(({ out, frame }) => out && frame.type === "steer" && frame.text === text);
		assert(sent, `"${text}" went to the server as a message for the running answer`);
		await waitUntil(() => frames.some(({ out, frame }) => !out && frame.type === "steer_waiting" && frame.id === sent.frame.id), `the server says "${text}" waits`);
	};
	const lastUserText = () => calls.at(-1)?.userTexts.at(-1) ?? "";
	// The server stop's line under a cut answer: the page leaves out its "send again" once a message of the person follows it, sent or waiting.
	const stopLineShown = async (p: Page, label: string) => {
		const transcript = async () => (await p.locator(".messages").innerText()).replace(/\s+/g, " ");
		await waitUntil(async () => (await transcript()).includes(STOP_CUT_FIRST), `${label}: the cut answer's line shows`);
		const words = await transcript();
		assert(!words.includes(SEND_AGAIN), `${label}: with a message under it, the line leaves out "${SEND_AGAIN}", got ${JSON.stringify(words.slice(-400))}`);
	};
	// The thread file as written, not through the reader.
	const threadItems = async (): Promise<any[]> => {
		const status = await (await authedFetch(`${baseUrl}/api/persistent-agents/${roomId}/status`)).json().catch(() => null);
		const threadFile = createPersistentAgentInstance(roomId).runtimeThreadPath(String(status?.activeThread?.threadId ?? ""));
		return JSON.parse(fs.readFileSync(threadFile, "utf8"))?.items ?? [];
	};
	const savedLines = async () => {
		const items = await threadItems();
		const ending = (line: string) => items.filter((item) => item?.text === line || String(item?.text ?? "").trimEnd().endsWith(`_${line}_`)).length;
		return { whole: ending(STOP_CUT_ANSWER_SENTENCE), short: ending(STOP_CUT_FIRST) };
	};
	const savedWhole = async (label: string) => {
		const saved = await savedLines();
		assert(saved.whole > 0 && saved.short === 0, `${label}: the saved thread keeps the whole line, never the page's shorter one, got ${JSON.stringify(saved)}`);
	};
	// The first model call whose newest user message carries these words.
	const callReading = (text: string) => calls.findIndex((call) => (call.userTexts.at(-1) ?? "").includes(text));
	const askCard = page.locator(".wk-ask");
	const allow = askCard.locator(".wk-btn.primary");

	const scene = async (name: string, run: () => Promise<void>) => {
		try {
			await run();
			console.log(`ok ${name}`);
		} catch (error) {
			failed.push(`${name}: ${(error as Error).message}`);
			console.log(`FAIL ${name}: ${(error as Error).message}`);
			letCatchUpGo();
			release();
			if (await stopButton.count()) await stopButton.click().catch(() => {});
			// A consult card a failed case left docked would refuse the next case's @mention.
			for (const dismiss of await page.locator(".consult-card").getByRole("button", { name: "Dismiss" }).all()) await dismiss.click().catch(() => {});
		}
		release();
		await roomIdle().catch(() => {});
		await composer.fill("").catch(() => {});
	};

	await scene("idle: the box asks the room, Send shows, no Stop", async () => {
		await hintIs(HINTS.idle, "idle");
		assert((await stopButton.count()) === 0 && (await sendButton.count()) === 1, "an idle room shows Send, no Stop");
	});

	await scene("Enter while the room writes queues the message; the answer goes on and the room takes it after", async () => {
		legs = [{ held: true, lead: "Writing the first part", text: " and the rest." }, { text: "Then the second part." }];
		holdNextLeg();
		await send("Tell me in two parts.");
		await waitUntil(() => shown("Writing the first part"), "the answer is being written");
		await hintIs(HINTS.answering, "while it writes");
		assert((await stopButton.count()) === 1 && (await sendButton.count()) === 0, "with an empty box the button is Stop");
		await composer.fill("Also the second part.");
		await waitUntil(async () => (await stopButton.count()) === 0 && (await sendButton.count()) === 1, "with text typed the button is Send");
		await queue("Also the second part.");
		assert((await stopButton.count()) === 1, "the box empty again, the button is Stop");
		await offered(queued(), { tools: ALL_TOOLS, keys: KEYS }, "a message waiting for the answer");
		// With text in the box, the chord sends that text: the keys go, Send now stays.
		await composer.fill("Still typing");
		await offered(queued(), { tools: ALL_TOOLS, keys: "" }, "with text in the box the keys hide");
		await composer.fill("  ");
		await offered(queued(), { tools: ALL_TOOLS, keys: KEYS }, "with only spaces in the box the chord still sends the queued one: the keys show");
		await composer.fill("");
		await offered(queued(), { tools: ALL_TOOLS, keys: KEYS }, "the box empty again, the keys are back");
		assert(!(await shown(STOPPED_FOR_NEXT)), "Enter does not stop the answer");
		release();
		await waitUntil(async () => (await taken("Also the second part.").count()) === 1 && (await queued().count()) === 0, "the room took the message: its bubble is the conversation's");
		await waitUntil(() => shown("Then the second part."), "the room answers it");
		assert(await shown("Writing the first part and the rest."), "the first answer ran to its end");
		assert(lastUserText() === "Also the second part.", `the model read the message as written, got ${JSON.stringify(lastUserText())}`);
		const order = await page.evaluate(() => {
			const answer = [...document.querySelectorAll(".bubble-row:not(.user)")].find((row) => row.textContent?.includes("and the rest."));
			const message = [...document.querySelectorAll(".bubble-row.user")].find((row) => row.textContent?.includes("Also the second part."));
			return !!answer && !!message && (answer.compareDocumentPosition(message) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0;
		});
		assert(order, "the message sits under the answer it went in after");
		assert(!(await shown(STOPPED_FOR_NEXT)), "nothing was stopped");
	});

	await scene("Edit and Remove take a message back out of the running answer: the model never reads it, the others go in, in order", async () => {
		legs = [{ held: true, lead: "An answer with four queued", text: " and its end." }, { text: "Handled what stayed." }];
		holdNextLeg();
		await send("Start an answer for four queued.");
		await waitUntil(() => shown("An answer with four queued"), "the answer is being written");
		await queue("Take this back.");
		await queue("Keep this one.");
		await queue("Edit this one.");
		await queue("Keep this too.");
		const removed = queued().filter({ hasText: "Take this back." });
		await useTool(removed, "Remove");
		await waitUntil(async () => (await queuedTexts()).join("|") === "Keep this one.|Edit this one.|Keep this too.", "Remove takes it off");
		await offered(queued().first(), { tools: ALL_TOOLS, keys: KEYS }, "the keys move to the next one the chord sends");
		const edited = queued().filter({ hasText: "Edit this one." });
		await useTool(edited, "Edit");
		await waitUntil(async () => (await composer.inputValue()) === "Edit this one." && (await queuedTexts()).join("|") === "Keep this one.|Keep this too.", "Edit puts it in the box");
		await composer.fill("");
		release();
		await waitUntil(async () => (await taken("Keep this one.").count()) === 1 && (await taken("Keep this too.").count()) === 1 && (await queued().count()) === 0 && (await shown("Handled what stayed.")), "the ones kept went in and are answered");
		const read = calls.flatMap((call) => call.userTexts);
		assert(!read.some((text) => text.includes("Take this back.") || text.includes("Edit this one.")), `the model never read the ones taken back, got ${JSON.stringify(read.slice(-4))}`);
		const reading = calls.find((call) => call.userTexts.some((text) => text.includes("Keep this too.")))?.userTexts ?? [];
		const first = reading.findIndex((text) => text.includes("Keep this one."));
		const second = reading.findIndex((text) => text.includes("Keep this too."));
		assert(first >= 0 && second > first, `the ones kept went in in the order sent, got ${JSON.stringify(reading.slice(-3))}`);
	});

	await scene("Remove on a message the runtime already started: it goes as sent and shows as the conversation's own", async () => {
		legs = [{ held: true, lead: "An answer that takes one in", text: "." }, { held: true, lead: "Answering what it took" }];
		holdNextLeg();
		await send("Start an answer that takes one in.");
		await waitUntil(() => shown("An answer that takes one in"), "the answer is being written");
		await queue("Started already.");
		const id = frames.find(({ out, frame }) => out && frame.type === "steer" && frame.text === "Started already.")!.frame.id;
		// The page hears of the runtime taking it in only once the case lets it.
		holdCatchUp("steer_taken");
		release();
		holdNextLeg();
		await waitUntil(() => calls.some((call) => call.userTexts.some((text) => text.includes("Started already."))), "the runtime started it: the model reads it");
		const bubble = queued().filter({ hasText: "Started already." });
		await useTool(bubble, "Remove");
		await waitUntil(() => frames.some(({ out, frame }) => !out && frame.type === "steer_withdraw_refused" && frame.id === id), "the server says it is in already");
		assert(!frames.some(({ out, frame }) => !out && frame.type === "steer_withdrawn" && frame.id === id), "the server did not say it came out");
		assert((await bubble.count()) === 1, "until the page hears the room took it, the bubble stays");
		letCatchUpGo();
		await waitUntil(async () => (await taken("Started already.").count()) === 1 && (await queued().count()) === 0, "it is the conversation's own message, nothing stays queued");
		release();
		await roomIdle();
		assert((await taken("Started already.").count()) === 1, "it stays the conversation's message once the answer ends");
	});

	await scene("Edit on two messages the running answer holds, the link dropping before the server's answers: both texts are back in the box, in order, once the window reconnects", async () => {
		legs = [{ held: true, lead: "An answer across a dropped link", text: "." }, { text: "Handled the one that stayed." }];
		holdNextLeg();
		await send("Start an answer across a dropped link.");
		await waitUntil(() => shown("An answer across a dropped link"), "the answer is being written");
		await queue("Edit across the drop.");
		await queue("Stays across the drop.");
		await queue("Edit this too across the drop.");
		const idOf = (text: string) => frames.find(({ out, frame }) => out && frame.type === "steer" && frame.text === text)!.frame.id;
		// The server's answers to the Edits never reach this link.
		holdCatchUp("steer_withdrawn");
		for (const text of ["Edit this too across the drop.", "Edit across the drop."]) {
			await useTool(queued().filter({ hasText: text }), "Edit");
			await waitUntil(() => frames.some(({ out, frame }) => !out && frame.type === "steer_withdrawn" && frame.id === idOf(text)), `the server took "${text}" out of the answer`);
		}
		const from = frames.length;
		catchUpHeld = null;
		links.at(-1)!.close();
		await waitUntil(() => frames.slice(from).some(({ out, frame }) => !out && frame.type === "ready"), "the window reconnects");
		await waitUntil(async () => (await composer.inputValue()) === "Edit across the drop.\n\nEdit this too across the drop." && (await queuedTexts()).join("|") === "Stays across the drop.", "both edited texts are back in the box in the order sent, the other still queued");
		await composer.fill("");
		release();
		await waitUntil(async () => (await taken("Stays across the drop.").count()) === 1 && (await shown("Handled the one that stayed.")), "the one that stayed went in and is answered");
		assert(!calls.some((call) => call.userTexts.some((text) => text.includes("Edit across the drop.") || text.includes("Edit this too across the drop."))), "the model never read the edited ones");
	});

	await scene("⌘↵ stops the answer at the words on screen and sends the message", async () => {
		legs = [{ held: true, lead: "A long answer begins" }, { text: "Answer after the cut." }];
		holdNextLeg();
		await send("Write a long answer.");
		await waitUntil(() => shown("A long answer begins"), "the answer is being written");
		await composer.fill("Do this instead.");
		await composer.press("Meta+Enter");
		await waitUntil(() => shown(STOPPED_FOR_NEXT), `the cut answer says "${STOPPED_FOR_NEXT}"`);
		await waitUntil(async () => (await taken("Do this instead.").count()) === 1 && (await shown("Answer after the cut.")), "the message went as the next one and is answered");
		assert((await queued().count()) === 0, "nothing stays queued");
		assert(lastUserText().includes("Do this instead.") && lastUserText().includes("[ANSWER CUT OFF]"), `the model reads the message with the cut's note, got ${JSON.stringify(lastUserText())}`);
		assert(!(await shown("You stopped this answer.")), "the cut answer does not say the person pressed Stop");
	});

	await scene("⌘↵ with a message queued sends the typed one alone; the queued one goes in after", async () => {
		legs = [{ held: true, lead: "A long answer with one queued" }, { text: "Typed one handled." }, { text: "Queued one handled." }];
		holdNextLeg();
		await send("Write another long answer.");
		await waitUntil(() => shown("A long answer with one queued"), "the answer is being written");
		await queue("Queued before the chord.");
		await composer.fill("Typed with the chord.");
		await composer.press("Meta+Enter");
		await waitUntil(async () => (await taken("Typed with the chord.").count()) === 1 && (await shown("Typed one handled.")), "the typed message went now and is answered");
		const typed = callReading("Typed with the chord.");
		assert(typed >= 0 && !calls[typed].userTexts.at(-1)!.includes("Queued before the chord."), `the chord sent the typed message alone, got ${JSON.stringify(calls[typed]?.userTexts.at(-1))}`);
		await waitUntil(async () => (await taken("Queued before the chord.").count()) === 1 && (await shown("Queued one handled.")), "the queued one went in after");
		assert(calls.findIndex((call) => call.userTexts.some((text) => text.includes("Queued before the chord."))) > typed, "the queued one went in after the typed one");
	});

	await scene("Send now under a queued bubble sends that message alone; the one before it stays queued and goes in after", async () => {
		legs = [{ held: true, lead: "Another long answer" }, { text: "Second handled." }, { text: "First handled." }];
		holdNextLeg();
		await send("Start another long answer.");
		await waitUntil(() => shown("Another long answer"), "the answer is being written");
		await queue("First queued.");
		await queue("Second queued.");
		const texts = await queuedTexts();
		assert(JSON.stringify(texts) === JSON.stringify(["First queued.", "Second queued."]), `the bubbles show in the order sent, got ${JSON.stringify(texts)}`);
		await offered(queued().first(), { tools: ALL_TOOLS, keys: KEYS }, "the first queued message, which the chord sends");
		await offered(queued().nth(1), { tools: ALL_TOOLS, keys: "" }, "the second queued message");
		const cuts = await page.getByText(STOPPED_FOR_NEXT).count();
		await queued().filter({ hasText: "Second queued." }).getByRole("button", { name: "Send now" }).click();
		await waitUntil(async () => (await page.getByText(STOPPED_FOR_NEXT).count()) > cuts, "the answer stopped for it");
		await waitUntil(() => shown("Second handled."), "it is answered");
		const second = callReading("Second queued.");
		assert(second >= 0 && !calls[second].userTexts.at(-1)!.includes("First queued."), `Send now sent that message alone, got ${JSON.stringify(calls[second]?.userTexts.at(-1))}`);
		await waitUntil(async () => (await taken("First queued.").count()) === 1 && (await shown("First handled.")), "the other went in after, as a queued message does");
		assert(callReading("First queued.") > second, "the one left queued went in after the one sent now");
		assert((await queued().count()) === 0, "nothing stays queued");
	});

	await scene("a step: Enter queues messages for after it; ⌘↵ in the empty box sends the first now, the other stays queued", async () => {
		legs = [{ tool: { name: "bash", args: { command: "sleep 20" } } }, { text: "Answer to the queued message." }, { text: "Answer to the second." }];
		await send("Run the long check.");
		await askCard.waitFor({ timeout: 15_000 });
		await allow.click();
		await waitUntil(() => frames.some(({ out, frame }) => !out && frame.type === "event" && frame.event?.type === "tool_execution_start"), "the step runs");
		await hintIs(HINTS.answering, "while a step runs");
		await queue("Queued during the step.");
		await queue("Second during the step.");
		const started = Date.now();
		await composer.press("Meta+Enter");
		await waitUntil(async () => (await taken("Queued during the step.").count()) === 1 && (await shown("Answer to the queued message.")), "the step stopped and the first queued message went now");
		assert(Date.now() - started < 15_000, "the step did not run to its end first");
		const first = callReading("Queued during the step.");
		assert(first >= 0 && !calls[first].userTexts.at(-1)!.includes("Second during the step."), `the chord sent the first queued message alone, got ${JSON.stringify(calls[first]?.userTexts.at(-1))}`);
		await waitUntil(async () => (await taken("Second during the step.").count()) === 1 && (await shown("Answer to the second.")), "the second went in after");
	});

	await scene("Stop puts every queued message back into the box, in order", async () => {
		legs = [{ held: true, lead: "An answer to stop" }];
		holdNextLeg();
		await send("Begin an answer to stop.");
		await waitUntil(() => shown("An answer to stop"), "the answer is being written");
		const before = calls.length;
		await queue("One to keep.");
		await queue("Two to keep.");
		await stopButton.click();
		await waitUntil(async () => (await composer.inputValue()) === "One to keep.\n\nTwo to keep.", `both are back in the box, oldest first, got ${JSON.stringify(await composer.inputValue())}`);
		assert((await queued().count()) === 0, "no bubble stays queued");
		release();
		await roomIdle();
		assert(!calls.slice(before).some((call) => call.userTexts.some((text) => text.includes("One to keep."))), "the model never read them");
		assert(await shown("You stopped this answer."), "the answer says the person stopped it");
	});

	await scene("Esc stops the answer and puts the queued message above what is typed", async () => {
		legs = [{ held: true, lead: "An answer for Esc" }];
		holdNextLeg();
		await send("Begin an answer for Esc.");
		await waitUntil(() => shown("An answer for Esc"), "the answer is being written");
		await queue("Back with Esc.");
		await composer.fill("words typed after");
		await hintIs(HINTS.answering, "before Esc");
		await composer.press("Escape");
		await waitUntil(async () => (await composer.inputValue()) === "Back with Esc.\n\nwords typed after", `the message is back above the typed words, got ${JSON.stringify(await composer.inputValue())}`);
		release();
		await roomIdle();
		assert((await queued().count()) === 0, "no bubble stays queued");
	});

	await scene("the answer after a Stop: Stop and Esc work from its start, though the last read said the room was stopping", async () => {
		legs = [{ held: true, lead: "An answer stopped first" }, { held: true, lead: "The answer after the Stop" }];
		holdNextLeg();
		await send("Begin an answer stopped first.");
		await waitUntil(() => shown("An answer stopped first"), "the answer is being written");
		// The page's first read of the room after Stop is one the server served before it let the
		// stopped turn go: it says the room is stopping. The reads after it are slow, held until the end.
		let afterStop = false;
		let stoppingRead = false;
		const heldReads: (() => Promise<void>)[] = [];
		const roomList = (url: URL) => url.pathname === "/api/persistent-agents";
		await page.route(roomList, async (route) => {
			if (route.request().method() !== "GET" || !afterStop) return route.continue();
			if (stoppingRead) {
				heldReads.push(() => route.continue());
				return;
			}
			const response = await route.fetch();
			const statuses = await response.json();
			for (const status of statuses) if (status.id === roomId && status.activeThread) status.activeThread = { ...status.activeThread, inFlight: true, working: false, cancelling: true };
			stoppingRead = true;
			await route.fulfill({ response, json: statuses });
		});
		const stops = await page.getByText("You stopped this answer.").count();
		try {
			await stopButton.click();
			afterStop = true;
			await waitUntil(async () => stoppingRead && (await page.getByText("You stopped this answer.").count()) > stops, "the answer stopped and the page read the room as stopping");
			release();
			await waitUntil(async () => (await stopButton.count()) === 0, "the stopped answer has ended on the page");
			holdNextLeg();
			await send("The question after the Stop.");
			await waitUntil(() => shown("The answer after the Stop"), "the next answer is being written");
			assert(await stopButton.isEnabled(), "Stop is enabled from the next answer's start");
			await composer.press("Escape");
			await waitUntil(async () => (await page.getByText("You stopped this answer.").count()) > stops + 1, "Esc stops the next answer at once");
		} finally {
			await page.unroute(roomList);
			for (const go of heldReads.splice(0)) await go().catch(() => {});
		}
	});

	await scene("a step that asked before the person typed: their message denies it, and its card says so first", async () => {
		legs = [{ tool: { name: "bash", args: { command: "echo first" } } }, { text: "Did the other thing." }];
		await send("Run the first echo.");
		await askCard.waitFor({ timeout: 15_000 });
		await hintIs(HINTS.stepAsks, "while a step asks");
		assert((await page.getByText(DENIES_LINE).count()) === 0, "with an empty box the card does not say a message denies it");
		await composer.fill("Do the other thing instead.");
		await waitUntil(async () => (await page.getByText(DENIES_LINE).count()) === 1, `with text typed the card says "${DENIES_LINE}"`);
		await composer.press("Enter");
		await waitUntil(async () => (await askCard.count()) === 0, "the card no longer asks");
		await waitUntil(() => shown("Did the other thing."), "the room answers the message");
		const last = calls.at(-1)!;
		assert(last.userTexts.at(-1)?.includes("Do the other thing instead.") && last.toolTexts.some((text) => /declined/i.test(text)), `the model reads the step as declined and the message, got ${JSON.stringify(last)}`);
	});

	await scene("a step that asked while the person typed: their message waits for it", async () => {
		legs = [{ held: true, lead: "Checking first.", tool: { name: "bash", args: { command: "echo second" } } }, { text: "Ran it, then read the note." }];
		holdNextLeg();
		await send("Check, then run the second echo.");
		await waitUntil(() => shown("Checking first."), "the answer is being written");
		await composer.fill("A note typed before it asked.");
		release();
		await askCard.waitFor({ timeout: 15_000 });
		assert((await page.getByText(DENIES_LINE).count()) === 0, "a step that asked while the person typed is not denied by their message");
		await queue("A note typed before it asked.");
		assert((await askCard.count()) === 1, "the step still asks");
		await allow.click();
		await waitUntil(async () => (await taken("A note typed before it asked.").count()) === 1 && (await shown("Ran it, then read the note.")), "the step ran, then the room took the message");
		const last = calls.at(-1)!;
		assert(last.toolTexts.at(-1)?.includes("second"), `the step ran and was not declined, got ${JSON.stringify(last.toolTexts.at(-1))}`);
	});

	await scene("Esc in the empty box while a step asks and a message waits for it: the step is denied, and the message goes in after it", async () => {
		legs = [{ held: true, lead: "Checking once more.", tool: { name: "bash", args: { command: "echo fourth" } } }, { text: "Denied, then read the note." }];
		holdNextLeg();
		await send("Check, then run the fourth echo.");
		await waitUntil(() => shown("Checking once more."), "the answer is being written");
		await composer.fill("A note for after the step.");
		release();
		await askCard.waitFor({ timeout: 15_000 });
		await queue("A note for after the step.");
		await composer.press("Escape");
		await waitUntil(async () => (await taken("A note for after the step.").count()) === 1 && (await shown("Denied, then read the note.")), "the step was denied, then the room took the message");
		assert(!calls.some((call) => call.toolTexts.some((text) => text.trim() === "fourth")), "the denied step did not run");
		assert((await composer.inputValue()) === "" && (await queued().count()) === 0, `Esc handed nothing back to the box, got ${JSON.stringify(await composer.inputValue())}`);
		await roomIdle();
	});

	await scene("⌘↵ in the empty box while a step asks sends the queued message now, and the step does not run", async () => {
		legs = [{ held: true, lead: "Checking again.", tool: { name: "bash", args: { command: "echo third" } } }, { text: "Answered the queued one." }];
		holdNextLeg();
		await send("Check, then run the third echo.");
		await waitUntil(() => shown("Checking again."), "the answer is being written");
		await composer.fill("Queued while it asks.");
		release();
		await askCard.waitFor({ timeout: 15_000 });
		await queue("Queued while it asks.");
		await composer.press("Meta+Enter");
		await waitUntil(async () => (await taken("Queued while it asks.").count()) === 1 && (await shown("Answered the queued one.")), "the queued message went now and is answered");
		assert(!calls.some((call) => call.toolTexts.some((text) => text.trim() === "third")), "the step that asked did not run");
		assert((await askCard.count()) === 0, "the step no longer asks");
	});

	await scene("\"@Room question\" while the room answers waits, and goes to that room once the answer ends", async () => {
		legs = [{ held: true, lead: "Answering before the consult", text: "." }];
		holdNextLeg();
		await send("Something to answer first.");
		await waitUntil(() => shown("Answering before the consult"), "the answer is being written");
		const before = calls.length;
		await composer.fill(`@${otherId} what do you think?`);
		await composer.press("Enter");
		await waitUntil(async () => (await queuedTexts()).some((text) => text.includes("what do you think?")), "the consult shows queued");
		assert(!calls.slice(before).some((call) => call.userTexts.some((text) => text.includes("what do you think?"))), "the other room is not asked while the answer runs");
		release();
		const card = page.locator(".consult-card").first();
		await card.waitFor({ timeout: 20_000 });
		await waitUntil(async () => (await card.innerText()).includes("From Other Room's memory") && calls.length > before, "the other room is asked once the answer ended, and answers");
		assert((await card.innerText()).includes("what do you think?"), "the card asks the question typed");
		assert((await queued().count()) === 0, "the consult no longer shows queued");
		// A docked card refuses another @mention: dismissed, the next case starts clean.
		await card.getByRole("button", { name: "Dismiss" }).click();
		await waitUntil(async () => (await page.locator(".consult-card").count()) === 0, "the card is dismissed");
	});

	await scene("⌘↵ in the empty box with a consult queued first asks that room first; the message after it goes once it has answered", async () => {
		legs = [{ held: true, lead: "Answering before a consult and a message" }];
		holdNextLeg();
		await send("Something to answer before a consult and a message.");
		await waitUntil(() => shown("Answering before a consult and a message"), "the answer is being written");
		await composer.fill(`@${otherId} consult asked first`);
		await composer.press("Enter");
		await waitUntil(async () => (await queuedTexts()).some((text) => text.includes("consult asked first")), "the consult shows queued");
		await queue("Message after the consult.");
		const mark = calls.length;
		await composer.press("Meta+Enter");
		const card = page.locator(".consult-card").first();
		await waitUntil(async () => (await card.count()) > 0 && (await card.innerText()).includes("consult asked first") && (await taken("Message after the consult.").count()) === 1, "the consult was asked and the message went");
		// The other room's call asks it to answer from its memory (the question rides in its instructions).
		await waitUntil(() => calls.slice(mark).some((call) => call.userTexts.some((text) => text.includes("Message after the consult."))), "the message reached this room's model");
		const consulted = calls.findIndex((call, index) => index >= mark && call.userTexts.some((text) => text.startsWith("Answer the consult question now")));
		const message = calls.findIndex((call, index) => index >= mark && call.userTexts.some((text) => text.includes("Message after the consult.")));
		assert(consulted >= 0 && message > consulted, `the consult chosen first went first, got consult at ${consulted}, message at ${message}`);
		await waitUntil(async () => (await card.getByRole("button", { name: "Dismiss" }).count()) > 0, "the consult answered");
		await card.getByRole("button", { name: "Dismiss" }).click();
		await waitUntil(async () => (await page.locator(".consult-card").count()) === 0, "the card is dismissed");
	});

	await scene("while a chosen consult runs, Send now on the message behind it sends that message", async () => {
		legs = [{ held: true, lead: "Answering before a consult held open" }, { held: true, lead: "The other room thinks" }, { text: "Sent while consulting." }];
		holdNextLeg();
		await send("Something to answer before a consult held open.");
		await waitUntil(() => shown("Answering before a consult held open"), "the answer is being written");
		await composer.fill(`@${otherId} consult held open`);
		await composer.press("Enter");
		await waitUntil(async () => (await queuedTexts()).some((text) => text.includes("consult held open")), "the consult shows queued");
		await queue("Sent during the consult.");
		const mark = calls.length;
		// The other room's answer waits until the case lets it go.
		holdNextLeg();
		await composer.press("Meta+Enter");
		await waitUntil(() => calls.slice(mark).some((call) => call.userTexts.some((text) => text.startsWith("Answer the consult question now"))), "the consult is asked");
		await queued().filter({ hasText: "Sent during the consult." }).getByRole("button", { name: "Send now" }).click();
		await waitUntil(() => calls.slice(mark).some((call) => call.userTexts.some((text) => text.includes("Sent during the consult."))), "Send now sent it while the consult runs");
		await waitUntil(async () => (await taken("Sent during the consult.").count()) === 1 && (await queued().count()) === 0, "it is the conversation's message, nothing stays queued");
		release();
		const card = page.locator(".consult-card").first();
		await waitUntil(async () => (await card.getByRole("button", { name: "Dismiss" }).count()) > 0, "the consult answered");
		await card.getByRole("button", { name: "Dismiss" }).click();
		await waitUntil(async () => (await page.locator(".consult-card").count()) === 0, "the card is dismissed");
	});

	await scene("Edit and Remove on a queued consult take it off the page; the other room is never asked", async () => {
		legs = [{ held: true, lead: "Answering before two consults taken back", text: "." }];
		holdNextLeg();
		await send("Something to answer before two consults taken back.");
		await waitUntil(() => shown("Answering before two consults taken back"), "the answer is being written");
		for (const words of ["consult edited", "consult removed"]) {
			await composer.fill(`@${otherId} ${words}`);
			await composer.press("Enter");
			await waitUntil(async () => (await queuedTexts()).some((text) => text.includes(words)) && (await composer.inputValue()) === "", `"${words}" shows queued and the box is empty`);
		}
		await offered(queued().first(), { tools: ALL_TOOLS, keys: KEYS }, "the first consult, which the chord sends");
		await offered(queued().nth(1), { tools: ALL_TOOLS, keys: "" }, "the second consult");
		const removed = queued().filter({ hasText: "consult removed" });
		await useTool(removed, "Remove");
		await waitUntil(async () => (await queued().count()) === 1, "Remove takes it off");
		const edited = queued().filter({ hasText: "consult edited" });
		await useTool(edited, "Edit");
		await waitUntil(async () => (await composer.inputValue()) === `@${otherId} consult edited` && (await queued().count()) === 0, "Edit puts it in the box");
		await composer.fill("");
		release();
		await roomIdle();
		assert((await page.locator(".consult-card").count()) === 0, "no consult card opens");
		assert(!calls.some((call) => call.userTexts.some((text) => text.includes("consult edited") || text.includes("consult removed"))), "no room read the consults taken back");
	});

	await scene("Edit and Remove on messages waiting behind a chosen consult take them off the page; the model never reads them", async () => {
		legs = [{ held: true, lead: "Answering before a consult with two behind" }, { held: true, lead: "The other room thinks" }];
		holdNextLeg();
		await send("Something to answer before a consult with two behind.");
		await waitUntil(() => shown("Answering before a consult with two behind"), "the answer is being written");
		await composer.fill(`@${otherId} consult with two behind`);
		await composer.press("Enter");
		await waitUntil(async () => (await queuedTexts()).some((text) => text.includes("consult with two behind")) && (await composer.inputValue()) === "", "the consult shows queued and the box is empty");
		await queue("Behind the consult, removed.");
		await queue("Behind the consult, edited.");
		const mark = calls.length;
		// The other room's answer waits until the case lets it go; the two behind wait for the new answer meanwhile.
		holdNextLeg();
		await composer.press("Meta+Enter");
		await waitUntil(() => calls.slice(mark).some((call) => call.userTexts.some((text) => text.startsWith("Answer the consult question now"))), "the consult is asked");
		await waitUntil(async () => (await queuedTexts()).join("|") === "Behind the consult, removed.|Behind the consult, edited.", "the two behind it wait");
		await offered(queued().first(), { tools: ALL_TOOLS, keys: KEYS }, "the first message behind the consult");
		await offered(queued().nth(1), { tools: ALL_TOOLS, keys: "" }, "the second message behind the consult");
		const removed = queued().filter({ hasText: "Behind the consult, removed." });
		await useTool(removed, "Remove");
		await waitUntil(async () => (await queuedTexts()).join("|") === "Behind the consult, edited.", "Remove takes it off");
		const edited = queued().filter({ hasText: "Behind the consult, edited." });
		await useTool(edited, "Edit");
		await waitUntil(async () => (await composer.inputValue()) === "Behind the consult, edited." && (await queued().count()) === 0, "Edit puts it in the box");
		await composer.fill("");
		release();
		const card = page.locator(".consult-card").first();
		await waitUntil(async () => (await card.getByRole("button", { name: "Dismiss" }).count()) > 0, "the consult answered");
		await card.getByRole("button", { name: "Dismiss" }).click();
		await waitUntil(async () => (await page.locator(".consult-card").count()) === 0, "the card is dismissed");
		await roomIdle();
		assert(!calls.some((call) => call.userTexts.some((text) => text.includes("Behind the consult"))), "the model never read the two taken back");
	});

	await scene("\"@Room question\" typed after a step asked denies the step, and the consult goes once the answer ends", async () => {
		legs = [{ tool: { name: "bash", args: { command: "echo fourth" } } }, { text: "Fine, not run." }];
		await send("Run the fourth echo.");
		await askCard.waitFor({ timeout: 15_000 });
		const before = calls.length;
		await composer.fill(`@${otherId} a question instead`);
		await waitUntil(async () => (await page.getByText(DENIES_LINE).count()) === 1, `the card says "${DENIES_LINE}"`);
		await composer.press("Enter");
		await waitUntil(async () => (await askCard.count()) === 0, "the step no longer asks");
		const card = page.locator(".consult-card").first();
		await waitUntil(async () => (await card.count()) > 0 && (await card.innerText()).includes("a question instead") && calls.length > before + 1, "the consult goes once the answer ended");
		assert(!calls.some((call) => call.toolTexts.some((text) => text.trim() === "fourth")), "the denied step did not run");
		await waitUntil(async () => (await card.getByRole("button", { name: "Dismiss" }).count()) > 0, "the consult answered");
		await card.getByRole("button", { name: "Dismiss" }).click();
		await waitUntil(async () => (await page.locator(".consult-card").count()) === 0, "the card is dismissed");
	});

	await scene("two \"@Room questions\" queued in one answer: dismissing the first consult starts the second", async () => {
		legs = [{ held: true, lead: "Answering before two consults", text: "." }];
		holdNextLeg();
		await send("Something to answer before two consults.");
		await waitUntil(() => shown("Answering before two consults"), "the answer is being written");
		for (const question of ["first consult question", "second consult question"]) {
			await composer.fill(`@${otherId} ${question}`);
			await composer.press("Enter");
			await waitUntil(async () => (await queuedTexts()).some((text) => text.includes(question)), `"${question}" shows queued`);
		}
		release();
		const card = page.locator(".consult-card").first();
		await waitUntil(async () => (await card.count()) > 0 && (await card.innerText()).includes("first consult question") && (await card.getByRole("button", { name: "Dismiss" }).count()) > 0, "the first consult answered");
		await card.getByRole("button", { name: "Dismiss" }).click();
		await waitUntil(async () => (await card.count()) > 0 && (await card.innerText()).includes("second consult question"), "dismissing the first starts the second");
		await waitUntil(async () => (await queued().count()) === 0, "nothing stays queued");
		await waitUntil(async () => (await card.getByRole("button", { name: "Dismiss" }).count()) > 0, "the second consult answered");
		await card.getByRole("button", { name: "Dismiss" }).click();
		await waitUntil(async () => (await page.locator(".consult-card").count()) === 0, "the card is dismissed");
	});

	await scene("files staged while the room answers: Send is greyed and says why", async () => {
		legs = [{ held: true, lead: "Answering while files wait" }];
		holdNextLeg();
		await send("Something to answer while files wait.");
		await waitUntil(() => shown("Answering while files wait"), "the answer is being written");
		const file = path.join(tempRoot, "notes-to-send.txt");
		fs.writeFileSync(file, "Some notes.\n");
		await page.locator('input[type="file"]').first().setInputFiles(file);
		await composer.fill("With these notes.");
		await waitUntil(async () => (await sendButton.count()) === 1 && (await sendButton.isDisabled()) && (await sendButton.getAttribute("title")) === "Send files once the answer ends", `Send is greyed and says why, got ${JSON.stringify(await sendButton.getAttribute("title").catch(() => null))}`);
		release();
		await roomIdle();
		await waitUntil(() => sendButton.isEnabled(), "once the answer ended, Send works");
		await composer.fill("");
		await page.getByRole("button", { name: "Remove notes-to-send.txt" }).click();
		await waitUntil(async () => (await page.getByRole("button", { name: "Remove notes-to-send.txt" }).count()) === 0, "the staged file is taken off");
	});

	await scene("a queued \"@Room question\" is still there after a reload, held", async () => {
		legs = [{ held: true, lead: "Answering before a reload", text: "." }];
		holdNextLeg();
		await send("Something to answer before a reload.");
		await waitUntil(() => shown("Answering before a reload"), "the answer is being written");
		const question = `@${otherId} keep this question`;
		await composer.fill(question);
		await composer.press("Enter");
		await waitUntil(async () => (await queuedTexts()).some((text) => text.includes("keep this question")), "the consult shows queued");
		await page.reload();
		await composer.waitFor({ timeout: 15_000 });
		await waitUntil(async () => (await page.locator(".bubble-row.user.queued[data-held]", { hasText: "keep this question" }).count()) === 1, "after the reload the consult waits as a held message");
		release();
		await roomIdle();
		await useTool(queued().filter({ hasText: "keep this question" }), "Remove");
		await waitUntil(async () => (await queued().count()) === 0, "Remove takes it off");
	});

	await scene("a window reloaded into a running answer queues Enter's message once it has caught up, never sends it as a new one", async () => {
		legs = [{ held: true, lead: "An answer a reload steps into" }, { text: "Took the one queued after the reload." }];
		holdNextLeg();
		await send("Begin an answer a reload steps into.");
		await waitUntil(() => shown("An answer a reload steps into"), "the answer is being written");
		// The reloaded window's connection is open, and the server has not caught it up yet (it binds the room, slow under load).
		holdCatchUp("ready");
		const from = frames.length;
		await page.reload();
		await composer.waitFor({ timeout: 15_000 });
		await waitUntil(() => frames.slice(from).some(({ out, frame }) => !out && frame.type === "ready"), "the server has the reloaded window's connection");
		await composer.fill("Typed while it catches up.");
		await hintIs(HINTS.answering, "the reloaded window, catching up on the running answer");
		await waitUntil(() => sendButton.isDisabled(), "Send waits until the window has caught up");
		await composer.press("Enter");
		assert((await composer.inputValue()) === "Typed while it catches up.", `Enter keeps the message in the box while the window catches up, got ${JSON.stringify(await composer.inputValue())}`);
		letCatchUpGo();
		await queue("Typed while it catches up.");
		assert(!frames.slice(from).some(({ out, frame }) => out && frame.type === "prompt"), "no new message went to the room while its answer ran");
		release();
		await waitUntil(() => shown("Took the one queued after the reload."), "the answer took the queued message");
	});

	await scene("a window reloaded into a running answer with a message waiting: Send now and ⌘↵ wait until the replay is in, and the answer stays", async () => {
		legs = [{ held: true, lead: "An answer a reload keeps" }, { text: "Took the one waiting across the reload." }];
		holdNextLeg();
		await send("Begin an answer a reload keeps.");
		await waitUntil(() => shown("An answer a reload keeps"), "the answer is being written");
		await queue("Waiting across the reload.");
		// The reloaded window has its ready, with the waiting message; the replay of the answer is still on its way (a slow link).
		holdCatchUp("turn_reattach");
		const from = frames.length;
		await page.reload();
		await composer.waitFor({ timeout: 15_000 });
		await waitUntil(() => frames.slice(from).some(({ out, frame }) => !out && frame.type === "turn_reattach"), "the server steps the reloaded window back into the answer");
		await waitUntil(async () => (await queued().filter({ hasText: "Waiting across the reload." }).count()) === 1, "the reloaded window shows the waiting message");
		await queued().filter({ hasText: "Waiting across the reload." }).getByRole("button", { name: "Send now" }).click();
		await composer.press("Meta+Enter");
		letCatchUpGo();
		await waitUntil(() => shown("An answer a reload keeps"), "the replay shows the running answer");
		assert(!frames.slice(from).some(({ out, frame }) => out && frame.type === "abort"), "nothing stopped the answer while the window caught up");
		await hintIs(HINTS.answering, "the reloaded window, caught up");
		release();
		await waitUntil(() => shown("Took the one waiting across the reload."), "the answer took the waiting message");
		assert(await shown("An answer a reload keeps"), "the answer's words stay in the conversation");
	});

	await scene("a message waiting for the answer when another window takes the room is the answer's, never held", async () => {
		legs = [{ held: true, lead: "An answer another window takes" }, { text: "Took the waiting one." }];
		holdNextLeg();
		await send("Begin an answer another window takes.");
		await waitUntil(() => shown("An answer another window takes"), "the answer is being written");
		// A window steps back into the running answer, and queues there; then another window takes the room from it.
		await page.reload();
		await composer.waitFor({ timeout: 15_000 });
		await waitUntil(() => shown("An answer another window takes"), "the reloaded window shows the running answer");
		await hintIs(HINTS.answering, "the reloaded window, while it writes");
		await queue("Waiting when the room moves.");
		const heldDir = path.join(agentsRoot, roomId, "runtime", "held-messages");
		const heldTexts = () => (fs.existsSync(heldDir) ? fs.readdirSync(heldDir).filter((name) => name.endsWith(".json")).flatMap((name) => (JSON.parse(fs.readFileSync(path.join(heldDir, name), "utf-8")).messages ?? []).map((message: any) => message.text)) : []);
		const other = await ctx.newPage();
		await other.goto(`${baseUrl}/#/room/${encodeURIComponent(roomId)}`);
		await other.locator("textarea").first().waitFor({ timeout: 15_000 });
		await waitUntil(async () => (await page.getByText("This room is now open in another window.").count()) > 0, "the first window says the room moved");
		release();
		await waitUntil(() => calls.some((call) => call.userTexts.some((text) => text.includes("Waiting when the room moves."))), "the answer took the waiting message");
		await waitUntil(async () => (await other.getByText("Took the waiting one.").count()) > 0, "the window that has the room shows it answered");
		assert(!heldTexts().includes("Waiting when the room moves."), `a message the answer took is not held, got ${JSON.stringify(heldTexts())}`);
		await other.close();
		await page.getByRole("button", { name: "Open here" }).click();
		await hintIs(HINTS.idle, "the first window, back in the room");
		await waitUntil(async () => (await queued().count()) === 0, "nothing shows queued or held once the room took it");
	});

	if (process.platform === "win32") console.log("skip held messages over a server restart (a stop on Windows is a kill)");
	else await scene("queued messages no answer took at a server stop are held: a reload and a second window show them, with Edit, Remove and Send now", async () => {
		legs = [{ held: true, lead: "An answer the server stops" }];
		holdNextLeg();
		await send("Begin an answer the server stops.");
		await waitUntil(() => shown("An answer the server stops"), "the answer is being written");
		await queue("Keep this for later.");
		await queue("Keep this too.");
		await queue("Send this one later.");
		await stopSmokeServer(server);
		release();
		await hintIs(HINTS.disconnected, "with the server gone");
		const heldDir = path.join(agentsRoot, roomId, "runtime", "held-messages");
		const heldOnDisk = () => (fs.existsSync(heldDir) ? fs.readdirSync(heldDir).filter((name) => name.endsWith(".json")).flatMap((name) => (JSON.parse(fs.readFileSync(path.join(heldDir, name), "utf-8")).messages ?? []).map((message: any) => message.text)) : []);
		assert(JSON.stringify(heldOnDisk()) === JSON.stringify(["Keep this for later.", "Keep this too.", "Send this one later."]), `the server kept them on disk, in order, got ${JSON.stringify(heldOnDisk())}`);

		await startServer();
		const heldShown = async (p: Page, label: string) => {
			await waitUntil(async () => (await queued(p).count()) === 3, `${label}: three held bubbles`);
			const texts = await queuedTexts(p);
			assert(JSON.stringify(texts) === JSON.stringify(["Keep this for later.", "Keep this too.", "Send this one later."]), `${label}: in order, got ${JSON.stringify(texts)}`);
			assert((await p.locator(".bubble-row.user.queued[data-held]").count()) === 3, `${label}: each is held`);
			for (const bubble of await queued(p).all()) await offered(bubble, { tools: ALL_TOOLS, keys: "" }, `${label}: a held message`);
		};
		await page.reload();
		await page.locator("textarea").first().waitFor({ timeout: 15_000 });
		await heldShown(page, "after the restart and a reload");
		await stopLineShown(page, "after the restart and a reload");
		await savedWhole("after the restart and a reload");
		await hintIs(HINTS.idle, "idle, with held messages");

		const second = await ctx.newPage();
		await second.goto(`${baseUrl}/#/room/${encodeURIComponent(roomId)}`);
		await second.locator("textarea").first().waitFor({ timeout: 15_000 });
		await heldShown(second, "a second window");
		await stopLineShown(second, "a second window");
		const box = second.locator("textarea").first();
		await useTool(queued(second).filter({ hasText: "Keep this for later." }), "Edit");
		await waitUntil(async () => (await box.inputValue()) === "Keep this for later." && (await queued(second).count()) === 2, "Edit puts the message in the box");
		await waitUntil(() => heldOnDisk().length === 2, "Edit takes it off the held list");
		await useTool(queued(second).filter({ hasText: "Keep this too." }), "Remove");
		await waitUntil(async () => (await queued(second).count()) === 1 && heldOnDisk().length === 1, "Remove takes it off");
		await stopLineShown(second, "one held message left");
		await savedWhole("after Edit and Remove");
		// Words typed in the box stay there: Send now sends the held message alone.
		await box.fill("A draft I keep.");
		legs = [{ text: "Sent from held." }];
		await queued(second).getByRole("button", { name: "Send now" }).click();
		await waitUntil(() => calls.some((call) => call.userTexts.at(-1) === "Send this one later."), "Send now sends the held message");
		await waitUntil(async () => (await second.locator(".bubble-row.user:not(.queued)", { hasText: "Send this one later." }).count()) === 1 && (await queued(second).count()) === 0, "it is the conversation's message now");
		await waitUntil(() => heldOnDisk().length === 0, "nothing is held any more");
		assert((await box.inputValue()) === "A draft I keep.", `the box keeps its draft, got ${JSON.stringify(await box.inputValue())}`);
		await second.reload();
		await second.locator("textarea").first().waitFor({ timeout: 15_000 });
		await waitUntil(() => second.getByText("Sent from held.").count().then((count) => count > 0), "the reloaded window shows the conversation");
		assert((await queued(second).count()) === 0, "a reload shows nothing held");
		await stopLineShown(second, "after Send now and a reload");
		const third = await ctx.newPage();
		await third.goto(`${baseUrl}/#/room/${encodeURIComponent(roomId)}`);
		await waitUntil(() => third.getByText("Sent from held.").count().then((count) => count > 0), "another window shows the conversation");
		await stopLineShown(third, "after Send now, another window");
		await third.close();
		await savedWhole("after Send now");
		await second.close();
		// The first window still shows the three; once its connection comes back, it shows what the server holds now.
		assert((await queued().count()) === 3, "the first window still shows what it had");
		await stopSmokeServer(server);
		await hintIs(HINTS.disconnected, "the first window, with the server gone");
		await startServer();
		await hintIs(HINTS.idle, "the first window, connected again");
		await waitUntil(async () => (await queued().count()) === 0, "the first window drops the held messages the second sent, edited or removed");
	});

	if (process.platform === "win32") console.log("skip a message typed after a server stop (a stop on Windows is a kill)");
	else await scene("a message typed after a server stop: the cut answer's line says send again while it is the last, and leaves it out once the message follows", async () => {
		const LEAD = "An answer cut with nothing queued";
		legs = [{ held: true, lead: LEAD }];
		holdNextLeg();
		await send("Begin an answer cut with nothing queued.");
		await waitUntil(() => shown(LEAD), "the answer is being written");
		await stopSmokeServer(server);
		release();
		await hintIs(HINTS.disconnected, "with the server gone");
		await startServer();
		await page.reload();
		await composer.waitFor({ timeout: 15_000 });
		await hintIs(HINTS.idle, "after the restart");
		// The earlier stop lines are followed by messages; this one is the conversation's last, so it alone says send again.
		const transcript = async () => (await page.locator(".messages").innerText()).replace(/\s+/g, " ");
		const lastLineWhole = async () => {
			const words = await transcript();
			return words.lastIndexOf(LEAD) >= 0 && words.slice(words.lastIndexOf(LEAD)).includes(STOP_CUT_ANSWER_SENTENCE);
		};
		await waitUntil(lastLineWhole, "with nothing after it, the cut answer's line shows whole").catch(async (error) => {
			const items = await threadItems();
			throw new Error(`${(error as Error).message}; the page shows ${JSON.stringify((await transcript()).slice(-300))}; the thread ends ${JSON.stringify(items.slice(-3).map((item) => [item?.kind, item?.level, String(item?.text ?? "").slice(-120)]))}`);
		});
		const words = await transcript();
		assert(!words.slice(0, words.lastIndexOf(LEAD)).includes(SEND_AGAIN), `the stop lines above, followed by messages, leave out "${SEND_AGAIN}", got ${JSON.stringify(words.slice(-400))}`);
		legs = [{ text: "Answered after the restart." }];
		await send("Carry on after the restart.");
		await waitUntil(() => shown("Answered after the restart."), "the room answers the new message");
		await stopLineShown(page, "a message typed after the restart");
		const cutLine = (words: string) => words.slice(words.lastIndexOf(LEAD), words.lastIndexOf("Carry on after the restart."));
		assert(cutLine(await transcript()).includes(STOP_CUT_FIRST), `the cut answer keeps its line's first sentence, got ${JSON.stringify(cutLine(await transcript()))}`);
		await page.reload();
		await composer.waitFor({ timeout: 15_000 });
		await waitUntil(() => shown("Answered after the restart."), "the reloaded window shows the answer");
		await stopLineShown(page, "a message typed after the restart, after a reload");
		const other = await ctx.newPage();
		await other.goto(`${baseUrl}/#/room/${encodeURIComponent(roomId)}`);
		await waitUntil(() => other.getByText("Answered after the restart.").count().then((count) => count > 0), "another window shows the answer");
		await stopLineShown(other, "a message typed after the restart, another window");
		await other.close();
		await savedWhole("a message typed after the restart");
	});

	await scene("the box never says Working", async () => {
		const working = [...hintsSeen].filter((words) => /Working/i.test(words));
		assert(working.length === 0, `no hint says Working, got ${JSON.stringify(working)}`);
		assert(hintsSeen.has(HINTS.answering) && hintsSeen.has(HINTS.stepAsks) && hintsSeen.has(HINTS.idle), `each state's hint was seen: ${JSON.stringify([...hintsSeen])}`);
	});

	if (failed.length) throw new Error(`${failed.length} case(s) failed:\n- ${failed.join("\n- ")}`);
	console.log("room-send-edges smoke: ok");
} catch (error) {
	console.error(serverOutput.join("").split("\n").filter((line) => !line.includes("token=")).join("\n").slice(-6000));
	throw error;
} finally {
	release();
	try { if (browser) await closeBrowser(browser); } catch {}
	await stopSmokeServer(server);
	try { (gateway as any).closeAllConnections?.(); } catch {}
	await new Promise<void>((resolve) => gateway.close(() => resolve()));
	fs.rmSync(tempRoot, { recursive: true, force: true });
}
