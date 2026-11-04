// The effort dial while a model switch waits, in the browser against a real
// spawned server and synthetic providers. Each case reads the conversation's
// stored model and level, and what the page sent on the room's socket:
// - with no pick waiting a level goes out at once;
// - while a pick waits for the running answer the dial works on the picked
//   model's ladder, no line says it waits and the model in use hears nothing;
//   when the switch takes over the level is the picked model's, and the next
//   answer runs at it;
// - the same while the switch request is on the wire;
// - a switch whose answer is lost but which landed still takes the level;
// - a socket that drops around the switch loses no level;
// - a pick replaced by a newer pick, taken back or refused drops the level,
//   also under a drag still held when the refusal lands.
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import { fileURLToPath } from "node:url";
import { chromium, type Browser, type Page, type WebSocketRoute } from "playwright";
import { authedFetch, SMOKE_AUTH_TOKEN, SMOKE_SERVER_AUTH_ENV, SMOKE_SERVER_SPAWN_TREE_OPTIONS, smokeHomeEnv, stopSmokeServer, freePort } from "./smoke-server-process.js";
import { waitEvery } from "./smoke-wait.js";

const waitUntil = waitEvery(150);

function assert(condition: unknown, message: string): asserts condition {
	if (!condition) throw new Error(message);
}

let passes = 0;
function pass(label: string): void {
	passes += 1;
	console.log(`  ok  ${label}`);
}

// A machine without Chromium cannot run a browser assertion at all; skip whole.
{
	const p = typeof chromium?.executablePath === "function" ? chromium.executablePath() : "";
	if (!p || !fs.existsSync(p)) {
		console.log("effort while switching ui smoke skipped (Chromium not installed)");
		process.exit(0);
	}
}

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const webServerDir = path.resolve(scriptDir, "..");
const repoRoot = path.resolve(webServerDir, "..", "..");
const port = await freePort();
const baseUrl = `http://127.0.0.1:${port}`;

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "exxperts-effort-while-switching-"));
const tempHome = path.join(tempRoot, "home");
const agentsRoot = path.join(tempHome, ".exxperts", "app", "personalized-agents");
const agentDir = path.join(tempHome, ".exxperts", "agent");
const appDir = path.join(tempHome, ".exxperts", "app");
for (const dir of [agentsRoot, agentDir]) fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
process.env.HOME = tempHome;
process.env.USERPROFILE = tempHome;
process.env.EXXPERTS_CODING_AGENT_DIR = agentDir;
process.env.EXXETA_PERSISTENT_AGENTS_ROOT = agentsRoot;

const CLAUDE = { provider: "fake-claude", model: "claude-fake" };
const GPT = { provider: "fake-gpt", model: "gpt-fake" };

const requests: Array<{ model: string; raw: string }> = [];
// While set, an answer waits for its release before it ends.
let gate: Promise<void> | null = null;
function holdAnswers(): () => void {
	let release = () => {};
	gate = new Promise<void>((resolve) => { release = resolve; });
	return () => { gate = null; release(); };
}

function sse(res: http.ServerResponse, event: string | null, payload: unknown): void {
	res.write(`${event ? `event: ${event}\n` : ""}data: ${JSON.stringify(payload)}\n\n`);
}

// Two synthetic providers: one speaks the Anthropic stream, one the OpenAI one.
const providers = http.createServer((req, res) => {
	let raw = "";
	req.on("data", (chunk) => { raw += chunk; });
	req.on("end", async () => {
		const body = JSON.parse(raw || "{}");
		requests.push({ model: String(body.model), raw });
		const text = `Answer from ${body.model}.`;
		const held = gate;
		res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
		if (String(req.url ?? "").includes("/messages")) {
			sse(res, "message_start", { type: "message_start", message: { id: `msg_${requests.length}`, type: "message", role: "assistant", model: body.model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 100, output_tokens: 1 } } });
			sse(res, "content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } });
			sse(res, "content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text } });
			if (held) await held;
			sse(res, "content_block_stop", { type: "content_block_stop", index: 0 });
			sse(res, "message_delta", { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 20 } });
			sse(res, "message_stop", { type: "message_stop" });
			res.end();
			return;
		}
		const base = { id: `cmpl_${requests.length}`, object: "chat.completion.chunk", created: Math.floor(Date.now() / 1000), model: body.model };
		sse(res, null, { ...base, choices: [{ index: 0, delta: { role: "assistant", content: text }, finish_reason: null }] });
		if (held) await held;
		sse(res, null, { ...base, choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 } });
		res.write("data: [DONE]\n\n");
		res.end();
	});
});

async function api(pathname: string): Promise<any> {
	return (await authedFetch(`${baseUrl}${pathname}`)).json();
}

/** The conversation's stored model, the level it runs that model at, and the room's default for new conversations. */
async function standing(agentId: string): Promise<{ model: string; level: string; roomDefault: string }> {
	const status = await api(`/api/persistent-agents/${agentId}/status`);
	const threadId = status.runtime.activeThreadId;
	const { thread } = await api(`/api/persistent-agents/${agentId}/threads/${threadId}`);
	const { models } = await api(`/api/persistent-agents/${agentId}/threads/${threadId}/model-options`);
	const option = models.find((candidate: any) => candidate.model === thread.model.model);
	return { model: thread.model.model, level: option.effort.level, roomDefault: (await api(`/api/persistent-agents/${agentId}/models`)).effort };
}

async function ladderOf(agentId: string, model: string): Promise<Array<{ level: string; label: string }>> {
	const status = await api(`/api/persistent-agents/${agentId}/status`);
	const { models } = await api(`/api/persistent-agents/${agentId}/threads/${status.runtime.activeThreadId}/model-options`);
	return models.find((candidate: any) => candidate.model === model).effort.ladder;
}

/** A room opened from Home with one answer said, its dial on the bottom rung, and the page's effort frames recorded from then on. */
async function openRoom(browser: Browser, agentId: string, name: string, routeSocket?: (page: Page) => Promise<void>): Promise<{ page: Page; frames: Array<{ level?: string; explicit?: boolean }>; lowest: string }> {
	const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
	const page = await context.newPage();
	await routeSocket?.(page);
	const frames: Array<{ level?: string; explicit?: boolean }> = [];
	page.on("websocket", (ws) => ws.on("framesent", (frame) => {
		try { const msg = JSON.parse(String(frame.payload)); if (msg?.type === "effort") frames.push(msg); } catch {}
	}));
	await page.goto(`${baseUrl}/auth/session?token=${SMOKE_AUTH_TOKEN}`);
	await page.waitForLoadState("networkidle");
	const dismiss = page.locator(".whats-new-close");
	if (await dismiss.count()) await dismiss.click();
	await page.locator(".persistent-agent-card").filter({ hasText: name }).getByRole("button", { name: /Enter|Resume/ }).click();
	await page.locator('button[title="Send"]').first().waitFor({ timeout: 15000 });
	// The room's ready frame (its context ring) is in, so the effort is the socket's.
	await page.locator(".composer-context-pill:not(.composer-context-waiting)").first().waitFor({ timeout: 15000 });
	// Entering a room can swap its socket once: Enter waits for a Send that is on.
	const composer = page.locator("textarea").first();
	await composer.fill("A first question.");
	await waitUntil(async () => !(await page.locator('button[title="Send"]').first().isDisabled()), "Send is on");
	await composer.press("Enter");
	await page.getByText("Answer from claude-fake.").last().waitFor({ timeout: 20000 });
	await waitUntil(async () => (await page.locator(".stop-btn").count()) === 0, "the first answer has ended");
	await page.locator(".model-pick-trigger").first().click();
	const slider = page.locator(".model-pick-panel [role=slider]");
	await slider.waitFor({ timeout: 10000 });
	await slider.focus();
	await page.keyboard.press("Home");
	await waitUntil(() => frames.length >= 1, "a level set with no pick waiting goes out at once");
	const lowest = String(frames[frames.length - 1]!.level);
	await waitUntil(async () => (await standing(agentId)).level === lowest, `the conversation stores ${lowest}`);
	await page.keyboard.press("Escape");
	await waitUntil(async () => (await page.locator(".model-pick-panel").count()) === 0, "the panel closes");
	frames.length = 0;
	return { page, frames, lowest };
}

async function startHeldAnswer(page: Page): Promise<() => void> {
	const release = holdAnswers();
	const composer = page.locator("textarea").first();
	await composer.fill("A question the room is still answering.");
	await composer.press("Enter");
	await page.locator(".stop-btn").waitFor({ timeout: 15000 });
	return release;
}

/** Picks a model and stays in the panel, which goes back to the effort view: the way a person goes on to set the level. */
async function pickAndStay(page: Page, name: string): Promise<void> {
	const panel = page.locator(".model-pick-panel");
	if (!(await panel.count())) await page.locator(".model-pick-trigger").first().click();
	await panel.waitFor({ timeout: 10000 });
	const toModels = panel.locator(".model-pick-effort-model");
	if (await toModels.count()) await toModels.click();
	await panel.locator(".model-pick-row").filter({ hasText: name }).click();
	await panel.locator("[role=slider]").waitFor({ timeout: 10000 });
}

/** The dial works: not marked as waiting, focusable, and End takes it to the top of the ladder it shows. */
async function setTopLevel(page: Page, agentId: string, model: string): Promise<string> {
	const ladder = await ladderOf(agentId, model);
	const top = ladder[ladder.length - 1]!;
	const slider = page.locator(".model-pick-panel [role=slider]");
	assert((await slider.getAttribute("aria-disabled")) === null, "the dial works while the pick waits");
	assert((await slider.getAttribute("aria-valuemax")) === String(ladder.length), `the dial shows the picked model's ${ladder.length} rungs, got ${await slider.getAttribute("aria-valuemax")}`);
	assert((await page.locator(".model-pick-panel").getByText(/can be changed once/).count()) === 0, "no line says the effort waits");
	await slider.focus();
	await page.keyboard.press("End");
	await waitUntil(async () => (await slider.getAttribute("aria-valuenow")) === String(ladder.length), "the dial follows the key");
	return top.level;
}

/** Send answers again, so nothing about the switch is pending; an empty box keeps it off whatever the room does. */
async function sendIsBack(page: Page): Promise<void> {
	await page.locator("textarea").first().fill("A message for later.");
	await waitUntil(async () => !(await page.locator('button[title="Send"]').first().isDisabled()), "Send is back once the switch has settled");
}

async function closePanel(page: Page): Promise<void> {
	await page.keyboard.press("Escape");
	await waitUntil(async () => (await page.locator(".model-pick-panel").count()) === 0, "the panel closes");
}

let server: ChildProcessWithoutNullStreams | undefined;
let browser: Browser | undefined;
const serverOutput: string[] = [];

try {
	await new Promise<void>((resolve) => providers.listen(0, "127.0.0.1", resolve));
	const providerPort = (providers.address() as AddressInfo).port;
	fs.writeFileSync(path.join(agentDir, "models.json"), JSON.stringify({
		providers: {
			"fake-claude": { name: "Fake Claude", baseUrl: `http://127.0.0.1:${providerPort}`, api: "anthropic-messages", models: [{ id: "claude-fake", name: "Claude Fake", reasoning: true, input: ["text"], contextWindow: 200000, maxTokens: 32000 }] },
			"fake-gpt": { name: "Fake GPT", baseUrl: `http://127.0.0.1:${providerPort}/v1`, api: "openai-completions", models: [
				{ id: "gpt-fake", name: "GPT Fake", reasoning: true, input: ["text"], contextWindow: 200000, maxTokens: 16000 },
				{ id: "next-fake", name: "Next Fake", reasoning: true, input: ["text"], contextWindow: 200000, maxTokens: 16000 },
			] },
		},
	}, null, 2), { mode: 0o600 });
	fs.writeFileSync(path.join(agentDir, "auth.json"), JSON.stringify({ "fake-claude": { type: "api_key", key: "synthetic-claude" }, "fake-gpt": { type: "api_key", key: "synthetic-gpt" } }, null, 2), { mode: 0o600 });
	fs.writeFileSync(path.join(appDir, "custom-ai-profiles.json"), JSON.stringify({ version: 1, profiles: [
		{ id: "custom-fake-claude", providerId: "fake-claude", label: "Fake Claude", roomModels: ["claude-fake"], learnModel: "claude-fake", reviewMemoryModel: "claude-fake" },
		{ id: "custom-fake-gpt", providerId: "fake-gpt", label: "Fake GPT", roomModels: ["gpt-fake", "next-fake"], learnModel: "gpt-fake", reviewMemoryModel: "gpt-fake" },
	] }, null, 2), { mode: 0o600 });
	fs.writeFileSync(path.join(appDir, "persistent-agent-ai-profile.json"), JSON.stringify({ profileId: "custom-fake-claude" }, null, 2), { mode: 0o600 });

	const agents = await import("../src/persistent-agents.js");
	const roomModels = await import("../src/room-models.js");
	const newRoom = (displayName: string) => {
		const id = agents.createPersistentAgentFromScaffoldInput({ displayName, userName: "Synthetic User", preferredUserAddress: "Synthetic User" }).agent.agentId;
		roomModels.writeRoomModels(id, { conversation: CLAUDE, memory: GPT });
		return id;
	};
	const carryId = newRoom("Carry Room");
	const wireId = newRoom("Wire Room");
	const lostId = newRoom("Lost Room");
	const replacedId = newRoom("Replaced Room");
	const backId = newRoom("Back Room");
	const refusedId = newRoom("Refused Room");
	const dragId = newRoom("Drag Room");
	const socketId = newRoom("Socket Room");

	server = spawn("npx", ["tsx", "src/index.ts"], {
		shell: process.platform === "win32",
		...SMOKE_SERVER_SPAWN_TREE_OPTIONS,
		cwd: webServerDir,
		env: smokeHomeEnv(tempHome, { PORT: String(port), ...SMOKE_SERVER_AUTH_ENV, EXXETA_HOME: repoRoot, EXXPERTS_CODING_AGENT_DIR: agentDir, EXXETA_PERSISTENT_AGENTS_ROOT: agentsRoot }) as NodeJS.ProcessEnv,
	});
	server.stdout.on("data", (chunk) => serverOutput.push(String(chunk)));
	server.stderr.on("data", (chunk) => serverOutput.push(String(chunk)));
	await waitUntil(() => fetch(`${baseUrl}/healthz`).then((r) => r.ok).catch(() => false), "server ready");
	browser = await chromium.launch();

	// --- The level set while a pick waits goes over with the new model ---------------------
	{
		const { page, frames, lowest } = await openRoom(browser, carryId, "Carry Room");
		pass("with no pick waiting, a level goes out at once and the conversation stores it");
		const release = await startHeldAnswer(page);
		await pickAndStay(page, "GPT Fake");
		const level = await setTopLevel(page, carryId, GPT.model);
		assert((await page.locator(".model-pick-trigger").first().getAttribute("aria-label"))?.startsWith("Model and effort: GPT Fake"), "the control names the picked model");
		await closePanel(page);
		assert(frames.length === 0, `the model in use hears nothing while the pick waits: ${JSON.stringify(frames)}`);
		const waiting = await standing(carryId);
		assert(waiting.model === CLAUDE.model && waiting.level === lowest && waiting.roomDefault === lowest, `the current model's level stays: ${JSON.stringify(waiting)}`);
		pass("while a pick waits the dial works on the picked ladder, with no sentence, and the current model's level stays");
		release();
		await page.getByText("Continued on GPT Fake", { exact: true }).waitFor({ timeout: 15000 });
		await waitUntil(async () => {
			const now = await standing(carryId);
			return now.model === GPT.model && now.level === level && now.roomDefault === level;
		}, `the conversation runs GPT at ${level}`);
		assert(JSON.stringify(frames) === JSON.stringify([{ type: "effort", level, explicit: true }]), `the level goes out once, marked as the person's: ${JSON.stringify(frames)}`);
		await sendIsBack(page);
		const composer = page.locator("textarea").first();
		await composer.fill("A question after the switch.");
		await composer.press("Enter");
		await page.getByText("Answer from gpt-fake.").waitFor({ timeout: 20000 });
		const asked = requests.filter((request) => request.model === GPT.model && request.raw.includes("A question after the switch."));
		assert(asked.length > 0 && asked.every((request) => request.raw.includes(`"reasoning_effort":"${level}"`)), `the next answer runs at ${level}, got ${asked.map((request) => JSON.parse(request.raw).reasoning_effort)}`);
		await page.context().close();
		pass("the level goes over with the switch, and the next answer runs at it");
	}

	// --- While the switch request is on the wire --------------------------------------------
	{
		const { page, frames } = await openRoom(browser, wireId, "Wire Room");
		let landSwitch = () => {};
		const landed = new Promise<void>((resolve) => { landSwitch = resolve; });
		await page.route(/\/switch-model$/, async (route) => { await landed; await route.continue(); });
		await pickAndStay(page, "GPT Fake");
		const level = await setTopLevel(page, wireId, GPT.model);
		await closePanel(page);
		assert(frames.length === 0, `nothing goes out before the switch lands: ${JSON.stringify(frames)}`);
		landSwitch();
		await waitUntil(async () => {
			const now = await standing(wireId);
			return now.model === GPT.model && now.level === level;
		}, `the conversation runs GPT at ${level}`);
		await page.context().close();
		pass("a level set while the switch is on the wire goes over with it");
	}

	// --- A switch that landed but whose answer was lost ---------------------------------------
	{
		const { page } = await openRoom(browser, lostId, "Lost Room");
		await page.route(/\/switch-model$/, async (route) => {
			// The room can still say it is answering: only the answer of a switch that landed is lost.
			const answer = await route.fetch();
			if (!answer.ok()) return route.fulfill({ response: answer });
			await route.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ error: "The switch's answer was lost." }) });
		});
		const release = await startHeldAnswer(page);
		await pickAndStay(page, "GPT Fake");
		const level = await setTopLevel(page, lostId, GPT.model);
		await closePanel(page);
		release();
		await page.getByText("The switch's answer was lost.").waitFor({ timeout: 15000 });
		await waitUntil(async () => {
			const now = await standing(lostId);
			return now.model === GPT.model && now.level === level;
		}, `the stored model is the pick, so the level goes over too: ${level}`);
		await page.context().close();
		pass("a switch that landed with its answer lost still takes the level");
	}

	// --- The socket drops and its effort is not back when the switch answers -------------------
	{
		const sockets: WebSocketRoute[] = [];
		const heldFrames: Array<() => void> = [];
		let holdFrames = false;
		const { page } = await openRoom(browser, socketId, "Socket Room", (room) => room.routeWebSocket(/\/ws\?/, (ws) => {
			sockets.push(ws);
			const server = ws.connectToServer();
			server.onMessage((message) => {
				// The two frames that bring the effort back to the page.
				if (holdFrames && typeof message === "string" && /"type":"(ready|model_switched)"/.test(message)) { heldFrames.push(() => ws.send(message)); return; }
				ws.send(message);
			});
			ws.onMessage((message) => server.send(message));
		}));
		let landSwitch = () => {};
		const landed = new Promise<void>((resolve) => { landSwitch = resolve; });
		await page.route(/\/switch-model$/, async (route) => { await landed; await route.continue(); });
		await pickAndStay(page, "GPT Fake");
		const level = await setTopLevel(page, socketId, GPT.model);
		await closePanel(page);
		holdFrames = true;
		await sockets[sockets.length - 1]!.close({ code: 4000, reason: "down" });
		await waitUntil(() => heldFrames.length >= 1, "the room's next socket is up, its ready frame held back");
		landSwitch();
		await waitUntil(async () => (await standing(socketId)).model === GPT.model, "the switch lands");
		holdFrames = false;
		for (const deliver of heldFrames) deliver();
		await waitUntil(async () => (await standing(socketId)).level === level, `the level survives the socket: ${level}`);
		await page.context().close();
		pass("a socket that drops around the switch loses no level");
	}

	// --- A newer pick replaces the held level -----------------------------------------------
	{
		const { page, frames, lowest } = await openRoom(browser, replacedId, "Replaced Room");
		const release = await startHeldAnswer(page);
		await pickAndStay(page, "GPT Fake");
		await setTopLevel(page, replacedId, GPT.model);
		await pickAndStay(page, "Next Fake");
		const slider = page.locator(".model-pick-panel [role=slider]");
		const nextLadder = await ladderOf(replacedId, "next-fake");
		await waitUntil(async () => (await slider.getAttribute("aria-valuenow")) !== String(nextLadder.length), "the newer pick's dial stands on the room's level, not the one held before");
		await closePanel(page);
		release();
		await page.getByText("Continued on Next Fake", { exact: true }).waitFor({ timeout: 15000 });
		await waitUntil(async () => (await standing(replacedId)).model === "next-fake", "the newer pick took over");
		await sendIsBack(page);
		const now = await standing(replacedId);
		assert(now.level === lowest && now.roomDefault === lowest && frames.length === 0, `a replaced pick drops its level: ${JSON.stringify({ now, frames })}`);
		await page.context().close();
		pass("a pick replaced by a newer pick drops the held level");
	}

	// --- A pick taken back ---------------------------------------------------------------------
	{
		const { page, frames, lowest } = await openRoom(browser, backId, "Back Room");
		const release = await startHeldAnswer(page);
		await pickAndStay(page, "GPT Fake");
		await setTopLevel(page, backId, GPT.model);
		await pickAndStay(page, "Claude Fake");
		await closePanel(page);
		release();
		await waitUntil(async () => (await page.locator(".stop-btn").count()) === 0, "the answer has ended");
		await sendIsBack(page);
		const now = await standing(backId);
		assert(now.model === CLAUDE.model && now.level === lowest && frames.length === 0, `a pick taken back drops its level: ${JSON.stringify({ now, frames })}`);
		await page.context().close();
		pass("a pick taken back drops the held level and the model in use keeps its own");
	}

	// --- A refused pick --------------------------------------------------------------------------
	{
		const { page, frames, lowest } = await openRoom(browser, refusedId, "Refused Room");
		await page.route(/\/switch-model$/, (route) => route.fulfill({ status: 409, contentType: "application/json", body: JSON.stringify({ error: "This room is busy.", code: "switch_room_busy" }) }));
		const release = await startHeldAnswer(page);
		await pickAndStay(page, "GPT Fake");
		await setTopLevel(page, refusedId, GPT.model);
		await closePanel(page);
		release();
		await page.getByText("This room is busy.").waitFor({ timeout: 15000 });
		await waitUntil(async () => (await page.locator(".model-pick-trigger-name").first().innerText()) === "Claude Fake", "the control shows the model in use again");
		const now = await standing(refusedId);
		assert(now.model === CLAUDE.model && now.level === lowest && frames.length === 0, `a refused pick drops its level: ${JSON.stringify({ now, frames })}`);
		await page.context().close();
		pass("a refused pick drops the held level and the model in use keeps its own");
	}

	// --- A refusal under a drag still held ---------------------------------------------------------
	{
		const { page, frames, lowest } = await openRoom(browser, dragId, "Drag Room");
		await page.route(/\/switch-model$/, (route) => route.fulfill({ status: 409, contentType: "application/json", body: JSON.stringify({ error: "This room is busy.", code: "switch_room_busy" }) }));
		const release = await startHeldAnswer(page);
		await pickAndStay(page, "GPT Fake");
		const lastRung = await page.locator(".effort-dial-label").last().boundingBox();
		assert(lastRung, "the top rung's word shows around the arc");
		await page.mouse.move(lastRung.x + lastRung.width / 2, lastRung.y + lastRung.height / 2);
		await page.mouse.down();
		release();
		await page.getByText("This room is busy.").waitFor({ timeout: 15000 });
		await page.mouse.up();
		const shown = page.locator(".model-pick-panel");
		await waitUntil(async () => (await shown.locator(".model-pick-effort-title").innerText()) === (await shown.locator("[role=slider]").getAttribute("aria-valuetext")), "the level's name follows the model in use, not the drag that was cut");
		assert(await page.evaluate(() => Boolean(document.activeElement?.closest(".model-pick-panel"))), "the keys stay in the panel when the slider is replaced");
		await closePanel(page);
		await sendIsBack(page);
		const now = await standing(dragId);
		assert(now.model === CLAUDE.model && now.level === lowest && now.roomDefault === lowest && frames.length === 0, `a drag cut by the refusal reaches no model: ${JSON.stringify({ now, frames })}`);
		await page.context().close();
		pass("a drag still held when the refusal lands reaches no model");
	}

	console.log(`effort-while-switching-ui smoke: ${passes} checks passed`);
} catch (error) {
	console.error(serverOutput.join("").slice(-6000));
	throw error;
} finally {
	try { await browser?.close(); } catch {}
	try { (providers as any).closeAllConnections?.(); } catch {}
	try { providers.close(); } catch {}
	await stopSmokeServer(server);
	fs.rmSync(tempRoot, { recursive: true, force: true });
}
