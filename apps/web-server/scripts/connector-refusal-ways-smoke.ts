// A connector call its service refuses, in a real room: a real server, a
// gateway that plays the model, the page in Chromium, and web connectors of
// the smoke's own that list their tools to anyone and refuse a call with a
// 401 or a 403. For each of the six ways a call is refused (no key, a key, a
// stored sign-in; each with a 401 and a 403) the step says why in its own
// words, Open in Settings opens the connector's page, and that page has the
// control the line names: Sign in and Change key, Change key, or Reconnect.
// Beside them, where the server takes neither: a program has no key row and
// no Sign in, a connector with two keys says where its key is changed with no
// button, and the page over remote access offers neither. Sign in pressed on
// a connector that offers no sign-in ends in the line that leads to Change
// key. A tool the room doesn't know, one of a connector that can't be
// reached, a connector's prompt by its name, and a connect, a search, a list
// and a describe each name the connector as the person knows it: no step
// shows the model's search hint or a connector's key. Each row runs in the
// settings windows' old look and in the new one. Nothing opens a page in a browser
// of this computer: the server's opener is a stand-in that notes it was asked.
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import { fileURLToPath } from "node:url";
import { chromium, type Browser, type Page, type Request, type Route } from "playwright";
import { authedFetch, freePort, smokeHomeEnv, SMOKE_AUTH_TOKEN, SMOKE_SERVER_AUTH_ENV, SMOKE_SERVER_SPAWN_TREE_OPTIONS, stopSmokeServer, waitForServer, type AuthedFetchInit } from "./smoke-server-process.js";
import { waitForTurnSettled } from "./smoke-turn-settle.js";
import { waitEvery } from "./smoke-wait.js";
import { connectorFailureLine, OPEN_IN_SETTINGS, unknownToolLine, type ConnectorCallFailure } from "../src/connector-call-failures.js";
import { SETTINGS_LOOK_KEY, SETTINGS_LOOK_OLD } from "../../web-ui/src/settings-look.js";

if (os.platform() === "win32") {
	console.log("SKIPPED: the opener's stand-in is a shell script");
	process.exit(0);
}
{
	const p = typeof chromium?.executablePath === "function" ? chromium.executablePath() : "";
	if (!p || !fs.existsSync(p)) {
		console.log("connector refusal ways smoke skipped (Chromium not installed)");
		process.exit(0);
	}
}

function assert(condition: unknown, message: string): asserts condition {
	if (!condition) throw new Error(message);
}

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const webServerDir = path.resolve(scriptDir, "..");
const repoRoot = path.resolve(webServerDir, "..", "..");
const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "exxperts-refusal-ways-"));
const home = path.join(tempRoot, "home");
const agentDir = path.join(home, ".exxperts", "agent");
const appRoot = path.join(home, ".exxperts", "app");
const agentsRoot = path.join(appRoot, "personalized-agents");
const MODEL = { provider: "openai-compatible", model: "room-model" };
const waitUntil = waitEvery(50, 20_000);
const { CONNECTOR_WORDS } = await import(new URL("../../web-ui/src/connector-rows.ts", import.meta.url).href);
const WORDS = CONNECTOR_WORDS as any;

// --- The connectors' service: it lists one tool, hello, to anyone, and answers a call at /<status>/mcp with that status.
// It offers no sign-in: its sign-in addresses answer 404. What reached it, by path and the key or token it came with.
const reached: Array<{ path: string; method: string; bearer: string }> = [];
const json = (res: http.ServerResponse, status: number, body: unknown) => res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(body));
const service = http.createServer((req, res) => {
	const url = new URL(req.url ?? "/", "http://127.0.0.1");
	let raw = "";
	req.on("data", (chunk) => { raw += chunk; });
	req.on("end", () => {
		const bearer = /^Bearer (.+)$/.exec(String(req.headers.authorization ?? ""))?.[1] ?? String(req.headers["x-api-key"] ?? "");
		reached.push({ path: url.pathname, method: req.method ?? "", bearer });
		const at = /^\/(200|401|403)\/mcp$/.exec(url.pathname)?.[1];
		if (!at || req.method !== "POST") return json(res, at ? 405 : 404, { error: "not_found" });
		const message = JSON.parse(raw || "{}");
		if (message.id === undefined) return void res.writeHead(202).end();
		const reply = (body: Record<string, unknown>) => json(res, 200, { jsonrpc: "2.0", id: message.id, ...body });
		if (message.method === "initialize") return reply({ result: { protocolVersion: message.params?.protocolVersion, capabilities: { tools: {}, prompts: {} }, serverInfo: { name: "smoke-refusals", version: "1.0.0" } } });
		if (message.method === "tools/list") return reply({ result: { tools: [{ name: "hello", title: "Hello", description: "Says hello.", inputSchema: { type: "object" }, annotations: { readOnlyHint: true } }] } });
		if (message.method === "prompts/list") return reply({ result: { prompts: [{ name: "toy_prompt", description: "A prompt, not a tool." }] } });
		if (message.method === "tools/call") return at === "200" ? reply({ result: { content: [{ type: "text", text: "hello" }] } }) : json(res, Number(at), { error: "refused by the service" });
		return reply({ result: {} });
	});
});

// --- The gateway plays the model: the next prompt's first leg makes `calls`, then it answers in words.
type Call = { name: string; arguments: Record<string, unknown> };
let calls: Call[] = [];
const sseChunk = (payload: unknown): string => `data: ${JSON.stringify(payload)}\n\n`;
const gateway = http.createServer((req, res) => {
	let body = "";
	req.on("data", (chunk) => { body += chunk; });
	req.on("end", () => {
		const parsed = JSON.parse(body || "{}");
		const messages: any[] = Array.isArray(parsed.messages) ? parsed.messages : [];
		const after = messages.slice(messages.map((message) => message?.role).lastIndexOf("user") + 1);
		const firstLeg = after.filter((message) => message?.role === "assistant").length === 0 && (parsed.tools ?? []).length > 0;
		res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
		const base = { id: "cmpl_refusals", object: "chat.completion.chunk", created: Math.floor(Date.now() / 1000), model: MODEL.model };
		if (firstLeg && calls.length > 0) {
			const tool_calls = calls.map((call, index) => ({ index, id: `call_${Date.now()}_${index}`, type: "function", function: { name: call.name, arguments: JSON.stringify(call.arguments) } }));
			res.write(sseChunk({ ...base, choices: [{ index: 0, delta: { role: "assistant", tool_calls }, finish_reason: null }] }));
			res.write(sseChunk({ ...base, choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }], usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 } }));
		} else {
			res.write(sseChunk({ ...base, choices: [{ index: 0, delta: { role: "assistant", content: "Done." }, finish_reason: null }] }));
			res.write(sseChunk({ ...base, choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 150, completion_tokens: 2, total_tokens: 152 } }));
		}
		res.write("data: [DONE]\n\n");
		res.end();
	});
});

// The model's words for each case: what the tool results told it, read from the gateway's last request.
const callOf = (server: string, tool = "hello"): Call => ({ name: "mcp", arguments: { tool: `${server.replace(/-/g, "_")}_${tool}`, server, args: "{}" } });

let serverProcess: ChildProcessWithoutNullStreams | undefined;
const serverOutput: string[] = [];
let browser: Browser | undefined;
let port = 0;
let room = "";
async function api(pathname: string, init: AuthedFetchInit = {}): Promise<{ status: number; body: any }> {
	const response = await authedFetch(`http://127.0.0.1:${port}${pathname}`, { ...init, headers: { ...(init.body ? { "content-type": "application/json" } : {}), ...init.headers } });
	const text = await response.text();
	return { status: response.status, body: text ? JSON.parse(text) : null };
}

const failures: string[] = [];
/** One row; `page`, where given, is left with Settings closed, so a row that failed leaves the next one its clicks. */
async function row(name: string, run: () => Promise<void>, page?: Page): Promise<void> {
	try {
		await run();
		console.log(`  ok  ${name}`);
	} catch (error) {
		console.log(`  FAIL  ${name}: ${error instanceof Error ? error.message : String(error)}`);
		failures.push(name);
		if (page) await closeSettings(page).catch(() => undefined);
	}
}

/** The last step card's head, its line and the whole card's words, as the person reads them. */
async function lastStep(page: Page): Promise<{ head: string; line: string; text: string; opens: boolean }> {
	const card = page.locator(".wk-card").last();
	await card.waitFor({ timeout: 15_000 });
	// A failure with nothing to do starts folded: it is opened as the person opens it. A connector look-up alone on its card has nothing to open.
	const head = card.locator("button.wk-head");
	if ((await card.getAttribute("data-open")) !== "1" && (await head.count()) > 0) await head.click();
	return card.evaluate((el) => ({
		head: (el.querySelector(".wk-head .wk-lbl")?.textContent ?? "").replace(/\s+/g, " ").trim(),
		// The sentence alone: the line's words without its button's.
		line: (() => {
			const line = el.querySelector(".wk-line")?.cloneNode(true) as Element | undefined;
			line?.querySelectorAll("button").forEach((button) => button.remove());
			return (line?.textContent ?? "").replace(/\s+/g, " ").trim();
		})(),
		text: (el.textContent ?? "").replace(/\s+/g, " ").trim(),
		opens: !!el.querySelector(".wk-line button"),
	}));
}

/** Sends a message whose answer makes `next`, and waits until the turn has ended and landed. */
async function turn(page: Page, label: string, next: Call[]): Promise<void> {
	calls = next;
	const before = await page.locator(".wk-card").count();
	const composer = page.locator("textarea").first();
	await composer.fill(`Please use the connector (${label}).`);
	await page.locator('button.send-btn[title="Send"]').click();
	await waitUntil(async () => (await page.locator(".wk-card").count()) > before, `${label}: its step shows`);
	await page.locator('button.send-btn[title="Send"]').waitFor({ timeout: 20_000 });
	await waitForTurnSettled(api, room, `${label}: the turn landed`);
}

async function closeSettings(page: Page): Promise<void> {
	const dialog = page.locator(".settings-dialog").first();
	for (let presses = 0; presses < 3 && (await page.locator(".settings-dialog").count()) > 0; presses += 1) {
		await page.keyboard.press("Escape");
		await dialog.waitFor({ state: "detached", timeout: 2_000 }).catch(() => undefined);
	}
	await dialog.waitFor({ state: "detached", timeout: 10_000 });
}

/** The buttons on the open connector page, once its check has settled, by their names. */
async function pageButtons(page: Page): Promise<string[]> {
	const connectorPage = page.locator(".connector-page");
	await connectorPage.waitFor({ timeout: 15_000 });
	await waitUntil(async () => (await connectorPage.locator("[aria-busy=true]").count()) === 0 && !/Checking…/.test((await connectorPage.textContent()) ?? ""), "the page's check has settled");
	return connectorPage.locator("button").evaluateAll((buttons) => buttons.map((button) => (button.textContent ?? "").replace(/\s+/g, " ").trim()));
}

/** The connector page's Key row, by its label: its line and whether it has Change key. Null when there is none. */
async function keyRowOf(page: Page): Promise<{ line: string; button: boolean } | null> {
	return page.locator(".connector-page .connector-fact").evaluateAll((facts, keyLabel) => {
		const fact = facts.find((one) => one.querySelector(".settings-row-label")?.textContent === keyLabel);
		if (!fact) return null;
		return { line: (fact.querySelector(".settings-row-sub")?.textContent ?? "").trim(), button: [...fact.querySelectorAll("button")].some((button) => button.textContent?.trim() === "Change key") };
	}, WORDS.details.key);
}

try {
	await new Promise<void>((resolve) => service.listen(0, "127.0.0.1", resolve));
	await new Promise<void>((resolve) => gateway.listen(0, "127.0.0.1", resolve));
	const at = (status: number) => `http://127.0.0.1:${(service.address() as AddressInfo).port}/${status}/mcp`;
	const shut = http.createServer();
	await new Promise<void>((resolve) => shut.listen(0, "127.0.0.1", resolve));
	const shutPort = (shut.address() as AddressInfo).port;
	await new Promise<void>((resolve) => shut.close(() => resolve()));
	for (const dir of [agentsRoot, agentDir, appRoot]) fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
	const writeSetting = (file: string, value: unknown) => fs.writeFileSync(file, JSON.stringify(value, null, 2), { mode: 0o600 });
	writeSetting(path.join(agentDir, "models.json"), { providers: { "openai-compatible": { name: "Synthetic Gateway", baseUrl: `http://127.0.0.1:${(gateway.address() as AddressInfo).port}/v1`, api: "openai-completions", models: [{ id: "room-model", name: "Room Model", contextWindow: 200000, maxTokens: 4096 }] } } });
	writeSetting(path.join(agentDir, "auth.json"), { "openai-compatible": { type: "api_key", key: "synthetic-refusal-ways" } });
	writeSetting(path.join(appRoot, "openai-compatible-ai-profile.json"), { profileId: "openai-compatible", providerId: "openai-compatible", label: "Synthetic Gateway", roomModels: [{ modelId: "room-model", label: "Room Model" }], maintenanceModel: "room-model" });
	writeSetting(path.join(appRoot, "persistent-agent-ai-profile.json"), { profileId: "openai-compatible" });
	// Each way a call is refused, by the connector's way in and the service's answer.
	const CASES: Array<{ server: string; shown: string; entry: Record<string, unknown>; signedIn?: true; failure: ConnectorCallFailure; controls: string[] }> = [
		{ server: "open-403", shown: "Open 403", entry: { url: at(403) }, failure: "not-allowed", controls: [WORDS.button.signIn, WORDS.button.changeKey] },
		{ server: "open-401", shown: "Open 401", entry: { url: at(401) }, failure: "needs-sign-in-or-key", controls: [WORDS.button.signIn, WORDS.button.changeKey] },
		{ server: "key-401", shown: "Key 401", entry: { url: at(401), auth: "bearer", bearerToken: "right-key" }, failure: "key-refused", controls: [WORDS.button.changeKey] },
		{ server: "key-403", shown: "Key 403", entry: { url: at(403), auth: "bearer", bearerToken: "right-key" }, failure: "key-not-allowed", controls: [WORDS.button.changeKey] },
		{ server: "in-401", shown: "Signed 401", entry: { url: at(401) }, signedIn: true, failure: "sign-in-expired", controls: [WORDS.button.reconnect] },
		{ server: "in-403", shown: "Signed 403", entry: { url: at(403) }, signedIn: true, failure: "no-permission", controls: [WORDS.button.reconnect] },
	];
	const servers: Record<string, Record<string, unknown>> = Object.fromEntries(CASES.map((one) => [one.server, { ...one.entry, displayName: one.shown }]));
	servers["toy-space"] = { url: at(200), displayName: "Toy space" };
	servers["server-down"] = { url: `http://127.0.0.1:${shutPort}/mcp`, displayName: "Server down" };
	// Two keys: Change key couldn't tell which it replaces.
	servers["two-keys"] = { url: at(200), auth: "bearer", bearerToken: "right-key", headers: { "X-Api-Key": "other-key" }, displayName: "Two keys" };
	servers["toy-program"] = { command: process.execPath, args: ["-e", ""], displayName: "Toy program" };
	writeSetting(path.join(agentDir, "mcp.json"), { mcpServers: servers });
	// The sign-ins stored as a finished sign-in leaves them.
	process.env.PI_CODING_AGENT_DIR = agentDir;
	const authStore = await import("pi-mcp-adapter/mcp-auth.ts" as string);
	for (const one of CASES.filter((each) => each.signedIn)) authStore.saveAuthEntry(one.server, { tokens: { accessToken: "good" }, clientInfo: { clientId: "smoke-refusals-client" } }, String(one.entry.url));

	// The opener the server would use for a sign-in's page: a stand-in that only notes it was asked.
	const opener = path.join(tempRoot, "opener");
	const opened = path.join(tempRoot, "opened");
	fs.mkdirSync(opener);
	// portability-ok: this smoke is skipped on Windows, where no shell script stands in for the browser
	for (const name of ["open", "xdg-open"]) fs.writeFileSync(path.join(opener, name), `#!/bin/sh\necho "$@" >> "${opened}"\n`, { mode: 0o755 });

	port = await freePort();
	serverProcess = spawn("npx", ["tsx", "src/index.ts"], {
		...SMOKE_SERVER_SPAWN_TREE_OPTIONS,
		cwd: webServerDir,
		env: { ...process.env, ...smokeHomeEnv(home), PATH: `${opener}${path.delimiter}${process.env.PATH ?? ""}`, BROWSER: path.join(opener, "open"), EXXPERTS_CODING_AGENT_DIR: agentDir, EXXETA_PERSISTENT_AGENTS_ROOT: agentsRoot, PORT: String(port), ...SMOKE_SERVER_AUTH_ENV, EXXETA_HOME: repoRoot } as NodeJS.ProcessEnv,
	});
	serverProcess.stdout.on("data", (chunk) => serverOutput.push(String(chunk)));
	serverProcess.stderr.on("data", (chunk) => serverOutput.push(String(chunk)));
	await waitForServer(serverProcess, `http://127.0.0.1:${port}`, 60_000);
	const created = await api("/api/persistent-agents", { method: "POST", body: JSON.stringify({ displayName: "Connector Room", userName: "Synthetic User", preferredUserAddress: "Synthetic User" }) });
	room = String(created.body?.agent?.id ?? created.body?.agent?.agentId ?? "");
	assert(created.status === 201 && room, `room created, got ${created.status}`);
	for (const name of Object.keys(servers)) {
		const grant = await api(`/api/persistent-agents/${encodeURIComponent(room)}/mcp-connectors`, { method: "PUT", body: JSON.stringify({ action: "grant", name }) });
		assert(grant.status === 200, `${name} was enabled, got ${grant.status}`);
	}

	browser = await chromium.launch();
	for (const look of ["old", "new"] as const) {
		const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
		if (look === "old") await context.addInitScript(([key, old]) => localStorage.setItem(key, old), [SETTINGS_LOOK_KEY, SETTINGS_LOOK_OLD]);
		const page = await context.newPage();
		await page.goto(`http://127.0.0.1:${port}/auth/session?token=${SMOKE_AUTH_TOKEN}`);
		await page.waitForLoadState("networkidle");
		const dismiss = page.locator(".whats-new-close");
		if (await dismiss.count()) await dismiss.click();
		await page.locator(".persistent-agent-card").filter({ hasText: "Connector Room" }).getByRole("button", { name: /^(Enter|Resume)$/ }).click();
		await page.locator("textarea").first().waitFor({ timeout: 15_000 });

		for (const one of CASES) {
			await row(`${look} look: ${one.server}: the step says "${connectorFailureLine(one.failure, one.shown, "computer")?.line}", and its page has ${one.controls.join(" and ")}`, async () => {
				await turn(page, `${look}-${one.server}`, [callOf(one.server)]);
				const step = await lastStep(page);
				const expected = connectorFailureLine(one.failure, one.shown, "computer")!;
				assert(step.line === expected.line && step.opens, `the step's line and Open in Settings, got ${JSON.stringify(step)}`);
				assert(step.head === `Couldn't use Hello in ${one.shown}`, `the step's head, got ${step.head}`);
				await page.locator(".wk-card").last().locator(".wk-line button", { hasText: OPEN_IN_SETTINGS }).click();
				const buttons = await pageButtons(page);
				for (const control of one.controls) assert(buttons.includes(control), `its page has ${control}, got ${JSON.stringify(buttons)}`);
				if (one.signedIn) assert(buttons.includes(WORDS.button.disconnect) && !buttons.includes(WORDS.button.signIn) && !buttons.includes(WORDS.button.changeKey), `a stored sign-in has Reconnect beside Disconnect, no Sign in and no first key, got ${JSON.stringify(buttons)}`);
				else assert(!buttons.includes(WORDS.button.reconnect) && !buttons.includes(WORDS.button.disconnect), `no stored sign-in, nothing to reconnect, got ${JSON.stringify(buttons)}`);
				if (one.server.startsWith("key-")) assert(!buttons.includes(WORDS.button.signIn), `a connector with a key offers no sign-in, got ${JSON.stringify(buttons)}`);
				await closeSettings(page);
			}, page);
		}

		await row(`${look} look: Open in Settings opens the connector's page at once from the list read before, saying Checking… until it is read and checked; left before that, it stays left`, async () => {
			const words = () => page.locator(look === "new" ? ".connector-page .connector-status-words" : ".connector-page .connector-item-status").first().textContent();
			const started: string[] = [];
			const held: Array<() => void> = [];
			const hold = async (route: Route) => {
				await new Promise<void>((resolve) => held.push(resolve));
				await route.continue().catch(() => undefined);
			};
			const onRequest = (request: Request) => { if (/\/api\/mcp\/servers\/[^/]+\/test$/.test(new URL(request.url()).pathname)) started.push(request.url()); };
			await page.route("**/api/mcp/status*", hold);
			page.on("request", onRequest);
			try {
				// Every frame from here on: whether the list shows. As a string, so no helper of the compiler's is in it.
				await page.evaluate(`window.__listSeen = false; window.__watch = true; requestAnimationFrame(function look() {
					if ([...document.querySelectorAll(".settings-dialog .connector-item")].some((one) => one.getClientRects().length > 0)) window.__listSeen = true;
					if (window.__watch) requestAnimationFrame(look);
				})`);
				for (const leaves of [false, true]) {
					started.length = 0;
					await page.locator(".wk-card").last().locator(".wk-line button", { hasText: OPEN_IN_SETTINGS }).click();
					await page.locator(".connector-page").waitFor({ timeout: 5_000 });
					await waitUntil(() => Promise.resolve(held.length > 0), "the list is being read");
					assert((await words()) === WORDS.status.checking && started.length === 0, `before the answer: Checking… and nothing checked, got ${await words()} and ${JSON.stringify(started)}`);
					if (leaves) {
						await page.evaluate(() => { (window as any).__watch = false; });
						await page.locator(".connector-page-back").click();
						for (const go of held.splice(0)) go();
						await page.locator(".connector-item").first().waitFor({ timeout: 15_000 });
						await page.waitForLoadState("networkidle");
						assert((await page.locator(".connector-page").count()) === 0, "left before the answer: the answer doesn't open it again");
					} else {
						for (const go of held.splice(0)) go();
						await waitUntil(() => Promise.resolve(started.some((url) => url.includes("/in-403/"))), "the connector is checked once the list is read");
						await page.unroute("**/api/mcp/status*", hold);
						await pageButtons(page);
						assert((await page.evaluate(() => (window as any).__listSeen)) === false, "the list never shows before the page");
						await page.route("**/api/mcp/status*", hold);
					}
					await closeSettings(page);
				}
			} finally {
				page.off("request", onRequest);
				await page.unroute("**/api/mcp/status*", hold);
				for (const go of held.splice(0)) go();
			}
		}, page);

		await row(`${look} look: where the server takes neither, the page offers neither: a program, a connector with two keys`, async () => {
			const status = await api("/api/mcp/status");
			const named = (name: string) => status.body.servers.find((server: any) => server.name === name);
			assert(named("two-keys")?.key === "fixed" && named("toy-program")?.transport === "stdio", `the two stand as meant, got ${JSON.stringify([named("two-keys")?.key, named("toy-program")?.transport])}`);
			// Settings, as the person opens it from the room: the gear, then Settings in its menu.
			await page.locator("button.sidebar-config-gear, .product-sidebar-footer button, .home-gear").filter({ visible: true }).first().click();
			await page.locator(".sidebar-config-menu button, .sidebar-config-menu a").filter({ hasText: /Settings/ }).first().click();
			await page.locator(".settings-dialog-nav-item").filter({ hasText: /^Connectors$/ }).first().click();
			assert((await page.locator(".settings-dialog.settings-look-next").count() > 0) === (look === "new"), `Settings opens in the ${look} look`);
			for (const [shown, keyLine] of [["Two keys", WORDS.wentWrong.keyFixed.way], ["Toy program", null]] as const) {
				await page.locator(".settings-dialog").getByText(shown, { exact: true }).first().click();
				const buttons = await pageButtons(page);
				const key = await keyRowOf(page);
				assert(!buttons.includes(WORDS.button.signIn) && !buttons.includes(WORDS.button.changeKey), `${shown}: no Sign in and no Change key, got ${JSON.stringify(buttons)}`);
				assert(keyLine === null ? key === null : key?.line === keyLine && key?.button === false, `${shown}: its key row, got ${JSON.stringify(key)}`);
				await page.locator(".connector-page-back").click();
			}
			await closeSettings(page);
		}, page);

		await row(`${look} look: Sign in on a connector that offers no sign-in ends in the line that leads to Change key, and nothing opens`, async () => {
			await turn(page, `${look}-sign-in-press`, [callOf("open-403")]);
			await page.locator(".wk-card").last().locator(".wk-line button", { hasText: OPEN_IN_SETTINGS }).click();
			await pageButtons(page);
			await page.locator(".connector-page").getByRole("button", { name: WORDS.button.signIn, exact: true }).click();
			const said = WORDS.signInFailed.noSignInKey;
			const pageText = async () => ((await page.locator(".connector-page").textContent()) ?? "").replace(/\s+/g, " ");
			await waitUntil(async () => (await pageText()).includes(said.fact), "the line after Sign in shows").catch(async () => {
				throw new Error(`the line after Sign in never showed: the page says ${await pageText()}; the service was asked for ${JSON.stringify([...new Set(reached.map((one) => `${one.method} ${one.path}`))])}`);
			});
			const text = await pageText();
			assert(text.includes(said.fact) && text.includes(said.way), `the line after Sign in, got ${text}`);
			const buttons = await pageButtons(page);
			assert(buttons.filter((button) => button === WORDS.button.changeKey).length === 1 && !buttons.includes(WORDS.button.signIn), `Change key once, in reach, and no Sign in again, got ${JSON.stringify(buttons)}`);
			// It still connects: the page still says so, says the line once, in the Sign-in row, and keeps Change key in the Key row.
			const facts = await page.locator(".connector-page .connector-fact").evaluateAll((all) => all.map((fact) => `${fact.querySelector(".settings-row-label")?.textContent ?? ""}: ${(fact.textContent ?? "").replace(/\s+/g, " ").trim()}`));
			const signInFact = facts.find((fact) => fact.startsWith(`${WORDS.details.signIn}:`)) ?? "";
			assert(text.includes(WORDS.status.connected) && !text.includes(WORDS.status.cantSignIn) && text.split(said.fact).length === 2 && signInFact.includes(said.fact), `Connected, the line once in the Sign-in row, got ${JSON.stringify(facts)} / ${text}`);
			assert((await keyRowOf(page))?.button === true, `the Key row keeps Change key, got ${JSON.stringify(facts)}`);
			assert(!fs.existsSync(opened), `nothing opened a page, got ${fs.existsSync(opened) ? fs.readFileSync(opened, "utf8") : ""}`);
			await closeSettings(page);
		}, page);

		// The test set's cases 88, 93 and 114, and the connects, searches, lists and describes that named a key.
		const NAMED: Array<[string, Call, (step: Awaited<ReturnType<typeof lastStep>>) => string | null]> = [
			["a tool name the room doesn't know, by a connector's key with a dash (88)", { name: "mcp", arguments: { tool: "toy-space_no_such_tool", args: "{}" } }, (step) => (step.head === "Couldn't use No such tool in Toy space" && step.line === connectorFailureLine("no-such-tool", "Toy space", "computer")!.line ? null : "the head and line name Toy space")],
			["a tool of a connector that can't be reached (93)", { name: "mcp", arguments: { tool: "server-down_anything", args: "{}" } }, (step) => (step.head === "Couldn't use Anything in Server down" && step.line === connectorFailureLine("cant-connect", "Server down", "computer")!.line ? null : "the head and line name Server down")],
			["a connector's prompt by its name (114)", { name: "mcp", arguments: { tool: "toy-space_toy_prompt", args: "{}" } }, (step) => (step.head === "Couldn't use Toy prompt in Toy space" && step.line === connectorFailureLine("no-such-tool", "Toy space", "computer")!.line ? null : "the head and line name Toy space")],
			["a tool no connector of the room has", { name: "mcp", arguments: { tool: "made_up_tool", args: "{}" } }, (step) => (step.head === "Couldn't use a connector tool" && step.line === unknownToolLine("made_up_tool") ? null : "the room's own line")],
			["a connect that fails (90)", { name: "mcp", arguments: { connect: "server-down" } }, (step) => (step.head === "Couldn't reach Server down" ? null : "the head names Server down")],
			["a search of one connector", { name: "mcp", arguments: { search: "hello", server: "toy-space" } }, (step) => (step.head === "Searched connector tools for “hello” in Toy space" ? null : "the head names Toy space")],
			["a list of one connector's tools", { name: "mcp", arguments: { server: "toy-space" } }, (step) => (step.head === "Listed the tools of Toy space" ? null : "the head names Toy space")],
			["a describe of a tool", { name: "mcp", arguments: { describe: "toy_space_hello" } }, (step) => (step.head === "Read about Hello in Toy space" ? null : "the head names Hello in Toy space")],
		];
		for (const [label, call, check] of NAMED) {
			await row(`${look} look: ${label}: no search hint, no key`, async () => {
				await turn(page, `${look}-${label}`, [call]);
				const step = await lastStep(page);
				const wrong = check(step);
				assert(wrong === null, `${wrong}, got ${JSON.stringify(step)}`);
				assert(!step.text.includes("mcp(") && !/toy-space|server-down|toy_space|server_down/.test(`${step.head} ${step.line}`), `no search hint, and no key in the head or line, got ${JSON.stringify(step)}`);
			}, page);
		}
		await context.close();
	}

	// Beside the service that answers it has no sign-in: one nothing answers for (a closed port, as offline) is no proof of that.
	await row("a sign-in where nothing answers ends as a sign-in that didn't work, not as one the connector doesn't offer", async () => {
		const ended = async (name: string) => {
			const started = await api(`/api/mcp/servers/${name}/login`, { method: "POST" });
			assert(started.status === 200, `${name}: the sign-in started, got ${JSON.stringify(started)}`);
			let state: any = null;
			await waitUntil(async () => {
				state = (await api(`/api/mcp/servers/${name}/login`)).body;
				return state?.pending === false;
			}, `${name}: the sign-in ended`);
			return state?.cause;
		};
		const offline = await ended("server-down");
		assert(offline !== undefined && offline !== "no-sign-in", `nothing answered, got ${offline}`);
		assert((await ended("open-403")) === "no-sign-in", "the service that answered it has none");
		assert(!fs.existsSync(opened), "nothing opened a page");
	});

	await row("the assistant still gets the search hint for a tool the room doesn't know", async () => {
		// The room's conversation, as the page reads it back: the step keeps what the model was told.
		const threadId = (await api(`/api/persistent-agents/${encodeURIComponent(room)}/status`)).body?.runtime?.activeThreadId;
		const saved: any[] = (await api(`/api/persistent-agents/${encodeURIComponent(room)}/threads/${encodeURIComponent(String(threadId))}`)).body?.thread?.items ?? [];
		const step = saved.find((item) => item.kind === "tool" && item.args?.tool === "made_up_tool");
		assert(step && String(step.result).includes("mcp({ search"), `the saved step keeps the model's words with the search hint, got ${JSON.stringify(step ?? saved.length)}`);
	});
} finally {
	await browser?.close().catch(() => undefined);
	await stopSmokeServer(serverProcess);
	service.close();
	gateway.close();
	if (failures.length > 0) console.log(serverOutput.join("").split("\n").filter((line) => !line.includes("token=")).slice(-40).join("\n"));
	fs.rmSync(tempRoot, { recursive: true, force: true });
}
if (failures.length > 0) {
	console.log(`connector-refusal-ways-smoke: ${failures.length} failed`);
	process.exit(1);
}
console.log("connector-refusal-ways-smoke: OK");
