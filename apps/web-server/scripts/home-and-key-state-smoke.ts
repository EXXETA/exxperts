// Home's AI setup state, the refused-key line in Room settings, Model, and the
// buttons under a failure line and in the room's notices on a touch screen, in
// the browser.
//
// Against a real spawned server and one synthetic Anthropic endpoint (nothing
// leaves the machine, no real key exists), with the Claude API key saved and
// its model approved, and the default for new rooms stored on a gateway that
// was removed since:
//
// - right after start, Home with no rooms does not say "You're set up" while
//   the model status is still on its way, nor once its read failed; once it
//   arrives Home shows "AI setup needed";
// - a new default saved in AI setup takes Home out of "AI setup needed" with
//   no reload: it says "You're set up" and New room leads;
// - Room settings, Model of a room whose key was refused shows the amber line;
//   coming back to the window while the key is still refused keeps it; the key
//   replaced elsewhere (another window), the line goes when the person comes
//   back to this window, with nothing reopened;
// - every failure line's buttons (a folded line's Details too), and the
//   buttons of the notices above the message box (Set workspace and Dismiss,
//   a room stopped on a provider with no key), are at least 44 CSS px tall at
//   390 px on a touch screen, and keep their desktop size with a mouse.
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import { fileURLToPath } from "node:url";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright";
import { authedFetch, SMOKE_AUTH_HEADERS, SMOKE_AUTH_TOKEN, SMOKE_SERVER_AUTH_ENV, SMOKE_SERVER_SPAWN_TREE_OPTIONS, smokeHomeEnv, stopSmokeServer, freePort, type AuthedFetchInit } from "./smoke-server-process.js";
import { waitEvery } from "./smoke-wait.js";

function assert(condition: unknown, message: string): asserts condition {
	if (!condition) throw new Error(message);
}

function pass(label: string): void {
	console.log(`  ok  ${label}`);
}

// Each case runs whatever an earlier one found, so one run names every case that fails.
const failures: string[] = [];
async function check(label: string, run: () => Promise<void>): Promise<void> {
	try {
		await run();
		pass(label);
	} catch (error) {
		failures.push(`${label}: ${(error as Error).message}`);
		console.log(`  FAIL  ${label}: ${(error as Error).message}`);
		// A failed case can leave a room open in its page, which would hold the room from the next case.
		for (const context of browser?.contexts() ?? []) for (const page of context.pages()) await page.close().catch(() => {});
	}
}

{
	const p = typeof chromium?.executablePath === "function" ? chromium.executablePath() : "";
	if (!p || !fs.existsSync(p)) {
		console.log("home and key state smoke skipped (Chromium not installed)");
		process.exit(0);
	}
}

const waitUntil = waitEvery(100, 15_000);

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const webServerDir = path.resolve(scriptDir, "..");
const repoRoot = path.resolve(webServerDir, "..", "..");
const port = await freePort();
const baseUrl = `http://127.0.0.1:${port}`;

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "exxperts-home-and-key-state-"));
const tempHome = path.join(tempRoot, "home");
const agentsRoot = path.join(tempHome, ".exxperts", "app", "personalized-agents");
const agentDir = path.join(tempHome, ".exxperts", "agent");
const appDir = path.join(tempHome, ".exxperts", "app");
for (const dir of [agentsRoot, agentDir]) fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
process.env.HOME = tempHome;
process.env.USERPROFILE = tempHome;
process.env.EXXPERTS_CODING_AGENT_DIR = agentDir;
process.env.EXXETA_PERSISTENT_AGENTS_ROOT = agentsRoot;

const KEY_PROVIDER = "anthropic-api-key";
const PROFILE_ID = "custom-anthropic-api-key";
const ON_KEY = { provider: KEY_PROVIDER, model: "claude-haiku-5-5" };
// A provider whose key is not saved: a room on it stops with the notice above the message box.
const NO_KEY = { provider: "fake-gpt", model: "gpt-fake" };
// The default's gateway, removed since: nothing in AI setup offers it any more.
const ON_GONE_GATEWAY = { provider: "removed-gateway", model: "gateway-model" };
const SET_UP_LINE = "You're set up. Create your first room.";
const REFUSED_LINE = "Anthropic did not accept the saved key.";
const MODEL_STATUS = "**/api/persistent-agent-room/model-status";
const PROFILE_STATUS = "/api/persistent-agent-ai-profile";

let refuse = false;
const endpoint = http.createServer((req, res) => {
	let raw = "";
	req.on("data", (chunk) => { raw += chunk; });
	req.on("end", () => {
		if (req.method === "GET" && req.url?.includes("/models")) {
			res.writeHead(200, { "content-type": "application/json" });
			res.end(JSON.stringify({ data: [{ type: "model", id: ON_KEY.model }], has_more: false }));
			return;
		}
		if (refuse) {
			res.writeHead(401, { "content-type": "application/json" });
			res.end(JSON.stringify({ type: "error", error: { type: "authentication_error", message: "invalid x-api-key" } }));
			return;
		}
		const body = JSON.parse(raw || "{}");
		const sse = (event: string, payload: unknown) => res.write(`event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`);
		res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
		sse("message_start", { type: "message_start", message: { id: "msg_smoke", type: "message", role: "assistant", model: body.model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 100, output_tokens: 1 } } });
		sse("content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } });
		sse("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "An answer." } });
		sse("content_block_stop", { type: "content_block_stop", index: 0 });
		sse("message_delta", { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 20 } });
		sse("message_stop", { type: "message_stop" });
		res.end();
	});
});

async function api(pathname: string, init: AuthedFetchInit = {}): Promise<{ status: number; body: any }> {
	const response = await authedFetch(`${baseUrl}${pathname}`, { ...init, headers: { ...(init.body ? { "content-type": "application/json" } : {}), ...init.headers } });
	const text = await response.text();
	return { status: response.status, body: text ? JSON.parse(text) : null };
}

const WebSocketImpl: any = (await import("ws")).default;

/** One turn in the room's conversation, through the room's socket, until the room is idle again. */
async function turnIn(agentId: string, conversationId: string, text: string): Promise<void> {
	const created = await api(`/api/persistent-agents/${agentId}/threads/${conversationId}`, { method: "PUT", body: JSON.stringify({ state: "active", origin: "home", items: [] }) });
	assert(created.status === 200, `the conversation opens, got ${created.status} ${JSON.stringify(created.body)}`);
	const frames: any[] = [];
	const socket = new WebSocketImpl(`ws://127.0.0.1:${port}/ws?persistentAgentId=${agentId}&conversationId=${conversationId}`, { headers: { ...SMOKE_AUTH_HEADERS } });
	socket.addEventListener("message", (event: { data: unknown }) => { try { frames.push(JSON.parse(String(event.data))); } catch {} });
	await new Promise<void>((resolve, reject) => { socket.addEventListener("open", () => resolve()); socket.addEventListener("error", () => reject(new Error("websocket failed to connect"))); });
	await waitUntil(() => frames.some((frame) => frame.type === "ready"), "ready frame");
	socket.send(JSON.stringify({ type: "prompt", text }));
	await waitUntil(() => frames.some((frame) => frame.type === "event" && frame.event?.type === "agent_end"), `the turn "${text}" ended`);
	await waitUntil(async () => (await api(`/api/persistent-agents/${agentId}/status`)).body?.activeThread?.inFlight === false, `the turn "${text}" settled`);
	socket.close();
}

async function openHome(page: Page): Promise<void> {
	await page.goto(`${baseUrl}/auth/session?token=${SMOKE_AUTH_TOKEN}`);
	await page.locator(".landing-hero h1").waitFor({ timeout: 15_000 });
	const dismiss = page.locator(".whats-new-close");
	if (await dismiss.count()) await dismiss.click();
}

/** What Home's empty hero says about AI setup: its line, the pill, and whether New room leads. */
async function homeState(page: Page): Promise<{ line: string; pill: boolean; newRoomLeads: boolean }> {
	const line = (await page.locator(".landing-hero-head p").allInnerTexts()).join(" ").trim();
	const pill = (await page.locator(".home-ai-profile-status.setup-needed").count()) > 0;
	const newRoomLeads = (await page.locator(".add-room-card.is-primary").count()) > 0;
	return { line, pill, newRoomLeads };
}
const claimsSetUp = (state: { line: string; newRoomLeads: boolean }) => state.line.includes("You're set up") || state.newRoomLeads;

/** The page's reads of a route: started and finished, so a test can wait for every read it caused. */
function readsOf(page: Page, pathname: string): { started: () => number; settled: () => boolean } {
	let started = 0;
	let done = 0;
	const matches = (url: string) => new URL(url).pathname === pathname;
	page.on("request", (request) => { if (matches(request.url())) started += 1; });
	const finish = (request: { url: () => string }) => { if (matches(request.url())) done += 1; };
	page.on("requestfinished", finish);
	page.on("requestfailed", finish);
	return { started: () => started, settled: () => done === started };
}

/** Each button in a row as it is drawn: its words, height, and the style that sets its size. */
async function buttonsIn(row: ReturnType<Page["locator"]>): Promise<Array<{ text: string; height: number; minHeight: string; padding: string; fontSize: string }>> {
	return row.locator("button").evaluateAll((els) => els.map((el) => {
		const style = getComputedStyle(el);
		return { text: (el.textContent ?? "").trim(), height: el.getBoundingClientRect().height, minHeight: style.minHeight, padding: style.padding, fontSize: style.fontSize };
	}));
}

/** The person comes back to this window. Headless Chromium sends no focus when a page comes to the front, so the smoke sends the window's own event. */
async function comeBack(page: Page): Promise<void> {
	await page.evaluate(() => {
		window.dispatchEvent(new Event("blur"));
		window.dispatchEvent(new Event("focus"));
	});
}

let server: ChildProcessWithoutNullStreams | undefined;
const serverOutput: string[] = [];
let browser: Browser | undefined;

try {
	await new Promise<void>((resolve) => endpoint.listen(0, "127.0.0.1", resolve));
	const endpointUrl = `http://127.0.0.1:${(endpoint.address() as AddressInfo).port}`;
	fs.writeFileSync(path.join(agentDir, "models.json"), JSON.stringify({ providers: {
		[KEY_PROVIDER]: { baseUrl: endpointUrl },
		[NO_KEY.provider]: { name: "Fake GPT", baseUrl: `${endpointUrl}/v1`, api: "openai-completions", models: [{ id: NO_KEY.model, name: "GPT Fake", input: ["text"], contextWindow: 128000, maxTokens: 16000 }] },
	} }, null, 2), { mode: 0o600 });
	fs.writeFileSync(path.join(agentDir, "auth.json"), JSON.stringify({ [KEY_PROVIDER]: { type: "api_key", key: "synthetic-anthropic-key" } }, null, 2), { mode: 0o600 });
	fs.writeFileSync(path.join(appDir, "custom-ai-profiles.json"), JSON.stringify({ version: 1, profiles: [
		{ id: PROFILE_ID, providerId: KEY_PROVIDER, label: "Claude API key", roomModels: [ON_KEY.model], learnModel: ON_KEY.model, reviewMemoryModel: ON_KEY.model },
		{ id: "custom-fake-gpt", providerId: NO_KEY.provider, label: "Fake GPT", roomModels: [NO_KEY.model], learnModel: NO_KEY.model, reviewMemoryModel: NO_KEY.model },
	] }, null, 2), { mode: 0o600 });
	fs.writeFileSync(path.join(appDir, "persistent-agent-ai-profile.json"), JSON.stringify({ profileId: PROFILE_ID, defaults: { conversation: ON_GONE_GATEWAY } }, null, 2), { mode: 0o600 });

	server = spawn("npx", ["tsx", "src/index.ts"], {
		shell: process.platform === "win32",
		...SMOKE_SERVER_SPAWN_TREE_OPTIONS,
		cwd: webServerDir,
		env: smokeHomeEnv(tempHome, { PORT: String(port), ...SMOKE_SERVER_AUTH_ENV, EXXETA_HOME: repoRoot, EXXPERTS_CODING_AGENT_DIR: agentDir, EXXETA_PERSISTENT_AGENTS_ROOT: agentsRoot }) as NodeJS.ProcessEnv,
	});
	server.stdout.on("data", (chunk) => serverOutput.push(String(chunk)));
	server.stderr.on("data", (chunk) => serverOutput.push(String(chunk)));
	await waitUntil(() => fetch(`${baseUrl}/healthz`).then((r) => r.ok).catch(() => false), "server ready", 60_000);

	const status = (await api("/api/persistent-agent-room/model-status")).body;
	assert(status?.ready === false && status.providers?.some((provider: any) => provider.ready), `the setup: a provider connected, the default not runnable, got ${JSON.stringify({ ready: status?.ready, providers: status?.providers?.map((provider: any) => [provider.id, provider.ready]) })}`);
	const profiles = (await api(PROFILE_STATUS)).body;
	assert(profiles?.profiles?.some((profile: any) => profile.ready), "the setup: AI setup lists a ready profile");

	const launched = await chromium.launch();
	browser = launched;
	// first-run-guide-ui-smoke.ts holds the guide; here it has had its turn.
	const guideSeen = (context: BrowserContext) => context.addInitScript(() => localStorage.setItem("exxperts.first-run-guide-seen", "1"));
	const desktop = await launched.newContext({ viewport: { width: 1280, height: 900 } });
	await guideSeen(desktop);

	// Right after start, the model status on its way: Home claims nothing yet.
	await check("right after start: no \"You're set up\" while the model status is on its way, then AI setup needed", async () => {
		const page = await desktop.newPage();
		let release: () => void = () => {};
		const held = new Promise<void>((resolve) => { release = resolve; });
		await page.route(MODEL_STATUS, async (route) => { await held; await route.continue(); });
		const profileReads = readsOf(page, PROFILE_STATUS);
		await openHome(page);
		await waitUntil(() => profileReads.started() > 0 && profileReads.settled(), "AI setup's profiles are read");
		const waiting = await homeState(page);
		assert(!claimsSetUp(waiting), `before the model status is known Home does not say set up, got ${JSON.stringify(waiting)}`);
		release();
		await waitUntil(async () => (await homeState(page)).pill, "the model status arrives and Home shows AI setup needed");
		const known = await homeState(page);
		assert(!claimsSetUp(known), `with the default not runnable Home does not say set up, got ${JSON.stringify(known)}`);
		await page.close();
	});

	// The model status read fails: Home still claims nothing.
	await check("the model status read failed: Home does not say \"You're set up\"", async () => {
		const page = await desktop.newPage();
		const modelReads = readsOf(page, "/api/persistent-agent-room/model-status");
		const profileReads = readsOf(page, PROFILE_STATUS);
		await page.route(MODEL_STATUS, (route) => route.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ error: "unavailable" }) }));
		await openHome(page);
		await waitUntil(() => modelReads.started() > 0 && modelReads.settled() && profileReads.started() > 0 && profileReads.settled(), "the page's reads are answered");
		const failed = await homeState(page);
		assert(!claimsSetUp(failed), `after the model status read failed Home does not say set up, got ${JSON.stringify(failed)}`);
		await page.close();
	});

	// A new default saved in AI setup: Home leaves "AI setup needed" with no reload.
	await check("a new default saved in AI setup: Home says \"You're set up\" and New room leads, with no reload", async () => {
		const page = await desktop.newPage();
		await openHome(page);
		await waitUntil(async () => (await homeState(page)).pill, "Home shows AI setup needed");
		await page.locator(".home-ai-profile-status.setup-needed").click();
		await page.waitForSelector(".settings-overlay", { timeout: 10_000 });
		const picker = page.locator(".ai-defaults-group .room-model-pick:not([disabled])").first();
		await picker.waitFor({ timeout: 15_000 });
		await picker.click();
		await page.locator(".room-model-menu .room-model-menu-group[aria-label=\"Claude API key\"] .room-model-option").first().click();
		await waitUntil(async () => (await api("/api/persistent-agent-room/model-status")).body?.ready === true, "the default is saved");
		await page.keyboard.press("Escape");
		await page.waitForSelector(".settings-overlay", { state: "detached", timeout: 10_000 });
		await waitUntil(async () => {
			const state = await homeState(page);
			return !state.pill && state.line === SET_UP_LINE && state.newRoomLeads;
		}, "Home says set up and New room leads, with no reload").catch(async (error) => {
			throw new Error(`${(error as Error).message}; Home: ${JSON.stringify(await homeState(page))}`);
		});
		await page.close();
	});

	// Rooms from here on.
	const agents = await import("../src/persistent-agents.js");
	const roomModels = await import("../src/room-models.js");
	const newRoom = (displayName: string) => agents.createPersistentAgentFromScaffoldInput({ displayName, userName: "Synthetic User", preferredUserAddress: "Synthetic User" }).agent.agentId;
	const keyRoom = newRoom("Key Room");
	roomModels.writeRoomModels(keyRoom, { conversation: ON_KEY, memory: ON_KEY });

	// Room settings, Model: the refused key's line goes once the key is replaced elsewhere.
	await check("Room settings, Model: the refused key's line stays while refused and goes once the key is replaced elsewhere, with nothing reopened", async () => {
		refuse = true;
		await turnIn(keyRoom, "c_key_0001", "A question the service refuses.");
		refuse = false;
		const refusedRow = (await api(PROFILE_STATUS)).body.profiles.find((profile: any) => profile.id === PROFILE_ID);
		assert(refusedRow?.provider?.keyRefused === "refused", `the setup: the key is marked refused, got ${JSON.stringify(refusedRow?.provider)}`);

		const page = await desktop.newPage();
		const profileReads = readsOf(page, PROFILE_STATUS);
		await openHome(page);
		await page.locator(".persistent-agent-card").filter({ hasText: "Key Room" }).locator(".card-gear-btn").click();
		await page.waitForSelector(".settings-dialog", { timeout: 10_000 });
		await page.locator(".settings-dialog-nav-item").filter({ hasText: /^Model$/ }).first().click();
		const row = page.locator(".room-settings-section:not([hidden]) .room-model-row").first();
		const line = row.locator(".room-model-refused > span").first();
		await line.waitFor({ timeout: 10_000 });
		assert((await line.innerText()).trim() === REFUSED_LINE, `the Model pane's row reads "${REFUSED_LINE}", got "${await line.innerText()}"`);

		const before = profileReads.started();
		await comeBack(page);
		await waitUntil(() => profileReads.started() > before && profileReads.settled(), "the page's reads on coming back are answered");
		assert((await line.count()) === 1, "coming back while the key is still refused keeps the line");

		const replaced = await api("/api/auth/api-key", { method: "POST", body: JSON.stringify({ provider: KEY_PROVIDER, key: "another-synthetic-key" }) });
		assert(replaced.status === 200, `the key is replaced elsewhere, got ${replaced.status} ${JSON.stringify(replaced.body)}`);
		await comeBack(page);
		await waitUntil(async () => (await line.count()) === 0, "the line goes once the person comes back, with nothing reopened").catch(async (error) => {
			throw new Error(`${(error as Error).message}; the row still reads ${JSON.stringify(await line.allInnerTexts())}`);
		});
		assert(await page.locator(".settings-dialog").isVisible(), "the dialog stayed open throughout");
		await page.close();
	});

	// Every failure line's buttons: 44 px tall at 390 px on a touch screen, unchanged on the desktop.
	await check("every failure line's buttons are at least 44 px tall at 390 px on a touch screen, and keep their size on the desktop", async () => {
		// Each line as the newest of the only conversation in a room of its own, so it is drawn in full with its buttons.
		const lines: Array<{ failure: string; text: string; expect: string[]; details?: string; provider?: string }> = [
			{ failure: "other", text: "The model could not answer this message. Try again, or choose another model in Room settings, Model.", details: "The provider's own words.", expect: ["Try again", "Choose another model", "Show details"] },
			{ failure: "overflow", text: "This conversation and the room's memory are more than the model reads at once.", expect: ["Review memory", "Choose another model"] },
			{ failure: "gateway-refused", text: "The gateway did not accept the saved key.", provider: KEY_PROVIDER, expect: ["Choose another model", "Replace key"] },
			{ failure: "gateway-not-found", text: "The gateway did not find this model.", expect: ["Open AI setup"] },
		];
		// An older line folds under the newest, keeping its Details: the last conversation has one.
		const olderLine = { kind: "system", id: "s_older", level: "error", text: "The model could not answer this message.", failure: "other", details: "The provider's own words.", detailsFrom: "Anthropic" };
		const touch = await launched.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
		const measured: string[] = [];
		for (const [index, entry] of lines.entries()) {
			const roomName = `Failure Room ${index + 1}`;
			const failureRoom = newRoom(roomName);
			roomModels.writeRoomModels(failureRoom, { conversation: ON_KEY, memory: ON_KEY });
			// Memory to review, so an overflow line offers Review memory.
			const l1bPath = path.join(agentsRoot, failureRoom, "L1b", "current.md");
			const l1b = fs.readFileSync(l1bPath, "utf-8");
			const recent = /^##\s+Recent Context\s*$/m.exec(l1b)!;
			fs.writeFileSync(l1bPath, `${l1b.slice(0, recent.index + recent[0].length)}\n\n${["### RC-0001 | CLOSED | 2026-09-09 | The renewal call", "", "**Session arc:** We went through the renewals.", "", "**Body:**", "- The Nordwind renewal is in May.", "", "**Parked:**", "None", ""].join("\n")}\n`, "utf-8");
			const seeded = await api(`/api/persistent-agents/${failureRoom}/threads/c_fail_0001`, { method: "PUT", body: JSON.stringify({ state: "active", origin: "home", items: [
				...(index === lines.length - 1 ? [{ kind: "user", id: "u_older", text: "An earlier question." }, olderLine] : []),
				{ kind: "user", id: `u${index}`, text: "A question." },
				{ kind: "system", id: `s${index}`, level: "error", text: entry.text, failure: entry.failure, ...(entry.details ? { details: entry.details, detailsFrom: "Anthropic" } : {}), ...(entry.provider ? { provider: entry.provider } : {}) },
			] }) });
			assert(seeded.status === 200, `the ${entry.failure} line is saved, got ${seeded.status} ${JSON.stringify(seeded.body)}`);
			for (const [label, context] of [["390 px touch", touch], ["1280 px desktop", desktop]] as const) {
				const page = await context.newPage();
				await openHome(page);
				await page.locator(".persistent-agent-card").filter({ hasText: roomName }).getByRole("button", { name: /^(Enter|Resume)$/ }).click();
				const actions = page.locator(".failure-line:not(.is-folded) .failure-actions");
				await actions.waitFor({ timeout: 15_000 });
				const buttons = await buttonsIn(actions);
				assert(JSON.stringify(buttons.map((button) => button.text)) === JSON.stringify(entry.expect), `the ${entry.failure} line offers ${JSON.stringify(entry.expect)} at ${label}, got ${JSON.stringify(buttons.map((button) => button.text))}`);
				if (context === touch) {
					const small = buttons.filter((button) => button.height < 44);
					assert(small.length === 0, `at ${label} every button of the ${entry.failure} line is at least 44 px tall, got ${JSON.stringify(small)}`);
				} else {
					// The desktop look as it was: the small buttons, their padding and type, and the toggle beside them.
					const asBefore = (button: (typeof buttons)[number]) => button.text === "Show details"
						? button.minHeight === "auto" && button.padding === "0px"
						: button.minHeight === "0px" && button.padding === "5px 12px";
					const changed = buttons.filter((button) => button.height >= 44 || button.fontSize !== "13px" || !asBefore(button));
					assert(changed.length === 0, `at ${label} the ${entry.failure} line's buttons keep their size, got ${JSON.stringify(changed)}`);
				}
				measured.push(`${entry.failure} ${label}: ${buttons.map((button) => `${button.text} ${Math.round(button.height)}`).join(", ")}`);
				if (index === lines.length - 1) {
					const folded = await buttonsIn(page.locator(".failure-line.is-folded"));
					assert(JSON.stringify(folded.map((button) => button.text)) === JSON.stringify(["Details"]), `the folded line keeps its Details at ${label}, got ${JSON.stringify(folded.map((button) => button.text))}`);
					if (context === touch) assert(folded[0]!.height >= 44, `at ${label} the folded line's Details is at least 44 px tall, got ${JSON.stringify(folded)}`);
					else assert(folded[0]!.height < 44 && folded[0]!.minHeight === "auto" && folded[0]!.padding === "0px", `at ${label} the folded line's Details keeps its size, got ${JSON.stringify(folded)}`);
					measured.push(`folded ${label}: Details ${Math.round(folded[0]!.height)}`);
				}
				await page.close();
			}
		}
		console.log(`      ${measured.join("\n      ")}`);
		await touch.close();
	});

	// The rows of the notices above the message box: the workspace nudge (Set workspace, Dismiss) and a room stopped on its model.
	await check("the room notices' buttons (Set workspace, a stopped room's) are at least 44 px tall at 390 px on a touch screen, and keep their size on the desktop", async () => {
		// A conversation left on a provider whose key is not saved: resuming it stops the room with the notice.
		const stoppedRoom = newRoom("Stopped Room");
		roomModels.writeRoomModels(stoppedRoom, { conversation: ON_KEY, memory: ON_KEY });
		const threadCwd = path.join(tempRoot, "cwd");
		fs.mkdirSync(threadCwd, { recursive: true });
		const created = agents.writePersistentAgentThread(stoppedRoom, "c_stopped_0001", { state: "standby", origin: "home", model: NO_KEY, items: [{ kind: "user", id: "u1", text: "Earlier question." }, { kind: "assistant", id: "a1", text: "Earlier answer." }] }, {
			createRuntime: ({ model }) => agents.createPersistentAgentPiSessionJsonlThreadRuntime({ agentId: stoppedRoom, threadId: "c_stopped_0001", model, cwd: threadCwd }),
		});
		const seed = agents.openPersistentAgentPiSessionManager(stoppedRoom, created.thread.runtime as any, threadCwd);
		const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
		seed.appendMessage({ role: "user", content: [{ type: "text", text: "Earlier question." }], timestamp: Date.now() } as any);
		seed.appendMessage({ role: "assistant", content: [{ type: "text", text: "Earlier answer." }], api: "openai-completions", provider: NO_KEY.provider, model: NO_KEY.model, usage, stopReason: "stop", timestamp: Date.now() } as any);
		const touch = await launched.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
		const measured: string[] = [];
		for (const [room, notice, expect] of [["Failure Room 1", ".room-workspace-nudge:not(.room-model-notice)", ["Set workspace", "Dismiss"]], ["Stopped Room", ".room-model-notice", ["Choose another model", "Add key"]]] as const) {
			for (const [label, context] of [["390 px touch", touch], ["1280 px desktop", desktop]] as const) {
				const page = await context.newPage();
				await openHome(page);
				await page.locator(".persistent-agent-card").filter({ hasText: room }).getByRole("button", { name: /^(Enter|Resume)$/ }).click();
				const actions = page.locator(`${notice} .room-workspace-nudge-actions`);
				await actions.waitFor({ timeout: 15_000 });
				const buttons = await buttonsIn(actions);
				assert(JSON.stringify(buttons.map((button) => button.text)) === JSON.stringify(expect), `${room}'s notice offers ${JSON.stringify(expect)} at ${label}, got ${JSON.stringify(buttons.map((button) => button.text))}`);
				if (context === touch) {
					const small = buttons.filter((button) => button.height < 44);
					assert(small.length === 0, `at ${label} every button of ${room}'s notice is at least 44 px tall, got ${JSON.stringify(small)}`);
				} else {
					// As on main: the shared button's 32 px floor, and the quiet Dismiss with none.
					const changed = buttons.filter((button) => button.height >= 44 || button.minHeight !== (button.text === "Dismiss" ? "auto" : "32px"));
					assert(changed.length === 0, `at ${label} ${room}'s notice keeps its buttons' size, got ${JSON.stringify(changed)}`);
				}
				measured.push(`${room} ${label}: ${buttons.map((button) => `${button.text} ${Math.round(button.height)} (${button.minHeight}, ${button.padding}, ${button.fontSize})`).join(", ")}`);
				await page.close();
			}
		}
		console.log(`      ${measured.join("\n      ")}`);
		await touch.close();
	});

	assert(failures.length === 0, `${failures.length} case(s) failed:\n${failures.join("\n")}`);
	console.log("home-and-key-state smoke: ok");
} catch (error) {
	console.error(serverOutput.join("").slice(-6000));
	throw error;
} finally {
	await browser?.close().catch(() => {});
	try { (endpoint as any).closeAllConnections?.(); } catch {}
	try { endpoint.close(); } catch {}
	await stopSmokeServer(server);
	fs.rmSync(tempRoot, { recursive: true, force: true });
}
