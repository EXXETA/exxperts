// The message box's model and effort pick, in the browser against a real
// spawned server and two synthetic providers:
// - the panel's keys, run as a Mac and as Windows: Enter opens on the slider,
//   arrows move it, Tab reaches the model's name, Enter shows the models,
//   arrows, Home and End move through them, Escape steps back, then closes and
//   gives focus back to the control;
// - an effort pick goes out marked explicit and becomes the room's default;
// - a model picked while the room answers shows at once and applies to the
//   next answer; a message sent right as the answer ends is answered by it;
// - two switches with no message between leave one "Continued on" line,
//   also after a reload;
// - a model this conversation is too long for opens the window; Remember and
//   switch runs Remember, and the new conversation runs on the picked model
//   with its one "Continued on" line;
// - in a room this save would fill, the window offers Remember only.
// - the level's name under the dial draws as a real semibold, 16px at desktop
//   and 17px in the phone's sheet, light and dark; the chosen level's word
//   around the arc alone is lit, after a click, an arrow key and a drag, and
//   while a pick waits;
// - the dial's arc deepens from Low to Max in the colours a person sees, the
//   grey track past the knob, on ladders of two to six rungs, light and dark;
// - the needle swings on a key or a click and settles after a drag, under half
//   a second, follows a drag with no lag, and stands at rest on opening; a page
//   that asks for reduced motion gets no motion at all;
// - the context ring's number reaches 4.5:1 in each state it shows (each zone,
//   unknown, waiting, offline), dark and light, under the box and in the
//   phone's box;
// - a gateway model saved with a dash in its name reads whole in the context
//   popup.
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
		console.log("model pick page smoke skipped (Chromium not installed)");
		process.exit(0);
	}
}

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const webServerDir = path.resolve(scriptDir, "..");
const repoRoot = path.resolve(webServerDir, "..", "..");
const port = await freePort();
const baseUrl = `http://127.0.0.1:${port}`;

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "exxperts-model-pick-page-"));
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
const MID = { provider: "fake-gpt", model: "mid-fake" };
// A gateway model's name as its owner saved it, with a dash in it.
const GATEWAY_MODEL_NAME = "Finance \u2014 EU";
const COMPRESSION_MARK = "Checkpoint Compression Constitution";
const requests: Array<{ model: string; raw: string; asked: string }> = [];
// The text of the last user message a request carries: what that answer answers.
function lastUserText(body: any): string {
	const messages = Array.isArray(body?.messages) ? body.messages : [];
	const last = [...messages].reverse().find((message: any) => message?.role === "user");
	const content = last?.content;
	return typeof content === "string" ? content : Array.isArray(content) ? content.map((part: any) => String(part?.text ?? "")).join("") : "";
}
// While set, an answer waits for its release before it ends.
let gate: { release: () => void; opened: Promise<void> } | null = null;
function holdAnswers(): () => void {
	let release = () => {};
	const opened = new Promise<void>((resolve) => { release = resolve; });
	gate = { release, opened };
	return () => { gate = null; release(); };
}

// While set, a Remember read waits for its release; while refused, every Remember read is.
let rememberGate: { release: () => void; opened: Promise<void> } | null = null;
function holdRemember(): () => void {
	let release = () => {};
	const opened = new Promise<void>((resolve) => { release = resolve; });
	rememberGate = { release, opened };
	return () => { rememberGate = null; release(); };
}
let refuseRemember = false;

function sse(res: http.ServerResponse, event: string | null, payload: unknown): void {
	res.write(`${event ? `event: ${event}\n` : ""}data: ${JSON.stringify(payload)}\n\n`);
}

// Two synthetic providers: one speaks the Anthropic stream, one the OpenAI one.
const providers = http.createServer((req, res) => {
	let raw = "";
	req.on("data", (chunk) => { raw += chunk; });
	req.on("end", async () => {
		const body = JSON.parse(raw || "{}");
		requests.push({ model: String(body.model), raw, asked: lastUserText(body) });
		const remembering = raw.includes(COMPRESSION_MARK);
		const text = remembering ? "TITLE:\nPicked a model\n\nSESSION_ARC:\nTalked, then picked a model.\n\nBODY:\n- Picked.\n\nPARKED:\nNone\n" : `Answer from ${body.model}.`;
		const held = remembering ? null : gate;
		if (remembering && rememberGate) await rememberGate.opened;
		if (remembering && refuseRemember) {
			res.writeHead(400, { "content-type": "application/json" }).end(JSON.stringify({ error: { message: "Synthetic refusal of this read.", type: "invalid_request_error" } }));
			return;
		}
		res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
		if (String(req.url ?? "").includes("/messages")) {
			sse(res, "message_start", { type: "message_start", message: { id: `msg_${requests.length}`, type: "message", role: "assistant", model: body.model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 100, output_tokens: 1 } } });
			sse(res, "content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } });
			sse(res, "content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text } });
			if (held) await held.opened;
			sse(res, "content_block_stop", { type: "content_block_stop", index: 0 });
			sse(res, "message_delta", { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 20 } });
			sse(res, "message_stop", { type: "message_stop" });
			res.end();
			return;
		}
		const base = { id: `cmpl_${requests.length}`, object: "chat.completion.chunk", created: Math.floor(Date.now() / 1000), model: body.model };
		sse(res, null, { ...base, choices: [{ index: 0, delta: { role: "assistant", content: text }, finish_reason: null }] });
		if (held) await held.opened;
		sse(res, null, { ...base, choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 } });
		res.write("data: [DONE]\n\n");
		res.end();
	});
});

const modelsFile = path.join(agentDir, "models.json");
function writeModels(providerPort: number, midWindow: number): void {
	fs.writeFileSync(modelsFile, JSON.stringify({
		providers: {
			"fake-claude": { name: "Fake Claude", baseUrl: `http://127.0.0.1:${providerPort}`, api: "anthropic-messages", models: [{ id: "claude-fake", name: "Claude Fake", reasoning: true, input: ["text"], contextWindow: 200000, maxTokens: 32000 }] },
			"fake-gpt": { name: "Fake GPT", baseUrl: `http://127.0.0.1:${providerPort}/v1`, api: "openai-completions", models: [
				{ id: "gpt-fake", name: "GPT Fake", reasoning: true, input: ["text"], contextWindow: 200000, maxTokens: 16000 },
				{ id: "mid-fake", name: "Mid Fake", input: ["text"], contextWindow: midWindow, maxTokens: 4000 },
			] },
		},
	}, null, 2), { mode: 0o600 });
}

async function api(pathname: string, init: { method?: string; body?: string } = {}): Promise<{ status: number; body: any }> {
	const response = await authedFetch(`${baseUrl}${pathname}`, { ...init, headers: init.body ? { "content-type": "application/json" } : {} });
	const text = await response.text();
	return { status: response.status, body: text ? JSON.parse(text) : null };
}

/** Opens a room from Home, the way a person does, and waits for its socket. */
async function enterRoom(page: Page, name: string): Promise<void> {
	await page.goto(`${baseUrl}/auth/session?token=${SMOKE_AUTH_TOKEN}`);
	await page.waitForLoadState("networkidle");
	const dismiss = page.locator(".whats-new-close");
	if (await dismiss.count()) await dismiss.click();
	await page.locator(".persistent-agent-card").filter({ hasText: name }).getByRole("button", { name: /Enter|Resume/ }).click();
	await page.locator('button[title="Send"]').first().waitFor({ timeout: 15000 });
	// The control names the model, and the room's ready frame (its context ring) is in, so the effort is the socket's.
	await page.locator(".model-pick-trigger").first().waitFor({ timeout: 15000 });
	await page.locator(".composer-context-pill:not(.composer-context-waiting)").first().waitFor({ timeout: 15000 });
}

async function sendAndWait(page: Page, text: string, answer: string): Promise<void> {
	const composer = page.locator("textarea").first();
	await composer.fill(text);
	await composer.press("Enter");
	await page.getByText(answer).last().waitFor({ timeout: 20000 });
	await waitUntil(async () => (await page.locator(".stop-btn").count()) === 0, "the answer has ended");
}

/** The model panel open on the models view. */
async function openModels(page: Page): Promise<void> {
	const panel = page.locator(".model-pick-panel");
	if (!(await panel.count())) await page.locator(".model-pick-trigger").first().click();
	await panel.waitFor({ timeout: 10000 });
	const toModels = panel.locator(".model-pick-effort-model");
	if (await toModels.count()) await toModels.click();
	await panel.locator(".model-pick-row").first().waitFor({ timeout: 10000 });
}

async function pick(page: Page, name: string): Promise<void> {
	await openModels(page);
	await page.locator(".model-pick-panel .model-pick-row").filter({ hasText: name }).click();
	if (await page.locator(".model-pick-panel").count()) await page.keyboard.press("Escape");
	if (await page.locator(".model-pick-panel").count()) await page.keyboard.press("Escape");
}

const triggerName = (page: Page) => page.locator(".model-pick-trigger-name").first().innerText();
const continuedLines = (page: Page) => page.locator(".messages").getByText(/^Continued on /);
const focused = (page: Page) => page.evaluate(() => {
	const el = document.activeElement as HTMLElement | null;
	return { className: el?.className ?? "", role: el?.getAttribute("role") ?? "", text: el?.innerText ?? "", valueNow: el?.getAttribute("aria-valuenow") ?? "" };
});

/** A computed CSS colour (rgb(), rgba() or color(srgb ...)) as [r, g, b] on 0 to 255 and its alpha. */
function cssColour(value: string): { rgb: number[]; alpha: number } {
	const srgb = /^color\(srgb ([\d.e-]+) ([\d.e-]+) ([\d.e-]+)(?: \/ ([\d.e-]+))?\)$/.exec(value);
	if (srgb) return { rgb: srgb.slice(1, 4).map((part) => Number(part) * 255), alpha: srgb[4] == null ? 1 : Number(srgb[4]) };
	const rgb = /^rgba?\(([\d.]+), ([\d.]+), ([\d.]+)(?:, ([\d.]+))?\)$/.exec(value);
	assert(rgb, `a colour the smoke can read, got ${value}`);
	return { rgb: rgb.slice(1, 4).map(Number), alpha: rgb[4] == null ? 1 : Number(rgb[4]) };
}

/** Paints colours over each other, the last one at the bottom, as the page shows them. */
function painted(layers: string[]): number[] {
	return layers.map(cssColour).reduceRight((under, { rgb, alpha }) => rgb.map((value, i) => value * alpha + under[i] * (1 - alpha)), [255, 255, 255]);
}

/** WCAG contrast of two colours given as [r, g, b]. */
function contrast(a: number[], b: number[]): number {
	const luminance = (colour: number[]) => {
		const [r, g, bl] = colour.map((value) => (value / 255 <= 0.03928 ? value / 255 / 12.92 : ((value / 255 + 0.055) / 1.055) ** 2.4));
		return 0.2126 * r + 0.7152 * g + 0.0722 * bl;
	};
	const [high, low] = [luminance(a), luminance(b)].sort((x, y) => y - x);
	return (high + 0.05) / (low + 0.05);
}

/** The context pill's text against what it sits on: its own fill, then each box around it down to the first solid one. */
async function pillContrast(page: Page, selector: string): Promise<number> {
	const { text, layers } = await page.locator(selector).first().evaluate((pill) => {
		const label = pill.querySelector(".composer-context-pill-label") ?? pill;
		const found: string[] = [];
		for (let el: Element | null = pill; el; el = el.parentElement) {
			const background = getComputedStyle(el).backgroundColor;
			found.push(background);
			if (/^rgb\(/.test(background) || / \/ 1\)$|^color\(srgb [^/]+\)$/.test(background)) break;
		}
		return { text: getComputedStyle(label).color, layers: found };
	});
	const under = painted(layers);
	return contrast(painted([text, ...layers]), under);
}

/** The level's name as drawn beside the same words in each display face: the computed weight alone would say 600 over a 700 file. */
function levelNameDrawn(page: Page) {
	return page.locator(".model-pick-effort-title").evaluate(async (name) => {
		const { fontSize, fontWeight, letterSpacing } = getComputedStyle(name);
		const widths: number[] = [];
		for (const family of ["Bandeins Strange Variable", "Bandeins Strange"]) {
			await document.fonts.load(`${fontWeight} ${fontSize} "${family}"`);
			const probe = document.createElement("span");
			probe.textContent = name.textContent;
			probe.style.cssText = `position:absolute;visibility:hidden;white-space:nowrap;font:${fontWeight} ${fontSize} "${family}";letter-spacing:${letterSpacing}`;
			document.body.append(probe);
			widths.push(probe.getBoundingClientRect().width);
			probe.remove();
		}
		await document.fonts.ready;
		return { fontSize, fontWeight, width: name.getBoundingClientRect().width, variable: widths[0]!, staticBold: widths[1]! };
	});
}

/** Waits for the slider to say `level`, then holds the words around the arc to it: that word in the text colour, every other one muted. */
async function assertLevelLit(page: Page, level: string, moment: string): Promise<void> {
	const slider = page.locator(".model-pick-panel [role=slider], .model-pick-sheet [role=slider]").first();
	await waitUntil(async () => (await slider.getAttribute("aria-valuetext")) === level, `${moment}: the slider says ${level}`);
	const words = await page.locator(".effort-dial").evaluate((dial) => {
		const probe = document.createElement("span");
		dial.append(probe);
		probe.style.color = "var(--fg)";
		const text = getComputedStyle(probe).color;
		probe.style.color = "var(--muted)";
		const muted = getComputedStyle(probe).color;
		probe.remove();
		const all = [...dial.querySelectorAll(".effort-dial-label")].map((label) => ({ word: label.textContent ?? "", colour: getComputedStyle(label).color }));
		return { all, lit: all.filter((label) => label.colour === text).map((label) => label.word), greyed: all.filter((label) => label.colour === muted).length };
	});
	assert(words.lit.join("|") === level && words.greyed === words.all.length - 1, `${moment}: only ${level} is lit, got ${JSON.stringify(words)}`);
}

/** The needle's angle as drawn, 0 straight up; `at` first holds the dial's running motion at that time. */
function needle(page: Page, at?: number) {
	return page.locator(".effort-dial").evaluate((dial, time) => {
		const [motion] = dial.getAnimations();
		if (motion && time !== undefined) {
			motion.pause();
			motion.currentTime = time;
		}
		const line = dial.querySelector(".effort-dial-needle") as SVGLineElement;
		const screen = line.getScreenCTM()!;
		const x = line.x2.baseVal.value - line.x1.baseVal.value;
		const y = line.y2.baseVal.value - line.y1.baseVal.value;
		const angle = (Math.atan2(screen.a * x + screen.c * y, -(screen.b * x + screen.d * y)) * 180) / Math.PI;
		return { angle, running: dial.getAnimations().length, ms: motion ? Number(motion.effect?.getComputedTiming().endTime) : 0 };
	}, at);
}

/** Where the needle rests on the slider's rung: the arc runs 115 degrees to each side. */
async function restAngle(page: Page): Promise<number> {
	const slider = page.locator("[role=slider]").first();
	const [now, max] = await Promise.all([slider.getAttribute("aria-valuenow"), slider.getAttribute("aria-valuemax")]);
	return -115 + (230 * (Number(now) - 1)) / (Number(max) - 1);
}

const afterTwoFrames = (page: Page) => page.evaluate(() => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done))));
const dialMotionLog = (page: Page): Promise<string[]> => page.evaluate(() => (window as any).dialMotion);

/** Walks the motion the dial just started, held at its start by the page's listener so any machine's speed sees the same curve, then lets it end. */
async function walkDialMotion(page: Page, moment: string): Promise<{ ms: number; angles: number[] }> {
	await waitUntil(async () => (await needle(page)).running > 0, `${moment}: the dial moves`);
	const { ms } = await needle(page);
	const angles: number[] = [];
	for (let at = 0; at <= ms; at += 10) angles.push((await needle(page, at)).angle);
	await page.locator(".effort-dial").evaluate((dial) => { for (const motion of dial.getAnimations()) motion.finish(); });
	await waitUntil(async () => (await needle(page)).running === 0, `${moment}: the motion ends`);
	return { ms, angles };
}

/** The colours on screen at these shares of the arc from Low, and on the knob's ring, read from a real picture of the page. */
async function arcPixels(page: Page, shares: number[]): Promise<{ arc: number[][]; ring: number[] }> {
	const spots = await page.locator(".effort-dial").evaluate((dial, onArc) => {
		const track = dial.querySelector(".effort-dial-track") as SVGPathElement;
		const screen = track.getScreenCTM()!;
		const length = track.getTotalLength();
		const points = onArc.map((share) => {
			const { x, y } = track.getPointAtLength(length * share);
			return { x: screen.a * x + screen.c * y + screen.e, y: screen.b * x + screen.d * y + screen.f };
		});
		const knob = dial.querySelector(".effort-slider-thumb") as SVGCircleElement;
		const turned = knob.getScreenCTM()!;
		// The stroke is centred on the circle's own radius, so that point is the ring's middle.
		const [x, y] = [knob.cx.baseVal.value + knob.r.baseVal.value, knob.cy.baseVal.value];
		return { points, ring: { x: turned.a * x + turned.c * y + turned.e, y: turned.b * x + turned.d * y + turned.f } };
	}, shares);
	const picture = (await page.screenshot()).toString("base64");
	const reader = await page.context().newPage();
	const read = await reader.evaluate(async ({ picture, wanted }) => {
		const bitmap = await createImageBitmap(await (await fetch(`data:image/png;base64,${picture}`)).blob());
		const canvas = new OffscreenCanvas(bitmap.width, bitmap.height).getContext("2d")!;
		canvas.drawImage(bitmap, 0, 0);
		return wanted.map(({ x, y }) => [...canvas.getImageData(Math.round(x), Math.round(y), 1, 1).data.slice(0, 3)]);
	}, { picture, wanted: [...spots.points, spots.ring] });
	await reader.close();
	return { arc: read.slice(0, -1), ring: read[read.length - 1]! };
}

/** The page's own colours the ramp and the track are mixed from, as [r, g, b]. */
function dialTokens(page: Page) {
	return page.locator(".effort-dial").evaluate((dial) => {
		const probe = document.createElement("span");
		dial.append(probe);
		const [paper, plan, shape, text] = ["--exx-paper", "--exx-plan", "--exx-plan-shape", "--fg"].map((token) => {
			probe.style.color = `var(${token})`;
			return getComputedStyle(probe).color;
		});
		probe.remove();
		return { paper: paper!, plan: plan!, shape: shape!, text: text!, panel: getComputedStyle(dial.closest(".model-pick-panel")!).backgroundColor };
	});
}

const mixed = (a: number[], b: number[], share: number) => a.map((value, i) => value * share + b[i]! * (1 - share));

/** The arc's ramp at a share from Low: pale, the brand lila at the middle, deep at the top. */
function rampAt(share: number, tokens: Awaited<ReturnType<typeof dialTokens>>): number[] {
	const [paper, plan, shape, text] = [tokens.paper, tokens.plan, tokens.shape, tokens.text].map((colour) => cssColour(colour).rgb);
	if (share <= 0.5) return mixed(shape!, mixed(shape!, paper!, 0.55), share * 2);
	return mixed(mixed(plan!, text!, 0.8), shape!, share * 2 - 1);
}

const closeTo = (a: number[], b: number[]) => a.every((value, i) => Math.abs(value - b[i]!) <= 6);

function setRecentContextEntries(agents: any, agentId: string, count: number): void {
	const instance = agents.createPersistentAgentInstance(agentId);
	const l1bPath = instance.l1bCurrentPath(instance.readAgentJson());
	const base = fs.readFileSync(l1bPath, "utf-8");
	const match = /^##\s+Recent Context\s*$/m.exec(base);
	assert(match?.index != null, "the scaffold's memory has a Recent Context section");
	const start = match.index + match[0].length;
	const entries = Array.from({ length: count }, (_, i) => `### RC-${String(i + 1).padStart(4, "0")} | OPEN | 2026-09-18 | Waiting conversation ${i + 1}\n\n**Session arc:** Session ${i + 1} was talked through.\n\n**Body:**\n- Point ${i + 1}.\n\n**Parked:**\nNone\n`).join("\n");
	fs.writeFileSync(l1bPath, `${base.slice(0, start)}\n\n${entries}\n`, "utf-8");
}

let server: ChildProcessWithoutNullStreams | undefined;
let browser: Browser | undefined;
const serverOutput: string[] = [];

try {
	await new Promise<void>((resolve) => providers.listen(0, "127.0.0.1", resolve));
	const providerPort = (providers.address() as AddressInfo).port;
	writeModels(providerPort, 200000);
	fs.writeFileSync(path.join(agentDir, "auth.json"), JSON.stringify({ "fake-claude": { type: "api_key", key: "synthetic-claude" }, "fake-gpt": { type: "api_key", key: "synthetic-gpt" } }, null, 2), { mode: 0o600 });
	fs.writeFileSync(path.join(appDir, "custom-ai-profiles.json"), JSON.stringify({ version: 1, profiles: [
		{ id: "custom-fake-claude", providerId: "fake-claude", label: "Fake Claude", roomModels: ["claude-fake"], learnModel: "claude-fake", reviewMemoryModel: "claude-fake" },
		{ id: "custom-fake-gpt", providerId: "fake-gpt", label: "Fake GPT", roomModels: ["gpt-fake", "mid-fake"], learnModel: "gpt-fake", reviewMemoryModel: "gpt-fake" },
	] }, null, 2), { mode: 0o600 });
	fs.writeFileSync(path.join(appDir, "persistent-agent-ai-profile.json"), JSON.stringify({ profileId: "custom-fake-claude" }, null, 2), { mode: 0o600 });

	const agents = await import("../src/persistent-agents.js");
	const roomModels = await import("../src/room-models.js");
	const newRoom = (displayName: string) => {
		const id = agents.createPersistentAgentFromScaffoldInput({ displayName, userName: "Synthetic User", preferredUserAddress: "Synthetic User" }).agent.agentId;
		roomModels.writeRoomModels(id, { conversation: CLAUDE, memory: GPT });
		return id;
	};
	newRoom("Keys Room");
	const pickId = newRoom("Pick Room");
	const fullId = newRoom("Full Room");
	const lostId = newRoom("Lost Room");
	const clampId = newRoom("Clamp Room");
	const cancelId = newRoom("Cancel Room");
	const pinId = newRoom("Pin Room");
	const gatewayId = newRoom("Gateway Room");
	newRoom("Dial Room");
	newRoom("Spring Room");
	setRecentContextEntries(agents, fullId, 19);

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
	// A saved gateway whose owner named its model with a dash in it, and a room on that model.
	const gateway = await api("/api/persistent-agent-ai-profiles/gateways", { method: "POST", body: JSON.stringify({ label: "Finance gateway", baseUrl: `http://127.0.0.1:${providerPort}/v1`, key: "synthetic-gateway-key", roomModels: [{ modelId: "fin-eu", label: GATEWAY_MODEL_NAME, vision: false, webSearch: false, reasoning: false }], maintenanceModel: "fin-eu" }) });
	assert(gateway.status === 200 && gateway.body?.gateway?.providerId, `the gateway is set up, got ${gateway.status} ${JSON.stringify(gateway.body)}`);
	const gatewayPicked = await api(`/api/persistent-agents/${gatewayId}/models`, { method: "PUT", body: JSON.stringify({ conversation: { provider: gateway.body.gateway.providerId, model: "fin-eu" } }) });
	assert(gatewayPicked.status === 200, `the gateway room picks the gateway's model, got ${gatewayPicked.status} ${JSON.stringify(gatewayPicked.body)}`);

	// --- A gateway model's saved name, dash and all, in the context popup ---------------
	{
		const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
		const page = await ctx.newPage();
		await enterRoom(page, "Gateway Room");
		await page.locator(".composer-context-pill").first().click();
		const shownName = (await page.locator(".composer-context-popover-row strong").first().innerText()).trim();
		assert(shownName === GATEWAY_MODEL_NAME, `the context popup names the model as saved, got ${JSON.stringify(shownName)}`);
		await ctx.close();
		// Gone again, so the model lists the checks below read are the two providers' alone.
		const removed = await api(`/api/persistent-agent-ai-profiles/gateways/${gateway.body.gateway.id}`, { method: "DELETE" });
		assert(removed.status === 200, `the gateway is removed, got ${removed.status} ${JSON.stringify(removed.body)}`);
		pass(`a gateway model saved as ${JSON.stringify(GATEWAY_MODEL_NAME)} reads so in the context popup`);
	}

	// --- The panel's keys, as a Mac and as Windows -----------------------------------------
	const platforms = [
		{ name: "Mac", userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36", platform: "MacIntel" },
		{ name: "Windows", userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36", platform: "Win32" },
	];
	for (const platform of platforms) {
		const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 }, userAgent: platform.userAgent });
		await ctx.addInitScript((value) => { Object.defineProperty(navigator, "platform", { get: () => value }); }, platform.platform);
		const page = await ctx.newPage();
		await enterRoom(page, "Keys Room");
		const trigger = page.locator(".model-pick-trigger").first();
		await waitUntil(async () => (await page.locator(".model-pick-trigger .speedometer-icon").count()) === 1, "the control shows the effort's speedometer");
		await trigger.focus();
		await page.keyboard.press("Enter");
		await page.locator(".model-pick-panel").waitFor({ timeout: 10000 });
		await waitUntil(async () => (await focused(page)).role === "slider", "Enter opens the panel with focus on the slider");
		// A press on the level's name under the dial's hub, either half of it, holds the level shown.
		const slider = page.locator(".model-pick-panel [role=slider]");
		const levelShown = await slider.getAttribute("aria-valuetext");
		const title = await page.locator(".model-pick-effort-title").boundingBox();
		assert(title, "the level's name shows under the hub");
		for (const at of [0.25, 0.75]) {
			await page.mouse.move(title.x + title.width * at, title.y + title.height / 2);
			await page.mouse.down();
			const pressed = await slider.getAttribute("aria-valuetext");
			await page.mouse.up();
			assert(pressed === levelShown, `a press on the level's name holds ${levelShown}, got ${pressed}`);
		}
		await waitUntil(async () => (await focused(page)).role === "slider", "the slider keeps the focus");
		const before = Number((await focused(page)).valueNow);
		await page.keyboard.press(before > 1 ? "ArrowLeft" : "ArrowRight");
		await waitUntil(async () => Number((await focused(page)).valueNow) !== before, "an arrow moves the slider");
		await page.keyboard.press("Tab");
		assert((await focused(page)).className.includes("model-pick-effort-model"), `Tab moves to the model's name, got ${JSON.stringify(await focused(page))}`);
		await page.keyboard.press("Enter");
		await waitUntil(async () => (await focused(page)).role === "option", "Enter on the name shows the models, focus on the one in use");
		assert((await focused(page)).text.includes("Claude Fake"), `focus lands on the model in use, got ${JSON.stringify(await focused(page))}`);
		await page.keyboard.press("End");
		assert((await focused(page)).text.includes("Mid Fake"), `End moves to the last model, got ${JSON.stringify(await focused(page))}`);
		await page.keyboard.press("Home");
		assert((await focused(page)).text.includes("Claude Fake"), `Home moves to the first, got ${JSON.stringify(await focused(page))}`);
		await page.keyboard.press("ArrowDown");
		assert((await focused(page)).text.includes("GPT Fake"), `ArrowDown moves to the next, got ${JSON.stringify(await focused(page))}`);
		await page.keyboard.press("Escape");
		await waitUntil(async () => (await page.locator(".model-pick-effort-title").count()) === 1, "Escape steps back to the effort view");
		await page.keyboard.press("Escape");
		await waitUntil(async () => (await page.locator(".model-pick-panel").count()) === 0, "a second Escape closes the panel");
		assert((await focused(page)).className.includes("model-pick-trigger"), `closing gives focus back to the control, got ${JSON.stringify(await focused(page))}`);
		await ctx.close();
		pass(`the panel's keys as ${platform.name}: Enter, arrows, Tab, Home, End, Escape back then closed, focus back on the control`);
	}

	// --- The phone's sheet keeps the keys through Try again ----------------------------------
	{
		const phoneCtx = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
		const phonePage = await phoneCtx.newPage();
		let refuseOptions = true;
		await phonePage.route(/\/model-options$/, (route) => (refuseOptions ? route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ error: "The models could not be read." }) }) : route.continue()));
		await enterRoom(phonePage, "Keys Room");
		await phonePage.locator(".model-pick-in-header .model-pick-trigger").click();
		const sheet = phonePage.locator(".model-pick-sheet");
		await sheet.waitFor({ timeout: 10000 });
		const toModels = sheet.locator(".model-pick-effort-model");
		if (await toModels.count()) await toModels.click();
		const retry = sheet.getByRole("button", { name: "Try again" });
		await retry.waitFor({ timeout: 10000 });
		await retry.focus();
		refuseOptions = false;
		await phonePage.keyboard.press("Enter");
		await sheet.locator(".model-pick-row").first().waitFor({ timeout: 10000 });
		await waitUntil(() => phonePage.evaluate(() => Boolean(document.activeElement?.closest(".model-pick-sheet"))), "focus stays in the sheet through Try again");
		await waitUntil(async () => (await focused(phonePage)).role === "option", "once the models are read, focus is on one of them");
		await phoneCtx.close();
		pass("on the phone, Try again by keyboard keeps focus in the sheet and lands on the models");
	}

	// --- The dial's words: the level's name as drawn, the chosen word lit -------------------
	{
		const widths = [
			{ name: "at desktop width", viewport: { width: 1440, height: 900 }, phone: false, size: "16px" },
			{ name: "in the phone's sheet", viewport: { width: 390, height: 844 }, phone: true, size: "17px" },
		];
		for (const theme of ["light", "dark"]) for (const width of widths) {
			const nameCtx = await browser.newContext({ viewport: width.viewport, ...(width.phone ? { isMobile: true, hasTouch: true } : {}) });
			await nameCtx.addInitScript((appearance) => { localStorage.setItem("exxperts.appearance", appearance); }, theme);
			const namePage = await nameCtx.newPage();
			await enterRoom(namePage, "Dial Room");
			await namePage.locator(width.phone ? ".model-pick-in-header .model-pick-trigger" : ".model-pick-trigger").first().click();
			await namePage.locator(`${width.phone ? ".model-pick-sheet " : ""}.model-pick-effort-title`).waitFor({ timeout: 10000 });
			const shown = await levelNameDrawn(namePage);
			assert(shown.fontSize === width.size && shown.fontWeight === "600", `the level's name ${width.name} in ${theme} is ${width.size} at 600, got ${JSON.stringify(shown)}`);
			assert(Math.abs(shown.variable - shown.staticBold) > 0.1, `the two faces set this name apart, got ${JSON.stringify(shown)}`);
			await waitUntil(async () => Math.abs((await levelNameDrawn(namePage)).width - shown.variable) < 0.1, `the level's name ${width.name} in ${theme} draws from the variable face, not the static Bold`);
			await assertLevelLit(namePage, String(await namePage.locator("[role=slider]").first().getAttribute("aria-valuetext")), `on opening ${width.name} in ${theme}`);
			await nameCtx.close();
		}
		pass("the level's name draws at 600 from the variable face, 16px at desktop and 17px in the phone's sheet, light and dark");

		const dialCtx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
		const dialPage = await dialCtx.newPage();
		await enterRoom(dialPage, "Dial Room");
		await dialPage.locator(".model-pick-trigger").first().click();
		const dialSlider = dialPage.locator(".model-pick-panel [role=slider]");
		await dialSlider.waitFor({ timeout: 10000 });
		const rungs = await dialPage.locator(".effort-dial-label").allInnerTexts();
		assert(rungs.length >= 3, `the dial has rungs to move over, got ${JSON.stringify(rungs)}`);
		const rungAt = async (word: string) => {
			const box = await dialPage.locator(".effort-dial-label").filter({ hasText: new RegExp(`^${word}$`) }).boundingBox();
			assert(box, `the word ${word} shows around the arc`);
			return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
		};
		const [first, second] = rungs;
		const beforeLast = rungs[rungs.length - 2]!;
		const last = rungs[rungs.length - 1]!;
		const lastAt = await rungAt(last);
		await dialPage.mouse.click(lastAt.x, lastAt.y);
		await assertLevelLit(dialPage, last, "after a click");
		await dialSlider.focus();
		await dialPage.keyboard.press("ArrowLeft");
		await assertLevelLit(dialPage, beforeLast, "after an arrow key");
		const firstAt = await rungAt(first!);
		const secondAt = await rungAt(second!);
		await dialPage.mouse.move(firstAt.x, firstAt.y);
		await dialPage.mouse.down();
		await assertLevelLit(dialPage, first!, "on a press");
		await dialPage.mouse.move(secondAt.x, secondAt.y);
		await assertLevelLit(dialPage, second!, "in the middle of a drag");
		await dialPage.mouse.up();
		await assertLevelLit(dialPage, second!, "after a drag");
		await dialPage.keyboard.press("Escape");
		await waitUntil(async () => (await dialPage.locator(".model-pick-panel").count()) === 0, "the panel closes");
		pass("the chosen level's word alone is lit after a click, an arrow key and a drag");

		const releaseDial = holdAnswers();
		const dialComposer = dialPage.locator("textarea").first();
		await dialComposer.fill("A question held while a pick waits.");
		await dialComposer.press("Enter");
		await dialPage.locator(".stop-btn").waitFor({ timeout: 15000 });
		await pick(dialPage, "GPT Fake");
		await dialPage.locator(".model-pick-trigger").first().click();
		await dialSlider.waitFor({ timeout: 10000 });
		// The held model's options arrive after the panel opens and carry the room's level, the one the drag picked.
		await assertLevelLit(dialPage, second!, "while a pick waits");
		releaseDial();
		await dialPage.getByText("Continued on GPT Fake", { exact: true }).waitFor({ timeout: 15000 });
		await dialCtx.close();
		pass("while a pick waits, the chosen word stays lit");
	}

	// --- The dial's arc and needle: the colours on screen, then the motion ------------------
	{
		// A share of the arc clear of the ticks on every ladder here, and clear of a knob at the top.
		const shares = [0.06, 0.45, 0.93];
		const knobReach = 0.04;
		const cases = [
			{ name: "Low on five rungs", rungs: ["Low", "Medium", "High", "Extra high", "Max"], at: 0 },
			{ name: "Max on five rungs", rungs: ["Low", "Medium", "High", "Extra high", "Max"], at: 4 },
			{ name: "the top of two rungs", rungs: ["Low", "High"], at: 1 },
			{ name: "the bottom of two rungs", rungs: ["Low", "High"], at: 0 },
			{ name: "the third of six rungs", rungs: ["Minimal", "Low", "Medium", "High", "Extra high", "Max"], at: 2 },
		];
		for (const theme of ["light", "dark"]) for (const { name, rungs, at } of cases) {
			const arcCtx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
			await arcCtx.addInitScript((appearance) => { localStorage.setItem("exxperts.appearance", appearance); }, theme);
			const arcPage = await arcCtx.newPage();
			const ladder = rungs.map((label) => ({ level: label.toLowerCase().replace(" ", ""), label }));
			await arcPage.routeWebSocket(/\/ws\?/, (ws) => {
				const room = ws.connectToServer();
				room.onMessage((message) => {
					const frame = typeof message === "string" ? JSON.parse(message) : null;
					if (!frame?.effort) return ws.send(message);
					frame.effort = { ...frame.effort, level: ladder[at]!.level, ladder };
					ws.send(JSON.stringify(frame));
				});
				ws.onMessage((message) => room.send(message));
			});
			await enterRoom(arcPage, "Spring Room");
			await arcPage.locator(".model-pick-trigger").first().click();
			await arcPage.locator(".model-pick-panel [role=slider]").waitFor({ timeout: 10000 });
			await assertLevelLit(arcPage, rungs[at]!, `${name} in ${theme}`);
			await waitUntil(async () => (await needle(arcPage)).running === 0, "the dial is at rest");
			const tokens = await dialTokens(arcPage);
			const panel = cssColour(tokens.panel).rgb;
			const track = mixed(cssColour(tokens.text).rgb, panel, 0.12);
			const knobShare = at / (rungs.length - 1);
			const seen = await arcPixels(arcPage, shares);
			shares.forEach((share, i) => {
				const wanted = share < knobShare - knobReach ? rampAt(share, tokens) : track;
				assert(closeTo(seen.arc[i]!, wanted), `${name} in ${theme}: the arc at ${share} shows ${seen.arc[i]}, wanted ${wanted.map(Math.round)}`);
			});
			assert(closeTo(seen.ring, rampAt(knobShare, tokens)), `${name} in ${theme}: the knob's ring shows ${seen.ring}, wanted ${rampAt(knobShare, tokens).map(Math.round)}`);
			await arcCtx.close();
		}
		pass("the arc deepens from Low to Max as far as the knob, grey past it, on two to six rungs, light and dark");

		// Records each motion the dial starts and holds it there; on a reduced-motion page the record stays empty.
		const recordDialMotion = () => {
			(window as any).dialMotion = [];
			for (const kind of ["transitionrun", "animationstart"]) document.addEventListener(kind, (event) => {
				const dial = event.target as Element;
				if (!dial.classList?.contains("effort-dial")) return;
				(window as any).dialMotion.push(kind);
				for (const motion of dial.getAnimations()) motion.pause();
			}, true);
		};
		const atRest = async (page: Page, moment: string) => {
			const { angle, running } = await needle(page);
			const rest = await restAngle(page);
			assert(running === 0 && Math.abs(angle - rest) < 0.5, `${moment}: the needle rests at ${rest}, got ${angle} with ${running} running`);
		};

		const springCtx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
		await springCtx.addInitScript(recordDialMotion);
		const springPage = await springCtx.newPage();
		await enterRoom(springPage, "Spring Room");
		await springPage.locator(".model-pick-trigger").first().click();
		const springSlider = springPage.locator(".model-pick-panel [role=slider]");
		await springSlider.waitFor({ timeout: 10000 });
		await afterTwoFrames(springPage);
		await atRest(springPage, "on opening");
		assert((await dialMotionLog(springPage)).length === 0, `the panel opens with the needle at rest, got ${await dialMotionLog(springPage)}`);

		// A swing passes its rung, comes back and ends on it.
		const swung = async (moment: string, from: number) => {
			const { ms, angles } = await walkDialMotion(springPage, moment);
			const rest = await restAngle(springPage);
			const up = Math.sign(rest - from);
			const past = Math.max(...angles.map((angle) => (angle - rest) * up));
			assert(ms > 0 && ms < 500, `${moment}: the swing takes under half a second, got ${ms}`);
			assert(Math.abs(angles[0]! - from) < 1, `${moment}: the swing starts where the needle stood, ${from}, got ${angles[0]}`);
			assert(past > 1, `${moment}: the needle swings past its rung, got ${past} degrees`);
			await atRest(springPage, `${moment}, at the end`);
			return past;
		};
		await springSlider.focus();
		if ((await springSlider.getAttribute("aria-valuenow")) !== "1") {
			await springPage.keyboard.press("Home");
			await walkDialMotion(springPage, "going to the first rung");
		}
		await springPage.keyboard.press("ArrowRight");
		await swung("after an arrow key", -115);
		const words = await springPage.locator(".effort-dial-label").allInnerTexts();
		const wordAt = async (page: Page, word: string) => {
			const box = await page.locator(".effort-dial-label").filter({ hasText: new RegExp(`^${word}$`) }).boundingBox();
			assert(box, `the word ${word} shows around the arc`);
			return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
		};
		const fromSecond = await restAngle(springPage);
		const lastWord = await wordAt(springPage, words[words.length - 1]!);
		await springPage.mouse.click(lastWord.x, lastWord.y);
		const pastEnd = await swung("after a click on the last rung", fromSecond);
		assert(pastEnd < 5, `at the arc's end the swing stops short of the word beside it, got ${pastEnd} degrees past`);
		await springPage.keyboard.press("Home");
		await swung("after the Home key over the whole arc", 115);
		const springTokens = await dialTokens(springPage);
		await springPage.keyboard.press("End");
		await waitUntil(async () => (await needle(springPage)).running > 0, "the End key starts a swing");
		await needle(springPage, 200);
		const [pastTop] = (await arcPixels(springPage, [0.06])).arc;
		assert(closeTo(pastTop!, rampAt(0.06, springTokens)), `while the swing is past the top the arc's start stays filled, got ${pastTop}, wanted ${rampAt(0.06, springTokens).map(Math.round)}`);
		await walkDialMotion(springPage, "after the End key");

		// A drag: the press swings, each rung crossed is on the pointer at once, the release
		// settles the way the drag was going, here upwards from below the level it had.
		const firstWord = await wordAt(springPage, words[0]!);
		const secondWord = await wordAt(springPage, words[1]!);
		const thirdWord = await wordAt(springPage, words[2]!);
		await springPage.mouse.move(firstWord.x, firstWord.y);
		await springPage.mouse.down();
		await springPage.mouse.move(secondWord.x, secondWord.y);
		await waitUntil(async () => (await springSlider.getAttribute("aria-valuenow")) === "2", "the drag reaches the second rung");
		await atRest(springPage, "in the middle of a drag, on the second rung");
		await springPage.mouse.move(thirdWord.x, thirdWord.y);
		await waitUntil(async () => (await springSlider.getAttribute("aria-valuenow")) === "3", "the drag reaches the third rung");
		await atRest(springPage, "in the middle of a drag, on the third rung");
		await afterTwoFrames(springPage);
		await atRest(springPage, "still in the drag, two frames on");
		const movesInDrag = (await dialMotionLog(springPage)).length;
		await springPage.mouse.up();
		const settle = await walkDialMotion(springPage, "at the end of a drag");
		const rung = await restAngle(springPage);
		// The way it first leaves the rung: a settle also swings back a little the other way.
		const firstLeaves = (angles: number[], from: number) => (angles.find((angle) => Math.abs(angle - from) > 1) ?? from) - from;
		assert(settle.ms > 0 && settle.ms < 500, `the settle takes under half a second, got ${settle.ms}`);
		assert(firstLeaves(settle.angles, rung) > 0 && Math.abs(settle.angles[0]! - rung) < 0.5, `the drag ended rising: the needle leaves its rung upwards and comes back, got ${settle.angles.slice(0, 12)}`);
		await atRest(springPage, "after the settle");
		assert((await dialMotionLog(springPage)).length === movesInDrag + 1, `the release starts one motion, got ${await dialMotionLog(springPage)}`);
		await springPage.mouse.move(thirdWord.x, thirdWord.y);
		await springPage.mouse.down();
		await springPage.mouse.move(secondWord.x, secondWord.y);
		await waitUntil(async () => (await springSlider.getAttribute("aria-valuenow")) === "2", "a falling drag reaches the second rung");
		await springPage.mouse.up();
		const fall = await walkDialMotion(springPage, "at the end of a falling drag");
		const lower = await restAngle(springPage);
		assert(firstLeaves(fall.angles, lower) < 0, `the drag ended falling: the needle leaves its rung downwards, got ${fall.angles.slice(0, 12)}`);
		await springCtx.close();
		pass("the needle stands at rest on opening, swings under half a second on a key or a click, stays with a drag and settles at its end");

		const stillCtx = await browser.newContext({ viewport: { width: 1440, height: 900 }, reducedMotion: "reduce" });
		await stillCtx.addInitScript(recordDialMotion);
		const stillPage = await stillCtx.newPage();
		await enterRoom(stillPage, "Spring Room");
		await stillPage.locator(".model-pick-trigger").first().click();
		const stillSlider = stillPage.locator(".model-pick-panel [role=slider]");
		await stillSlider.waitFor({ timeout: 10000 });
		const stands = async (moment: string, valueNow: string) => {
			await waitUntil(async () => (await stillSlider.getAttribute("aria-valuenow")) === valueNow, `${moment}: the slider says rung ${valueNow}`);
			await atRest(stillPage, moment);
			await afterTwoFrames(stillPage);
			await atRest(stillPage, `${moment}, two frames on`);
			assert((await dialMotionLog(stillPage)).length === 0, `${moment}: no motion on a reduced-motion page, got ${await dialMotionLog(stillPage)}`);
		};
		await stillSlider.focus();
		await stillPage.keyboard.press("Home");
		await stands("after the Home key", "1");
		await stillPage.keyboard.press("ArrowRight");
		await stands("after an arrow key", "2");
		const stillLast = await wordAt(stillPage, words[words.length - 1]!);
		await stillPage.mouse.click(stillLast.x, stillLast.y);
		await stands("after a click", String(words.length));
		const stillFirst = await wordAt(stillPage, words[0]!);
		const stillSecond = await wordAt(stillPage, words[1]!);
		await stillPage.mouse.move(stillFirst.x, stillFirst.y);
		await stillPage.mouse.down();
		await stands("on a press", "1");
		await stillPage.mouse.move(stillSecond.x, stillSecond.y);
		await stands("in a drag", "2");
		await stillPage.mouse.up();
		await stands("after a drag", "2");
		await stillCtx.close();
		pass("a page that asks for reduced motion jumps straight to rest, on a key, a click and a drag");
	}

	// --- The ring's number is readable in every state, theme and width ----------------------
	// Each state comes from the room's own frames: the ready frame's reading is set to the
	// zone's, held back for the empty ring, and the socket is cut for offline.
	{
		const zones = [{ zone: "green", percent: 12 }, { zone: "yellow", percent: 85 }, { zone: "red", percent: 97 }, { zone: "unknown", percent: null }];
		const widths = [{ name: "under the box", viewport: { width: 1280, height: 900 }, phone: false }, { name: "in the phone's box", viewport: { width: 390, height: 844 }, phone: true }];
		const readings: Array<{ where: string; ratio: number }> = [];
		for (const theme of ["dark", "light"]) for (const width of widths) {
			const ringCtx = await browser.newContext({ viewport: width.viewport, ...(width.phone ? { isMobile: true, hasTouch: true } : {}) });
			await ringCtx.addInitScript((appearance) => { localStorage.setItem("exxperts.appearance", appearance); }, theme);
			const ringPage = await ringCtx.newPage();
			await ringPage.clock.install();
			let reading: { zone: string; percent: number | null } | "held" = zones[0];
			let cut = false;
			const live: WebSocketRoute[] = [];
			await ringPage.routeWebSocket(/\/ws\?/, (ws) => {
				if (cut) {
					void ws.close({ code: 4000, reason: "down" }).catch(() => {});
					return;
				}
				const room = ws.connectToServer();
				live.push(ws, room);
				room.onMessage((message) => {
					const frame = typeof message === "string" ? JSON.parse(message) : null;
					if (frame?.type !== "ready") return ws.send(message);
					if (reading === "held") return;
					const { zone, percent } = reading;
					const checkpointTokens = frame.contextHealth?.checkpointTokens ?? 100000;
					frame.contextHealth = { ...frame.contextHealth, checkpointTokens, tokens: percent == null ? null : Math.round((checkpointTokens * percent) / 100), checkpointPercent: percent, zone };
					ws.send(JSON.stringify(frame));
				});
				ws.onMessage((message) => room.send(message));
			});
			const where = width.phone ? ".composer-box" : ".composer-under-row";
			const measure = async (state: string, selector: string) => {
				await ringPage.locator(`${where} ${selector}`).first().waitFor({ timeout: 15000 });
				const ratio = await pillContrast(ringPage, `${where} ${selector}`);
				readings.push({ where: `${theme} ${width.name} ${state}`, ratio });
			};
			const open = async () => {
				await ringPage.goto(`${baseUrl}/auth/session?token=${SMOKE_AUTH_TOKEN}`);
				await ringPage.waitForLoadState("networkidle");
				const dismiss = ringPage.locator(".whats-new-close");
				if (await dismiss.count()) await dismiss.click();
				await ringPage.locator(".persistent-agent-card").filter({ hasText: "Keys Room" }).getByRole("button", { name: /Enter|Resume/ }).click();
			};
			reading = "held";
			await open();
			await measure("waiting", ".composer-context-waiting.unknown");
			for (const zone of zones) {
				reading = zone;
				await open();
				await measure(zone.zone, `.composer-context-pill.${zone.zone}:not(.composer-context-waiting)`);
				if (!width.phone) {
					await ringPage.locator(`${where} .composer-context-pill`).first().hover();
					await measure(`${zone.zone} on hover`, `.composer-context-pill.${zone.zone}:hover`);
					await ringPage.mouse.move(0, 0);
				}
			}
			// The socket drops: the empty ring while it reconnects, then the word Offline once it gives up.
			cut = true;
			for (const ws of live.splice(0)) void ws.close({ code: 4000, reason: "down" }).catch(() => {});
			await measure("reconnecting", ".composer-context-waiting.unknown");
			await ringPage.clock.fastForward(10 * 60_000);
			const offlineLabel = ringPage.locator(`${where} .composer-context-waiting.offline .composer-context-pill-label`).first();
			await waitUntil(async () => (await offlineLabel.innerText().catch(() => "")) === "Offline", `${theme} ${width.name}: the pill says Offline once reconnecting gives up`, 20000);
			await measure("offline", ".composer-context-waiting.offline");
			await ringCtx.close();
		}
		const shown = (list: typeof readings) => list.map(({ where, ratio }) => `${where}: ${ratio.toFixed(2)}:1`).join("; ");
		const low = readings.filter(({ ratio }) => ratio < 4.5);
		assert(low.length === 0, `the ring's number reaches 4.5:1 in every state, got ${shown(low)}`);
		pass(`the ring's number reaches 4.5:1 in every state, theme and width (${shown(readings)})`);
	}

	const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
	const page = await ctx.newPage();
	let refuseOptions = false;
	await page.route(/\/model-options$/, (route) => (refuseOptions ? route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ error: "The models could not be read." }) }) : route.continue()));
	const effortFrames: Array<{ level?: string; explicit?: boolean }> = [];
	page.on("websocket", (ws) => ws.on("framesent", (frame) => {
		try { const msg = JSON.parse(String(frame.payload)); if (msg?.type === "effort") effortFrames.push(msg); } catch {}
	}));
	await enterRoom(page, "Pick Room");
	await sendAndWait(page, "First question on Claude.", "Answer from claude-fake.");
	assert((await triggerName(page)) === "Claude Fake", `the control names the model in use, got ${await triggerName(page)}`);

	// --- An effort pick goes out explicit and becomes the room's default -------------------
	await page.locator(".model-pick-trigger").first().click();
	const slider = page.locator(".model-pick-panel [role=slider]");
	await slider.waitFor({ timeout: 10000 });
	await slider.focus();
	await page.keyboard.press("Home");
	await page.keyboard.press("ArrowRight");
	const picked = await slider.getAttribute("aria-valuetext");
	await waitUntil(() => effortFrames.length >= 1, "the pick goes out on the room's socket");
	assert(effortFrames.every((frame) => frame.explicit === true), `every effort the page sends is marked explicit, got ${JSON.stringify(effortFrames)}`);
	const lastLevel = effortFrames[effortFrames.length - 1]!.level;
	await waitUntil(async () => (await api(`/api/persistent-agents/${pickId}/models`)).body?.effort === lastLevel, `the room's default becomes ${lastLevel}`);
	await page.keyboard.press("Escape");
	pass(`an effort pick (${picked}) goes out explicit and becomes the room's default for new conversations`);

	// --- A pick while the room answers applies to the next answer --------------------------
	const release = holdAnswers();
	const composer = page.locator("textarea").first();
	await composer.fill("Second question, held on Claude.");
	await composer.press("Enter");
	await page.locator(".stop-btn").waitFor({ timeout: 15000 });
	await pick(page, "GPT Fake");
	assert((await triggerName(page)) === "GPT Fake", `the control shows the pick at once, got ${await triggerName(page)}`);
	assert((await continuedLines(page).count()) === 0, "the switch waits for the answer to end");
	// A message typed meanwhile, sent the moment the answer ends.
	await composer.fill("Third question, sent as the answer ends.");
	release();
	await waitUntil(async () => (await page.locator(".stop-btn").count()) === 0, "the held answer ended");
	await composer.press("Enter");
	await page.getByText("Continued on GPT Fake", { exact: true }).waitFor({ timeout: 15000 });
	// The page held the message until the switch landed: it goes now if it stayed in the box.
	if ((await composer.inputValue()).trim()) {
		await waitUntil(async () => !(await page.locator('button[title="Send"]').first().isDisabled()), "Send is back once the switch landed");
		await composer.press("Enter");
	}
	await page.getByText("Answer from gpt-fake.").waitFor({ timeout: 20000 });
	const held = requests.filter((request) => request.asked.includes("Second question, held"));
	const third = requests.filter((request) => request.asked.includes("Third question, sent as the answer ends"));
	assert(held.length > 0 && held.every((request) => request.model === CLAUDE.model), `the held answer ran on Claude, got ${JSON.stringify(held.map((r) => r.model))}`);
	pass("a pick while the room answers shows at once and applies to the next answer");
	assert(third.length > 0 && third.every((request) => request.model === GPT.model), `the message sent as the answer ended is answered by GPT, got ${JSON.stringify(third.map((r) => r.model))}`);
	pass("a message sent right as the answer ends is answered by the picked model");
	await waitUntil(async () => (await page.locator(".stop-btn").count()) === 0, "the answer on GPT ended");

	// --- Two switches with no message between: one line, also after a reload ---------------
	await pick(page, "Claude Fake");
	await page.getByText("Continued on Claude Fake", { exact: true }).waitFor({ timeout: 15000 });
	await pick(page, "GPT Fake");
	await waitUntil(async () => (await page.getByText("Continued on Claude Fake", { exact: true }).count()) === 0 && (await continuedLines(page).count()) === 2, "the second switch takes the first one's line");
	const savedLines = async () => {
		const status = (await api(`/api/persistent-agents/${pickId}/status`)).body;
		const thread = (await api(`/api/persistent-agents/${pickId}/threads/${status.runtime.activeThreadId}`)).body.thread;
		return (thread?.items ?? []).map((item: any) => String(item.text ?? "")).filter((text: string) => /^Continued on /.test(text));
	};
	await waitUntil(async () => {
		const lines = await savedLines();
		return lines.length === 2 && lines.every((text: string) => text === "Continued on GPT Fake");
	}, "the saved conversation holds the second switch's line in place of the first");
	await enterRoom(page, "Pick Room");
	await page.getByText("Answer from gpt-fake.").waitFor({ timeout: 15000 });
	const afterReload = await continuedLines(page).allInnerTexts();
	assert(afterReload.length === 2 && afterReload.every((text) => text === "Continued on GPT Fake"), `after a reload the two switches leave one line beside the earlier one, got ${JSON.stringify(afterReload)}`);
	pass("two switches with no message between leave one line, also after a reload");

	// --- A switch written whose answer is lost: the page takes what is stored ----------------
	{
		const lostCtx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
		const lostPage = await lostCtx.newPage();
		// The server writes the switch; its answer and its socket frame never reach the page.
		let loseSwitch = false;
		let failReads = 0;
		let failedReads = 0;
		await lostPage.routeWebSocket(/\/ws\?/, (ws) => {
			const room = ws.connectToServer();
			room.onMessage((message) => {
				if (loseSwitch && typeof message === "string" && message.includes('"type":"model_switched"')) return;
				ws.send(message);
			});
			ws.onMessage((message) => room.send(message));
		});
		await lostPage.route(/\/switch-model$/, async (route) => {
			if (!loseSwitch) return route.continue();
			await route.fetch();
			await route.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ error: "The switch's answer was lost." }) });
		});
		await lostPage.route(new RegExp(`/api/persistent-agents/${lostId}/threads/[^/?]+$`), async (route) => {
			if (route.request().method() !== "GET" || failedReads >= failReads) return route.continue();
			failedReads += 1;
			await route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ error: "Unavailable." }) });
		});
		const storedLost = async () => {
			const status = (await api(`/api/persistent-agents/${lostId}/status`)).body;
			return (await api(`/api/persistent-agents/${lostId}/threads/${status.runtime.activeThreadId}`)).body.thread;
		};
		const lostSend = lostPage.locator('button[title="Send"]').first();
		await enterRoom(lostPage, "Lost Room");
		await sendAndWait(lostPage, "First question in the lost room.", "Answer from claude-fake.");
		await pick(lostPage, "GPT Fake");
		await lostPage.getByText("Continued on GPT Fake", { exact: true }).waitFor({ timeout: 15000 });
		loseSwitch = true;
		await pick(lostPage, "Claude Fake");
		await lostPage.getByText("The switch's answer was lost.").waitFor({ timeout: 15000 });
		await waitUntil(async () => (await triggerName(lostPage)) === "Claude Fake", "the page shows the model the conversation is stored on");
		await waitUntil(async () => (await continuedLines(lostPage).allInnerTexts()).join("|") === "Continued on Claude Fake", "the page shows the stored line in place of the one it replaced");
		loseSwitch = false;
		const lostComposer = lostPage.locator("textarea").first();
		await lostComposer.fill("Second question after the lost answer.");
		await waitUntil(async () => !(await lostSend.isDisabled()), "Send is back once the stored conversation is read");
		await lostComposer.press("Enter");
		await waitUntil(async () => {
			const thread = await storedLost();
			return (thread?.items ?? []).some((item: any) => item.kind === "user" && String(item.text).includes("Second question after the lost answer.")) && (await lostPage.locator(".stop-btn").count()) === 0;
		}, "the next message is saved");
		await waitUntil(async () => {
			const lines = ((await storedLost())?.items ?? []).map((item: any) => String(item.text ?? "")).filter((text: string) => /^Continued on /.test(text));
			return lines.join("|") === "Continued on Claude Fake";
		}, "the page's next save keeps the stored line and never brings back the one it replaced");
		pass("a switch whose answer is lost: the page shows the stored model and line, and its next save keeps them");

		loseSwitch = true;
		failReads = 3;
		failedReads = 0;
		await lostComposer.fill("Third question, typed while the outcome is unknown.");
		await pick(lostPage, "GPT Fake");
		await waitUntil(() => failedReads >= 1, "the page asks for the stored conversation");
		assert(await lostSend.isDisabled(), "Send waits while the page cannot tell which model the conversation is on");
		await waitUntil(() => failedReads >= 3, "the page asks again while the read fails");
		assert(await lostSend.isDisabled(), "Send still waits after failed reads");
		await waitUntil(async () => (await triggerName(lostPage)) === "GPT Fake" && !(await lostSend.isDisabled()), "once a read lands, the stored model shows and Send is back");
		await waitUntil(async () => (await continuedLines(lostPage).allInnerTexts()).at(-1) === "Continued on GPT Fake", "the page shows the line the switch wrote");
		const keptLines = ((await storedLost())?.items ?? []).map((item: any) => String(item.text ?? "")).filter((text: string) => /^Continued on /.test(text));
		assert(keptLines.at(-1) === "Continued on GPT Fake", `no save while the reads failed took the switch's line away, got ${JSON.stringify(keptLines)}`);
		loseSwitch = false;
		pass("a lost switch answer whose reads fail holds Send until a read lands, then shows the stored model");

		// Leaving while the reads still fail: the page's last save on the way out keeps the switch's line too.
		loseSwitch = true;
		failReads = 1000;
		failedReads = 0;
		await pick(lostPage, "Claude Fake");
		await waitUntil(() => failedReads >= 1, "the page asks for the stored conversation");
		await lostPage.goto(`${baseUrl}/auth/session?token=${SMOKE_AUTH_TOKEN}`);
		await lostPage.locator(".persistent-agent-card").first().waitFor({ timeout: 15000 });
		failReads = 0;
		loseSwitch = false;
		// The room list's row carries the lock; once it is free the page's way out, its last save included, is over.
		await waitUntil(async () => {
			const listed = (await api("/api/persistent-agents")).body;
			const row = (Array.isArray(listed) ? listed : listed?.agents ?? []).find((room: any) => room.id === lostId);
			return Boolean(row) && !row.activeLock;
		}, "the room is free again");
		const leftLines = ((await storedLost())?.items ?? []).map((item: any) => String(item.text ?? "")).filter((text: string) => /^Continued on /.test(text));
		assert(leftLines.at(-1) === "Continued on Claude Fake", `no save on the way out took the switch's line away, got ${JSON.stringify(leftLines)}`);
		await lostCtx.close();
		pass("leaving while the reads fail: the save on the way out keeps the switch's line");
	}

	// --- Picking the model an empty conversation shows keeps it there ------------------------
	{
		const pinCtx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
		const pinPage = await pinCtx.newPage();
		await enterRoom(pinPage, "Pin Room");
		await openModels(pinPage);
		const pinned = pinPage.waitForResponse((response) => response.url().endsWith("/switch-model") && response.request().method() === "POST");
		await pinPage.locator(".model-pick-panel .model-pick-row").filter({ hasText: "Claude Fake" }).click();
		assert((await pinned).status() === 200, "the pick of the model shown goes to the room");
		for (let i = 0; i < 2; i++) if (await pinPage.locator(".model-pick-panel").count()) await pinPage.keyboard.press("Escape");
		const repick = await api(`/api/persistent-agents/${pinId}/models`, { method: "PUT", body: JSON.stringify({ conversation: GPT }) });
		assert(repick.status === 200, `the room's default changes, got ${repick.status}`);
		const before = requests.length;
		await pinPage.locator("textarea").first().fill("The first question, after the room's default moved.");
		await pinPage.locator("textarea").first().press("Enter");
		// A conversation's first message carries the room's state after it, so the request is matched on its whole body.
		await waitUntil(() => requests.slice(before).some((request) => request.raw.includes("after the room's default moved")), "the first question reaches a model");
		const asked = requests.slice(before).filter((request) => request.raw.includes("after the room's default moved"));
		assert(asked.every((request) => request.model === CLAUDE.model), `the empty conversation keeps the model picked for it, got ${JSON.stringify(asked.map((request) => request.model))}`);
		await waitUntil(async () => (await pinPage.locator(".stop-btn").count()) === 0, "the answer ended");
		await pinCtx.close();
		pass("picking the model an empty conversation shows keeps it there when the room's default moves");
	}

	// --- A press on the rung shown is a pick, even where it stands for another level -------
	{
		const put = await api(`/api/persistent-agents/${clampId}/models`, { method: "PUT", body: JSON.stringify({ effort: "minimal" }) });
		assert(put.status === 200 && put.body?.effort === "minimal", `the room's default is set to minimal, got ${put.status} ${JSON.stringify(put.body)}`);
		const clampCtx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
		const clampPage = await clampCtx.newPage();
		await enterRoom(clampPage, "Clamp Room");
		await clampPage.locator(".model-pick-trigger").first().click();
		const clampSlider = clampPage.locator(".model-pick-panel [role=slider]");
		await clampSlider.waitFor({ timeout: 10000 });
		assert(/^low$/i.test(String(await clampSlider.getAttribute("aria-valuetext"))), `minimal shows on Claude's Low rung, got ${await clampSlider.getAttribute("aria-valuetext")}`);
		await clampPage.locator(".model-pick-panel .effort-slider-thumb").click();
		await waitUntil(async () => (await api(`/api/persistent-agents/${clampId}/models`)).body?.effort === "low", "a press on the Low rung shown picks Low: the room's default becomes low");
		await clampCtx.close();
		pass("a press on the rung shown picks it, also where it stood for another stored level");
	}

	// --- Too long for a model: the window, Remember and the new conversation on it ---------
	const optionsOf = async (agentId: string) => {
		const status = (await api(`/api/persistent-agents/${agentId}/status`)).body;
		const read = await api(`/api/persistent-agents/${agentId}/threads/${status.runtime.activeThreadId}/model-options`);
		assert(read.status === 200, `the panel's read answers, got ${read.status} ${JSON.stringify(read.body)}`);
		return read.body.models.find((row: any) => row.model === MID.model) as { fits: boolean; freshFits: boolean };
	};
	// The smallest window a new conversation of this room fits, by the panel's own read, with room for the entry the save adds.
	const fitMidToFreshConversation = async (agentId: string) => {
		let low = 1_000;
		let high = 200_000;
		writeModels(providerPort, low);
		assert(!(await optionsOf(agentId)).freshFits, "the search starts below what a new conversation needs");
		while (high - low > 100) {
			const middle = Math.floor((low + high) / 2);
			writeModels(providerPort, middle);
			if ((await optionsOf(agentId)).freshFits) high = middle; else low = middle;
		}
		writeModels(providerPort, high + 1500);
	};
	// Long messages until this conversation no longer fits the mid model.
	const outgrowMid = async (agentId: string) => {
		for (let round = 0; round < 8 && (await optionsOf(agentId)).fits; round++) {
			const answers = await page.locator(".messages").getByText(/^Answer from /).count();
			const composer = page.locator("textarea").first();
			await composer.fill(`Long message ${round}: ${"words to read ".repeat(4000)}`);
			await composer.press("Enter");
			await waitUntil(async () => (await page.locator(".messages").getByText(/^Answer from /).count()) > answers && (await page.locator(".stop-btn").count()) === 0, `the long message ${round} is answered`);
		}
		const mid = await optionsOf(agentId);
		assert(!mid.fits && mid.freshFits, `this conversation is too long for the mid model while a new one fits, got ${JSON.stringify(mid)}`);
	};
	await fitMidToFreshConversation(pickId);
	await outgrowMid(pickId);
	await openModels(page);
	const midRow = page.locator(".model-pick-panel .model-pick-row").filter({ hasText: "Mid Fake" });
	assert((await midRow.innerText()).includes("New conversation"), `the mid model is marked for a new conversation, got ${await midRow.innerText()}`);
	await midRow.click();
	const switchWindow = page.getByRole("dialog", { name: "Switch to Mid Fake?" });
	await switchWindow.waitFor({ timeout: 10000 });
	assert((await switchWindow.getByRole("heading").innerText()) === "Switch to Mid Fake?", `a window that can switch asks it, got ${await switchWindow.getByRole("heading").innerText()}`);
	assert((await switchWindow.innerText()).includes("This conversation is too long for Mid Fake. Remember it first, then continue in a new conversation on Mid Fake."), `the window says why, got ${await switchWindow.innerText()}`);
	await switchWindow.getByRole("button", { name: "Remember and switch" }).click();
	const save = page.getByRole("button", { name: "Save to memory" });
	const keepChatting = page.getByRole("button", { name: "Keep chatting" });
	await waitUntil(async () => (await save.count()) > 0 || (await keepChatting.count()) > 0, "Remember shows its review", 40_000);
	if (await save.count()) await save.click();
	await keepChatting.waitFor({ timeout: 30000 });
	await keepChatting.click();
	await waitUntil(async () => (await triggerName(page)) === "Mid Fake", "the new conversation runs on the picked model");
	const freshLines = await continuedLines(page).allInnerTexts();
	assert(freshLines.length === 1 && freshLines[0] === "Continued on Mid Fake", `the new conversation's one line says where it continued, got ${JSON.stringify(freshLines)}`);
	const freshStatus = (await api(`/api/persistent-agents/${pickId}/status`)).body;
	const fresh = (await api(`/api/persistent-agents/${pickId}/threads/${freshStatus.runtime.activeThreadId}`)).body.thread;
	assert(fresh.model.model === MID.model && fresh.items.filter((item: any) => /^Continued on /.test(String(item.text))).length === 1, `the saved new conversation is on the mid model with one line, got ${JSON.stringify({ model: fresh.model, items: fresh.items })}`);
	await sendAndWait(page, "First question in the new conversation.", "Answer from mid-fake.");
	pass("too long for a model: the window, Remember and switch, and the new conversation runs on it with one Continued on line");

	// --- A room this save would fill offers Remember only ---------------------------------
	writeModels(providerPort, 200000);
	await enterRoom(page, "Full Room");
	await pick(page, "GPT Fake");
	await page.getByText("Continued on GPT Fake", { exact: true }).waitFor({ timeout: 15000 });
	await fitMidToFreshConversation(fullId);
	await outgrowMid(fullId);
	await openModels(page);
	await page.locator(".model-pick-panel .model-pick-row").filter({ hasText: "Mid Fake" }).click();
	const fullWindow = page.getByRole("dialog", { name: "Mid Fake needs a new conversation" });
	await fullWindow.waitFor({ timeout: 10000 });
	assert((await fullWindow.getByRole("heading").innerText()) === "Mid Fake needs a new conversation", `a window that cannot switch asks no switch question, got ${await fullWindow.getByRole("heading").innerText()}`);
	assert((await fullWindow.getByRole("button", { name: "Remember and switch" }).count()) === 0 && (await fullWindow.getByRole("button", { name: "Remember", exact: true }).count()) === 1 && (await fullWindow.getByRole("button", { name: "Cancel" }).count()) === 1, `a room this save fills offers Cancel and Remember only, got ${await fullWindow.innerText()}`);
	assert((await fullWindow.innerText()).includes("This save fills Full Room: it will hold 20 conversations, as many as it can."), `the window says Remember's own sentence, got ${await fullWindow.innerText()}`);
	await fullWindow.getByRole("button", { name: "Cancel" }).click();
	await waitUntil(async () => (await fullWindow.count()) === 0, "Cancel closes the window");
	assert((await triggerName(page)) === "GPT Fake", `Cancel switches nothing, got ${await triggerName(page)}`);
	pass("a room this save would fill offers Remember only, and Cancel switches nothing");

	// --- Remember and switch, cancelled, then cut by a reload --------------------------------
	writeModels(providerPort, 200000);
	await enterRoom(page, "Cancel Room");
	await pick(page, "GPT Fake");
	await page.getByText("Continued on GPT Fake", { exact: true }).waitFor({ timeout: 15000 });
	const startRememberAndSwitch = async () => {
		await fitMidToFreshConversation(cancelId);
		await outgrowMid(cancelId);
		await openModels(page);
		await page.locator(".model-pick-panel .model-pick-row").filter({ hasText: "Mid Fake" }).click();
		const ask = page.getByRole("dialog", { name: "Switch to Mid Fake?" });
		await ask.waitFor({ timeout: 10000 });
		await ask.getByRole("button", { name: "Remember and switch" }).click();
	};
	const generateButton = page.getByRole("button", { name: /^(Generate again|Generate memory proposal|Try again)$/ });
	const saveAndKeepChatting = async () => {
		const saveButton = page.getByRole("button", { name: "Save to memory" });
		const keep = page.getByRole("button", { name: "Keep chatting" });
		await waitUntil(async () => (await saveButton.count()) > 0 || (await keep.count()) > 0, "Remember shows its review", 40_000);
		if (await saveButton.count()) await saveButton.click();
		await keep.waitFor({ timeout: 30000 });
		await keep.click();
	};
	let releaseRemember = holdRemember();
	await startRememberAndSwitch();
	const cancelRead = page.getByRole("button", { name: "Cancel", exact: true });
	await cancelRead.waitFor({ timeout: 15000 });
	await cancelRead.click();
	releaseRemember();
	await generateButton.waitFor({ timeout: 15000 });
	await generateButton.click();
	const cancelledFrom = (await api(`/api/persistent-agents/${cancelId}/status`)).body.runtime.activeThreadId;
	// The new conversation's read fails: the long one's fits must not stand in for it.
	refuseOptions = true;
	await saveAndKeepChatting();
	await waitUntil(async () => (await api(`/api/persistent-agents/${cancelId}/status`)).body.runtime.activeThreadId !== cancelledFrom, "the new conversation is open");
	const afterCancel = (await api(`/api/persistent-agents/${cancelId}/status`)).body.runtime.activeThreadId;
	const afterCancelModel = (await api(`/api/persistent-agents/${cancelId}/threads/${afterCancel}`)).body.thread?.model?.model;
	assert(afterCancelModel === CLAUDE.model, `a cancelled Remember and switch takes its switch with it: the new conversation starts on the room's default, Claude Fake, got ${afterCancelModel}`);
	await waitUntil(async () => (await triggerName(page)) === "Claude Fake", "the control names the room's default");
	pass("Remember and switch, cancelled: Remember run again starts the new conversation on the room's default");
	await page.locator(".model-pick-trigger").first().click();
	const staleWait = page.locator(".model-pick-panel");
	await staleWait.waitFor({ timeout: 10000 });
	if (await staleWait.locator(".model-pick-effort-model").count()) await staleWait.locator(".model-pick-effort-model").click();
	await staleWait.getByRole("button", { name: "Try again" }).first().waitFor({ timeout: 10000 });
	assert((await staleWait.getByText("New conversation", { exact: true }).count()) === 0, `a failed read in the new conversation never shows the long one's fits, got ${await staleWait.innerText()}`);
	refuseOptions = false;
	await page.keyboard.press("Escape");
	if (await staleWait.count()) await page.keyboard.press("Escape");
	pass("a failed read after Remember shows no fits of the conversation before");

	releaseRemember = holdRemember();
	await startRememberAndSwitch();
	await page.getByRole("button", { name: "Cancel", exact: true }).waitFor({ timeout: 15000 });
	await enterRoom(page, "Cancel Room");
	refuseRemember = true;
	releaseRemember();
	await generateButton.waitFor({ timeout: 60000 });
	refuseRemember = false;
	await generateButton.click();
	await saveAndKeepChatting();
	await waitUntil(async () => (await triggerName(page)) === "Mid Fake", "after a reload and a failed read, Remember run again still continues on the picked model");
	pass("Remember and switch, cut by a reload and a failed read: Remember run again continues on the picked model");

	// The read fails while nobody is in the room: entering shows it, and Remember run again keeps the switch.
	writeModels(providerPort, 200000);
	await pick(page, "GPT Fake");
	await page.getByText("Continued on GPT Fake", { exact: true }).waitFor({ timeout: 15000 });
	releaseRemember = holdRemember();
	await startRememberAndSwitch();
	await page.getByRole("button", { name: "Cancel", exact: true }).waitFor({ timeout: 15000 });
	const awayFrom = (await api(`/api/persistent-agents/${cancelId}/status`)).body.runtime.activeThreadId;
	await page.goto(`${baseUrl}/auth/session?token=${SMOKE_AUTH_TOKEN}`);
	await page.locator(".persistent-agent-card").first().waitFor({ timeout: 15000 });
	refuseRemember = true;
	releaseRemember();
	await waitUntil(async () => (await api(`/api/persistent-agents/${cancelId}/checkpoint/progress?conversationId=${awayFrom}`)).body?.state === "failed", "the read fails while nobody is in the room", 60_000);
	refuseRemember = false;
	await enterRoom(page, "Cancel Room");
	await generateButton.waitFor({ timeout: 20000 });
	await generateButton.click();
	await saveAndKeepChatting();
	await waitUntil(async () => (await triggerName(page)) === "Mid Fake", "Remember run again after a failure nobody saw still continues on the picked model");
	pass("Remember and switch whose read failed while nobody was in the room: entering shows it, and run again continues on the picked model");

	await ctx.close();
	console.log(`model-pick-page smoke: ${passes} checks passed`);
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
