// A failed message says what happened, in plain words, in the browser. One
// synthetic Anthropic endpoint answers a room on a Claude API key, scripted by
// the message:
//
// - a spent credit balance (Anthropic's 400) shows the usage-limit line with
//   the balance line, and any other 400 the plain "could not answer" line;
//   neither shows the provider's JSON or sign-in advice; the provider's
//   words go to the console, and its sentence, keys masked, to a closed Details;
// - the line is a row on the answers' left edge: a red mark, the cause in
//   bold, the rest under it, a button for each way on that can work (the
//   words then leave out the place the button opens), and "Show details",
//   which opens the provider's words under "From Anthropic";
// - Try again sends what is in the box;
// - an older line folds to its cause, without buttons, and keeps its Details;
// - a connection that never reaches the provider says it could not be reached,
//   and since this endpoint is on this computer, names the app running it; no
//   connection was made, so there are no Details;
// - while the runtime retries, the note says what happened: busy (529), an
//   error at the provider (500), or a dropped connection; an attempt the
//   runtime asks again draws no failure line, not even for a moment: only the
//   attempt that ends the turn does;
// - a model still busy after the runtime's retries says so;
// - a raw red line an older build saved into the conversation shows as the
//   plain line when the conversation opens;
// - the conversation and memory more than the model reads at once: the line
//   says so with Review memory, which opens Review on the room, and Choose
//   another model; a message larger than the model's window by itself says
//   that instead, with Choose another model only, and so does a short
//   message whose text file is larger than the window; an overflow in a room
//   with nothing in memory yet, where Review has nothing to shrink, names the
//   conversation; a gateway's model that reads less than the window set for
//   it in AI setup, as its words name, says so, whatever is in memory;
// - a saved gateway's bare 404, on this computer and on a shared server, says
//   what one look at the gateway's model list found, with its button: the
//   model gone, the list not found at the saved address, the model listed,
//   or a list that could not be read; two failures read the list once, and
//   none of the gateway's own words reach the page;
// - at a phone's width the lines wrap in the column, with no sideways scroll.
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import { fileURLToPath } from "node:url";
import { chromium, type Locator } from "playwright";
import { authedFetch, SMOKE_AUTH_TOKEN, SMOKE_SERVER_AUTH_ENV, SMOKE_SERVER_SPAWN_TREE_OPTIONS, smokeHomeEnv, stopSmokeServer, freePort } from "./smoke-server-process.js";

function assert(condition: unknown, message: string): asserts condition {
	if (!condition) throw new Error(message);
}

// A machine without Chromium cannot run a browser assertion at all; skip
// whole, the same way remote-settings-readonly-smoke does.
{
	const p = typeof chromium?.executablePath === "function" ? chromium.executablePath() : "";
	if (!p || !fs.existsSync(p)) {
		console.log("room failure line smoke skipped (Chromium not installed)");
		process.exit(0);
	}
}

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const webServerDir = path.resolve(scriptDir, "..");
const repoRoot = path.resolve(webServerDir, "..", "..");
const port = await freePort();
const baseUrl = `http://127.0.0.1:${port}`;

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "exxperts-failure-line-"));
const tempHome = path.join(tempRoot, "home");
const agentsRoot = path.join(tempHome, ".exxperts", "app", "personalized-agents");
const agentDir = path.join(tempHome, ".exxperts", "agent");
for (const dir of [agentsRoot, agentDir]) fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
process.env.HOME = tempHome;
process.env.USERPROFILE = tempHome;
process.env.EXXPERTS_CODING_AGENT_DIR = agentDir;
process.env.EXXETA_PERSISTENT_AGENTS_ROOT = agentsRoot;

const KEY_PROVIDER = "anthropic-api-key";
const ON_KEY = { provider: KEY_PROVIDER, model: "claude-haiku-5-5" };
const MODEL_NAME = "Claude Haiku 5.5";
const CREDIT_WORDS = "Your credit balance is too low to access the Anthropic API. Please go to Plans & Billing to upgrade or purchase credits.";
const OVERFLOW_LINE = "The model could not respond: the conversation plus this room's memory are more than it can read at once. Run Review from Maintain to shrink memory, or continue on a model that can read more at once in Room settings, Model.";
const OLD_OVERFLOW_LINE = OVERFLOW_LINE.replace(" at once.", ' at once · 400 {"type":"error","error":{"type":"invalid_request_error","message":"prompt is too long: 210000 tokens > 200000 maximum"}}.');
// A model whose window a pasted message alone can outgrow.
const SMALL_PROVIDER = "small-provider";
const ON_SMALL = { provider: SMALL_PROVIDER, model: "small-model" };
const SMALL_WINDOW = 32_000;
// A company gateway whose model reads less than the window set for it in AI setup.
const GATEWAY_ID = "openai-compatible";
const ON_GATEWAY = { provider: GATEWAY_ID, model: "acme-reader" };
const GATEWAY_WINDOW = 32_768;
// Four saved gateways whose calls answer a bare 404; each one's /models says something else.
const NOT_FOUND_KINDS = ["gone", "address", "listed", "unread"] as const;
const NOT_FOUND_MODEL = "acme-reader";
const GATEWAY_WORDS = "Shh internal-route-9 for tenant 42";
const modelListReads = new Map<string, number>();
const OLD_RAW_LINE = `The model could not respond · 400 {"type":"error","error":{"type":"invalid_request_error","message":"${CREDIT_WORDS}"},"request_id":"req_smoke_saved"} · check the model and its sign-in in AI setup.`;

// What the endpoint does with a message, by the words of the newest user message.
const attempts = new Map<string, number>();
// Every newest user message a request carried, in order.
const sentTexts: string[] = [];
// A message that fails on the provider's server until the scene says it no longer does.
let healed = false;
function scripted(lastUserText: string): { status: number; body: unknown } | "drop" | "text" {
	const seen = (attempts.get(lastUserText) ?? 0) + 1;
	attempts.set(lastUserText, seen);
	if (/credit/i.test(lastUserText)) return { status: 400, body: { type: "error", error: { type: "invalid_request_error", message: CREDIT_WORDS }, request_id: "req_smoke_credit" } };
	if (/odd request/i.test(lastUserText)) return { status: 400, body: { type: "error", error: { type: "invalid_request_error", message: "messages.0.content: text content blocks must be non-empty" }, request_id: "req_smoke_odd" } };
	if (/busy for a while/i.test(lastUserText) && seen <= 3) return { status: 529, body: { type: "error", error: { type: "overloaded_error", message: "Overloaded" }, request_id: "req_smoke_busy_while" } };
	if (/always busy/i.test(lastUserText)) return { status: 529, body: { type: "error", error: { type: "overloaded_error", message: "Overloaded" }, request_id: "req_smoke_busy" } };
	if (/server error once/i.test(lastUserText) && seen === 1) return { status: 500, body: { type: "error", error: { type: "api_error", message: "Internal server error" }, request_id: "req_smoke_server" } };
	if (/until healed/i.test(lastUserText) && !healed) return { status: 500, body: { type: "error", error: { type: "api_error", message: "Internal server error" }, request_id: "req_smoke_until_healed" } };
	if (/dropped once/i.test(lastUserText) && seen === 1) return "drop";
	if (/always dropped/i.test(lastUserText)) return "drop";
	if (/too much to read/i.test(lastUserText)) return { status: 400, body: { type: "error", error: { type: "invalid_request_error", message: "prompt is too long: 212345 tokens > 200000 maximum" }, request_id: "req_smoke_too_long" } };
	if (/reads less/i.test(lastUserText)) return { status: 400, body: { error: { message: "This model's maximum context length is 8192 tokens. However, your messages resulted in 9100 tokens. Please reduce the length of the messages.", type: "invalid_request_error", param: "messages", code: "context_length_exceeded" } } };
	if (/leaky request/i.test(lastUserText)) return { status: 400, body: { type: "error", error: { type: "invalid_request_error", message: "The request with key sk-ant-api03-SYNTHETICabcdef0123456789 and header Bearer synthetic.token.value was refused." }, request_id: "req_smoke_leaky" } };
	return "text";
}

function lastUserText(body: any): string {
	const messages = Array.isArray(body?.messages) ? body.messages : [];
	const last = [...messages].reverse().find((message: any) => message?.role === "user");
	const content = last?.content;
	if (typeof content === "string") return content;
	return Array.isArray(content) ? content.map((part: any) => (typeof part?.text === "string" ? part.text : "")).join("") : "";
}

function sse(res: http.ServerResponse, event: string, payload: unknown): void {
	res.write(`event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`);
}

const endpoint = http.createServer((req, res) => {
	let raw = "";
	req.on("data", (chunk) => { raw += chunk; });
	req.on("end", () => {
		const notFoundKind = NOT_FOUND_KINDS.find((kind) => req.url?.startsWith(`/nf-${kind}/`));
		if (notFoundKind) {
			const reply = (status: number, body?: unknown) => { res.writeHead(status, { "content-type": "application/json" }); res.end(body === undefined ? "" : JSON.stringify(body)); };
			if (req.method !== "GET") return reply(404);
			if (req.url === `/nf-${notFoundKind}/v1/models`) modelListReads.set(notFoundKind, (modelListReads.get(notFoundKind) ?? 0) + 1);
			if (notFoundKind === "gone") return reply(200, { object: "list", data: [{ object: "model", id: "another-reader" }] });
			if (notFoundKind === "listed") return reply(200, { object: "list", data: [{ object: "model", id: NOT_FOUND_MODEL }] });
			if (notFoundKind === "unread") return reply(401, { error: { message: GATEWAY_WORDS } });
			return reply(404);
		}
		if (req.method === "GET" && req.url?.includes("/models")) {
			res.writeHead(200, { "content-type": "application/json" });
			res.end(JSON.stringify({ object: "list", data: [{ object: "model", id: ON_GATEWAY.model }] }));
			return;
		}
		const body = JSON.parse(raw || "{}");
		const asked = lastUserText(body);
		sentTexts.push(asked);
		const answer = scripted(asked);
		if (answer === "drop") { req.socket.destroy(); return; }
		if (answer !== "text") {
			res.writeHead(answer.status, { "content-type": "application/json" });
			res.end(JSON.stringify(answer.body));
			return;
		}
		res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
		sse(res, "message_start", { type: "message_start", message: { id: "msg_smoke", type: "message", role: "assistant", model: body.model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 100, output_tokens: 1 } } });
		sse(res, "content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } });
		sse(res, "content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: `Answer from ${body.model}.` } });
		sse(res, "content_block_stop", { type: "content_block_stop", index: 0 });
		sse(res, "message_delta", { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 20 } });
		sse(res, "message_stop", { type: "message_stop" });
		res.end();
	});
});

async function waitUntil(predicate: () => Promise<boolean> | boolean, label: string, timeoutMs = 25_000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (await predicate()) return;
		await new Promise((resolve) => setTimeout(resolve, 150));
	}
	throw new Error(`timed out waiting until ${label}`);
}

let server: ChildProcessWithoutNullStreams | undefined;
const serverOutput: string[] = [];

try {
	await new Promise<void>((resolve) => endpoint.listen(0, "127.0.0.1", resolve));
	const endpointUrl = `http://127.0.0.1:${(endpoint.address() as AddressInfo).port}`;
	fs.writeFileSync(path.join(agentDir, "models.json"), JSON.stringify({ providers: {
		[KEY_PROVIDER]: { baseUrl: endpointUrl },
		[SMALL_PROVIDER]: { name: "Small Provider", baseUrl: endpointUrl, api: "anthropic-messages", models: [{ id: ON_SMALL.model, name: "Small Model", input: ["text"], contextWindow: SMALL_WINDOW, maxTokens: 4000, cost: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 } }] },
	} }, null, 2), { mode: 0o600 });
	fs.writeFileSync(path.join(agentDir, "auth.json"), JSON.stringify({ [KEY_PROVIDER]: { type: "api_key", key: "synthetic-anthropic-key" }, [SMALL_PROVIDER]: { type: "api_key", key: "synthetic-small-key" } }, null, 2), { mode: 0o600 });
	// Short waits between the runtime's own retries, so the smoke does not sit
	// through 2, 4 and 8 seconds, and no SDK retries under them, so each runtime
	// attempt is one request.
	fs.writeFileSync(path.join(agentDir, "settings.json"), JSON.stringify({ retry: { baseDelayMs: 1000, provider: { maxRetries: 0 } } }, null, 2), { mode: 0o600 });
	const agents = await import("../src/persistent-agents.js");
	const agentId = agents.createPersistentAgentFromScaffoldInput({ displayName: "Failure Room", userName: "Synthetic User", preferredUserAddress: "Synthetic User" }).agent.agentId;
	// A remembered conversation in the room's memory, so Review has something to open on.
	const remember = (roomId: string) => {
		const l1bPath = path.join(agentsRoot, roomId, "L1b", "current.md");
		const text = fs.readFileSync(l1bPath, "utf-8");
		const recent = /^##\s+Recent Context\s*$/m.exec(text)!;
		const remembered = ["### RC-0001 | CLOSED | 2026-09-09 | The renewal call", "", "**Session arc:** We went through the renewals.", "", "**Body:**", "- The Nordwind renewal is in May.", "", "**Parked:**", "None", ""].join("\n");
		fs.writeFileSync(l1bPath, `${text.slice(0, recent.index + recent[0].length)}\n\n${remembered}\n`, "utf-8");
	};
	remember(agentId);
	const smallRoomId = agents.createPersistentAgentFromScaffoldInput({ displayName: "Small Room", userName: "Synthetic User", preferredUserAddress: "Synthetic User" }).agent.agentId;
	remember(smallRoomId);
	// A room with nothing in memory yet: Review has nothing to shrink there.
	const newRoomId = agents.createPersistentAgentFromScaffoldInput({ displayName: "New Room", userName: "Synthetic User", preferredUserAddress: "Synthetic User" }).agent.agentId;
	// A room on the gateway, with memory: the window set too large is the cause before memory.
	const gatewayRoomId = agents.createPersistentAgentFromScaffoldInput({ displayName: "Gateway Room", userName: "Synthetic User", preferredUserAddress: "Synthetic User" }).agent.agentId;
	remember(gatewayRoomId);
	const notFoundRooms = Object.fromEntries(NOT_FOUND_KINDS.map((kind) => [kind, agents.createPersistentAgentFromScaffoldInput({ displayName: `Not Found ${kind} Room`, userName: "Synthetic User", preferredUserAddress: "Synthetic User" }).agent.agentId])) as Record<(typeof NOT_FOUND_KINDS)[number], string>;
	server = spawn("npx", ["tsx", "src/index.ts"], {
		shell: process.platform === "win32",
		...SMOKE_SERVER_SPAWN_TREE_OPTIONS,
		cwd: webServerDir,
		env: smokeHomeEnv(tempHome, { PORT: String(port), ...SMOKE_SERVER_AUTH_ENV, EXXETA_HOME: repoRoot, EXXPERTS_CODING_AGENT_DIR: agentDir, EXXETA_PERSISTENT_AGENTS_ROOT: agentsRoot }) as NodeJS.ProcessEnv,
	});
	server.stdout.on("data", (chunk) => serverOutput.push(String(chunk)));
	server.stderr.on("data", (chunk) => serverOutput.push(String(chunk)));
	await waitUntil(() => fetch(`${baseUrl}/healthz`).then((r) => r.ok).catch(() => false), "server ready");
	// The key's models approved and the room on one of them, as Add provider and Room settings do.
	const approved = await authedFetch(`${baseUrl}/api/persistent-agent-ai-profiles/custom`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ providerId: KEY_PROVIDER, label: "Claude API key", roomModels: [ON_KEY.model], learnModel: ON_KEY.model }) });
	assert(approved.ok, `the key's models are approved, got ${approved.status} ${await approved.text()}`);
	const picked = await authedFetch(`${baseUrl}/api/persistent-agents/${agentId}/models`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ conversation: ON_KEY }) });
	assert(picked.ok, `the room picks the key's model, got ${picked.status} ${await picked.text()}`);
	const smallApproved = await authedFetch(`${baseUrl}/api/persistent-agent-ai-profiles/custom`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ providerId: SMALL_PROVIDER, label: "Small Provider", roomModels: [ON_SMALL.model], learnModel: ON_SMALL.model }) });
	assert(smallApproved.ok, `the small model is approved, got ${smallApproved.status} ${await smallApproved.text()}`);
	const smallPicked = await authedFetch(`${baseUrl}/api/persistent-agents/${smallRoomId}/models`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ conversation: ON_SMALL }) });
	assert(smallPicked.ok, `the small room picks the small model, got ${smallPicked.status} ${await smallPicked.text()}`);
	const newPicked = await authedFetch(`${baseUrl}/api/persistent-agents/${newRoomId}/models`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ conversation: ON_KEY }) });
	assert(newPicked.ok, `the new room picks the key's model, got ${newPicked.status} ${await newPicked.text()}`);
	const gatewayMade = await authedFetch(`${baseUrl}/api/persistent-agent-ai-profiles/gateways/${GATEWAY_ID}`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ label: "Acme gateway", baseUrl: endpointUrl, key: "synthetic-gateway-key", roomModels: [{ modelId: ON_GATEWAY.model, vision: false, webSearch: false, reasoning: false, contextWindow: GATEWAY_WINDOW }], maintenanceModel: ON_GATEWAY.model }) });
	assert(gatewayMade.ok, `the gateway is set up, got ${gatewayMade.status} ${await gatewayMade.text()}`);
	const gatewayPicked = await authedFetch(`${baseUrl}/api/persistent-agents/${gatewayRoomId}/models`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ conversation: ON_GATEWAY }) });
	assert(gatewayPicked.ok, `the gateway room picks the gateway's model, got ${gatewayPicked.status} ${await gatewayPicked.text()}`);
	for (const kind of NOT_FOUND_KINDS) {
		const made = await authedFetch(`${baseUrl}/api/persistent-agent-ai-profiles/gateways`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ label: `${kind[0]!.toUpperCase()}${kind.slice(1)} gateway`, baseUrl: `${endpointUrl}/nf-${kind}/v1`, key: `synthetic-${kind}-key`, roomModels: [{ modelId: NOT_FOUND_MODEL, vision: false, webSearch: false, reasoning: false }], maintenanceModel: NOT_FOUND_MODEL }) });
		const body = await made.json();
		assert(made.ok && body?.gateway?.providerId, `the ${kind} gateway is set up, got ${made.status} ${JSON.stringify(body)}`);
		const roomPicked = await authedFetch(`${baseUrl}/api/persistent-agents/${notFoundRooms[kind]}/models`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ conversation: { provider: body.gateway.providerId, model: NOT_FOUND_MODEL } }) });
		assert(roomPicked.ok, `the ${kind} room picks its gateway's model, got ${roomPicked.status} ${await roomPicked.text()}`);
	}
	// A conversation an older build left with the provider's raw words in a red line.
	const seeded = await authedFetch(`${baseUrl}/api/persistent-agents/${agentId}/threads/c_failure_line_0001`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ state: "standby", origin: "home", items: [{ kind: "user", id: "u1", text: "Earlier question." }, { kind: "system", id: "s1", level: "error", text: OLD_RAW_LINE }, { kind: "system", id: "s2", level: "error", text: OLD_OVERFLOW_LINE }] }) });
	assert(seeded.ok, `the old conversation is saved, got ${seeded.status} ${await seeded.text()}`);

	const browser = await chromium.launch();
	try {
		const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
		const page = await ctx.newPage();
		// In the page's own order: each retry frame as it arrives, before the page reads it, and each failure line mounted in full (an older line folding is not a new one).
		await page.addInitScript({ content: 'window.__turnLog = []; var Socket = window.WebSocket; window.WebSocket = class extends Socket { constructor(a, b) { super(a, b); this.addEventListener("message", function (e) { try { var d = JSON.parse(String(e.data)); if (d && d.event && d.event.type === "auto_retry_start") window.__turnLog.push({ retry: true }); } catch (x) {} }); } }; var seen = new WeakSet(); new MutationObserver(function () { document.querySelectorAll(".failure-line").forEach(function (el) { if (!seen.has(el)) { seen.add(el); if (!el.classList.contains("is-folded")) window.__turnLog.push({ line: el.innerText.replace(/\\s+/g, " ").trim().slice(0, 120) }); } }); }).observe(document, { childList: true, subtree: true });' });
		const warnings: string[] = [];
		// Every retry frame the page receives, on every socket it opens.
		const retryFrames: any[] = [];
		page.on("websocket", (socket) => socket.on("framereceived", (frame) => {
			try {
				const data = JSON.parse(String(frame.payload));
				if (data?.event?.type === "auto_retry_start") retryFrames.push(data.event);
			} catch {}
		}));
		page.on("console", (message) => { if (message.type() === "warning") warnings.push(message.text()); });
		await page.goto(`${baseUrl}/auth/session?token=${SMOKE_AUTH_TOKEN}`);
		await page.waitForLoadState("networkidle");
		const dismiss = page.locator(".whats-new-close");
		if (await dismiss.count()) await dismiss.click();

		// What each failure line shows: the newest its cause and the rest, an older one its cause.
		const errorTexts = async () => (await page.locator(".system-line.error .system-line-text").allInnerTexts()).map((text) => text.replace(/\s+/g, " ").trim());
		const newest = () => page.locator(".failure-line:not(.is-folded)");
		const buttonsOf = async (line: Locator) => (await line.locator(".failure-actions .rs-btn").allInnerTexts()).map((text) => text.trim()).join("|");
		// Opens a line's Details: the toggle before and after, the label over the provider's words, and the words.
		const openDetails = async (line: Locator) => {
			const toggle = line.locator(".failure-details-toggle");
			if ((await toggle.count()) !== 1) return undefined;
			const closed = { expanded: await toggle.getAttribute("aria-expanded"), label: (await toggle.innerText()).trim() };
			const box = line.locator(".failure-said");
			assert(!(await box.isVisible()), "Details is closed by default");
			await toggle.click();
			await box.waitFor({ state: "visible", timeout: 5000 });
			const from = box.locator(".failure-said-from");
			return {
				closed,
				open: { expanded: await toggle.getAttribute("aria-expanded"), label: (await toggle.innerText()).trim() },
				controls: (await toggle.getAttribute("aria-controls")) === (await box.getAttribute("id")),
				from: (await from.count()) ? String(await from.textContent()).trim() : undefined,
				words: (await box.locator(".failure-said-words").innerText()).trim(),
			};
		};
		const noRawWords = async (label: string) => {
			const shown = (await errorTexts()).join("\n");
			assert(!/[{}]|invalid_request_error|overloaded_error|api_error|request_id|sign-in/i.test(shown), `${label}: no provider words or sign-in advice on the face, got ${JSON.stringify(shown)}`);
		};

		// The page's log since the last read: retry frames and mounted failure lines, in order.
		const turnLog = async () => (await page.evaluate(() => (window as any).__turnLog.splice(0))) as Array<{ retry?: true; line?: string }>;
		// An attempt the runtime asks again draws no line: none is mounted before the turn's last retry frame. `final`: the line the turn ends with, mounted after it.
		// Checked to the end of the smoke, so the scenes after a miss still run and every miss is named.
		const retryLineFailures: string[] = [];
		const linesOnlyAtTheEnd = (log: Array<{ retry?: true; line?: string }>, label: string, final?: string) => {
			const lastRetry = log.map((entry) => entry.retry === true).lastIndexOf(true);
			if (lastRetry < 0) retryLineFailures.push(`${label}: the runtime asked again, got ${JSON.stringify(log)}`);
			if (log.slice(0, lastRetry).some((entry) => entry.line)) retryLineFailures.push(`${label}: no failure line while the runtime asks again, got ${JSON.stringify(log)}`);
			const after = log.slice(lastRetry + 1).filter((entry) => entry.line);
			if (final ? !(after.length > 0 && after.every((entry) => entry.line!.startsWith(final))) : after.length > 0) retryLineFailures.push(`${label}: ${final ? "the turn ends with its line" : "an answer after the retry, and no failure line"}, got ${JSON.stringify(log)}`);
		};

		// The saved raw line shows as the plain line, folded under the saved overflow line, the newest.
		await page.locator(".persistent-agent-card").filter({ hasText: "Failure Room" }).getByRole("button", { name: "Resume →" }).click();
		await page.getByText("Earlier question.").first().waitFor({ timeout: 15000 });
		// Folded, the saved line shows its cause; it never said which model failed.
		await waitUntil(async () => (await errorTexts()).includes("The model could not answer this message."), `the saved raw line shows as the plain line, folded to its cause, got ${JSON.stringify(await errorTexts())}`, 10000);
		assert((await errorTexts()).at(-1) === OVERFLOW_LINE, `a saved overflow line keeps its words without the provider's, and with no button they are all there, got ${JSON.stringify(await errorTexts())}`);
		assert(!(await errorTexts()).some((text) => /[{}]|invalid_request_error|sign-in/.test(text)), `no provider words from history, got ${JSON.stringify(await errorTexts())}`);
		const savedLine = page.locator(".failure-line.is-folded", { hasText: "The model could not answer this message." });
		assert((await savedLine.locator(".rs-btn").count()) === 0, "a folded line has no buttons");
		const savedDetails = await openDetails(savedLine);
		assert(savedDetails?.closed.label === "Details" && savedDetails.words === CREDIT_WORDS, `the folded saved line keeps the provider's sentence under its Details, got ${JSON.stringify(savedDetails)}`);
		assert(savedDetails.from === undefined, `a saved line that never named its provider names none, got ${JSON.stringify(savedDetails.from)}`);
		console.log("  ok  a raw red line an older build saved shows as the plain line, folded with its Details, and a saved overflow line without the provider's words");

		const composer = page.locator("textarea").first();
		await page.locator('button[title="Send"]').first().waitFor({ timeout: 15000 });
		const settled = () => waitUntil(async () => (await (await authedFetch(`${baseUrl}/api/persistent-agents/${agentId}/status`)).json())?.activeThread?.inFlight === false, "the turn settled", 30000);
		const send = async (text: string) => {
			await composer.fill(text);
			await composer.press("Enter");
		};

		// A spent credit balance on a Claude API key.
		const linesBefore = (await errorTexts()).length;
		await send("A question with no credit left.");
		const quotaLine = `${MODEL_NAME} has reached its usage limit or run out of credit. Your message is back in the box. Check the balance at console.anthropic.com, or choose another model.`;
		await waitUntil(async () => (await errorTexts()).length > linesBefore, "the credit failure shows a line");
		await settled();
		await waitUntil(async () => (await errorTexts()).at(-1) === quotaLine, `a spent credit balance shows the usage-limit line with the balance line, and the button for another model in place of where it is, got ${JSON.stringify((await errorTexts()).at(-1))}`, 10000);
		await noRawWords("a spent credit balance");
		assert(warnings.some((text) => text.includes("credit balance is too low")), `the provider's words go to the console, got ${JSON.stringify(warnings)}`);
		console.log("  ok  a spent credit balance shows the usage-limit line and the balance line; the provider's words go to the console");

		// The row: on the answers' left edge, a red mark, the cause in bold, the rest under it.
		assert((await newest().count()) === 1, `one newest line, got ${await newest().count()}`);
		assert((await newest().locator(":scope > .failure-mark[aria-hidden='true']").count()) === 1, "the line starts with a mark, hidden from screen readers");
		assert((await newest().locator(".failure-cause").innerText()).trim() === `${MODEL_NAME} has reached its usage limit or run out of credit.`, `the cause comes first, got ${JSON.stringify(await newest().locator(".failure-cause").innerText())}`);
		assert((await newest().locator(".failure-next").innerText()).trim() === "Your message is back in the box. Check the balance at console.anthropic.com, or choose another model.", `then where the message is and the way on, got ${JSON.stringify(await newest().locator(".failure-next").innerText())}`);
		// No named functions inside: the page cannot run the helper the smoke's compiler wraps them in.
		const layout = await page.evaluate(() => {
			const row = document.querySelector(".failure-line:not(.is-folded)")!;
			const mark = row.querySelector(".failure-mark")!;
			const cause = getComputedStyle(row.querySelector(".failure-cause")!);
			return {
				markLeft: mark.getBoundingClientRect().left,
				railLeft: document.querySelector(".bubble-row")!.getBoundingClientRect().left,
				bodyRight: row.querySelector(".failure-body")!.getBoundingClientRect().right,
				align: getComputedStyle(row).textAlign,
				causeWeight: Number(cause.fontWeight),
				causeSize: cause.fontSize,
				nextSize: getComputedStyle(row.querySelector(".failure-next")!).fontSize,
				markFill: getComputedStyle(mark).backgroundColor,
				causeWrap: cause.textWrapStyle,
				nextWrap: getComputedStyle(row.querySelector(".failure-next")!).textWrapStyle,
			};
		});
		assert(Math.abs(layout.markLeft - layout.railLeft) <= 1, `the row starts on the answers' left edge, got the mark at ${layout.markLeft} and the column at ${layout.railLeft}`);
		assert(layout.bodyRight - layout.railLeft <= 702, `the row is at most about 700px wide, got ${layout.bodyRight - layout.railLeft}`);
		assert(/^(left|start)$/.test(layout.align), `the row is never centred, got ${layout.align}`);
		assert(layout.causeWeight >= 600 && layout.causeSize === "14px" && layout.nextSize === "14px", `the cause is semi-bold at 14px and the rest 14px, got ${JSON.stringify(layout)}`);
		assert(layout.markFill !== "rgba(0, 0, 0, 0)", `the newest line's mark is filled, got ${layout.markFill}`);
		assert(layout.causeWrap === "pretty" && layout.nextWrap === "pretty", `the cause and the rest wrap with no word left alone on their last line, got ${layout.causeWrap} and ${layout.nextWrap}`);
		// One button: Try again cannot help with credit; the words name the balance, and the button the other way on.
		assert((await buttonsOf(newest())) === "Choose another model", `credit offers only Choose another model, got ${JSON.stringify(await buttonsOf(newest()))}`);
		// Details: a button, closed, that opens the provider's own words under its name.
		const creditDetails = await openDetails(newest());
		assert(creditDetails?.closed.expanded === "false" && creditDetails.closed.label === "Show details" && creditDetails.open.expanded === "true" && creditDetails.open.label === "Hide details" && creditDetails.controls, `Show details is a button that says what it does and that it opened, got ${JSON.stringify(creditDetails)}`);
		assert(creditDetails.from === "From Anthropic", `the words are headed with the provider's name, got ${JSON.stringify(creditDetails.from)}`);
		assert(creditDetails.words === CREDIT_WORDS, `Details holds the provider's sentence, without its JSON, got ${JSON.stringify(creditDetails.words)}`);
		await newest().getByRole("button", { name: "Choose another model" }).click();
		await page.locator(".room-model-section").waitFor({ timeout: 10000 });
		await page.keyboard.press("Escape");
		await page.locator(".room-model-section").waitFor({ state: "detached", timeout: 10000 });
		console.log("  ok  the line is a row on the answers' edge: a mark, the cause, then the rest, one button for the way on, and the provider's words under Show details");

		// Any other 400.
		await composer.fill("");
		await send("An odd request, please.");
		await waitUntil(async () => (await errorTexts()).length > linesBefore + 1, "the odd request shows a line");
		await settled();
		const plainOther = `${MODEL_NAME} could not answer this message. Your message is back in the box. Try again; if it repeats, choose another model.`;
		await waitUntil(async () => (await errorTexts()).at(-1) === plainOther, `any other failure shows the plain line, got ${JSON.stringify((await errorTexts()).at(-1))}`, 10000);
		await noRawWords("any other failure");
		assert((await buttonsOf(newest())) === "Try again|Choose another model", `any other failure offers Try again and Choose another model, got ${JSON.stringify(await buttonsOf(newest()))}`);
		console.log("  ok  any other failure shows the plain line, with no JSON and no sign-in advice");

		// The second failure folds the first: its cause, no buttons, its Details kept.
		const creditFolded = page.locator(".failure-line.is-folded", { hasText: `${MODEL_NAME} has reached its usage limit or run out of credit.` });
		assert((await creditFolded.count()) === 1, `the credit line folds once another failure follows, got ${await creditFolded.count()}`);
		assert((await creditFolded.locator(".system-line-text").innerText()).trim() === `${MODEL_NAME} has reached its usage limit or run out of credit.` && (await creditFolded.locator(".rs-btn").count()) === 0, `a folded line shows only its cause, with no buttons, got ${JSON.stringify(await creditFolded.innerText())}`);
		assert((await creditFolded.locator(":scope > .failure-mark").evaluate((mark) => getComputedStyle(mark).backgroundColor)) === "rgba(0, 0, 0, 0)", "a folded line's mark is hollow");
		const foldedDetails = await openDetails(creditFolded);
		assert(foldedDetails?.closed.label === "Details" && foldedDetails.words === CREDIT_WORDS && foldedDetails.from === "From Anthropic", `a folded line keeps its Details, got ${JSON.stringify(foldedDetails)}`);
		console.log("  ok  the next failure folds the first to its cause, without buttons, and its Details stay");

		// At a phone's width the lines wrap in the column, with no sideways scroll.
		await page.setViewportSize({ width: 390, height: 844 });
		await page.waitForTimeout(500);
		const narrow = await page.evaluate(() => {
			const messages = document.querySelector(".messages")!;
			const row = document.querySelector(".failure-line:not(.is-folded)")!.getBoundingClientRect();
			return { scroll: messages.scrollWidth, client: messages.clientWidth, page: document.documentElement.scrollWidth, width: window.innerWidth, rowRight: row.right };
		});
		assert(narrow.scroll <= narrow.client + 1 && narrow.page <= narrow.width + 1 && narrow.rowRight <= narrow.width, `at 390px nothing scrolls sideways, got ${JSON.stringify(narrow)}`);
		await page.setViewportSize({ width: 1280, height: 900 });
		await page.waitForTimeout(500);
		console.log("  ok  at a phone's width the line wraps in the column");

		// Details masks anything that looks like a key or a token.
		await composer.fill("");
		await send("A leaky request, please.");
		await waitUntil(async () => (await errorTexts()).length > linesBefore + 2, "the leaky request shows a line");
		await settled();
		const leakyDetails = await openDetails(newest());
		assert(leakyDetails?.words === "The request with key sk-… and header Bearer … was refused.", `Details masks keys and tokens, got ${JSON.stringify(leakyDetails)}`);
		console.log("  ok  Details shows the provider's sentence, closed by default, keys and tokens masked");

		// A connection that never reaches the provider.
		await composer.fill("");
		const linesBeforeDrop = (await errorTexts()).length;
		await send("Always dropped, sorry.");
		await waitUntil(async () => (await errorTexts()).length > linesBeforeDrop, "the dropped connection shows a line", 30000);
		await settled();
		assert((await errorTexts()).at(-1) === `${MODEL_NAME} could not be reached on this computer. Your message is back in the box. Check that the app running it is open, then try again.`, `a connection that never reached the provider on this computer says so, got ${JSON.stringify((await errorTexts()).at(-1))}`);
		await noRawWords("a dropped connection");
		assert((await buttonsOf(newest())) === "Try again", `a connection that may come back offers Try again, got ${JSON.stringify(await buttonsOf(newest()))}`);
		assert((await newest().locator(".failure-details-toggle").count()) === 0, `no connection was made, so no Details, got ${JSON.stringify(await newest().innerText())}`);
		console.log("  ok  a connection that never reaches the provider on this computer says the model could not be reached there, with Try again and no Details");

		// The retry notes say what happened, and a retried attempt draws no line.
		await composer.fill("");
		await turnLog();
		await send("A server error once, then an answer.");
		await page.getByText(`${MODEL_NAME} hit an error at its provider. Trying again…`).waitFor({ timeout: 15000 });
		await page.getByText("Answer from claude-haiku-5-5.").first().waitFor({ timeout: 20000 });
		await settled();
		linesOnlyAtTheEnd(await turnLog(), "a server error once");
		await send("Dropped once, then an answer.");
		await page.getByText("Connection hiccup. Retrying…").waitFor({ timeout: 15000 });
		await page.getByText("Answer from claude-haiku-5-5.").nth(1).waitFor({ timeout: 20000 });
		await settled();
		linesOnlyAtTheEnd(await turnLog(), "a dropped connection once");
		assert((await newest().count()) === 0, "with answers after them, every line is folded");
		console.log("  ok  while retrying, the note names an error at the provider, or a dropped connection");

		// Busy through every retry.
		const linesBeforeBusy = (await errorTexts()).length;
		await turnLog();
		await send("Always busy, sorry.");
		await page.getByText(`${MODEL_NAME} is busy. Trying again…`).waitFor({ timeout: 15000 });
		await waitUntil(async () => (await errorTexts()).length > linesBeforeBusy, "the busy failure shows a line", 30000);
		await settled();
		assert((await errorTexts()).at(-1) === `${MODEL_NAME} is still busy after several tries. Your message is back in the box. Try again in a minute.`, `a model busy after the retries says so, got ${JSON.stringify((await errorTexts()).at(-1))}`);
		assert((await page.getByText(/Trying again…|Retrying…/).count()) === 0, "the retry note is gone once the retries end");
		await noRawWords("busy after the retries");
		linesOnlyAtTheEnd(await turnLog(), "busy through every retry", `${MODEL_NAME} is still busy after several tries.`);
		console.log("  ok  while retrying, the note says the model is busy; after the retries, the line says it is still busy");

		// An error at the provider through every retry: Try again and Choose another model, and Try again sends what is in the box.
		await composer.fill("");
		const linesBeforeServer = (await errorTexts()).length;
		await turnLog();
		await send("A server error until healed, please.");
		await waitUntil(async () => (await errorTexts()).length > linesBeforeServer, "the server error shows a line", 40000);
		await settled();
		linesOnlyAtTheEnd(await turnLog(), "a server error through every retry", `${MODEL_NAME} could not answer this message.`);
		await waitUntil(async () => (await composer.inputValue()) === "A server error until healed, please.", `the message is back in the box, got ${JSON.stringify(await composer.inputValue())}`, 10000);
		assert((await errorTexts()).at(-1) === `${MODEL_NAME} could not answer this message. Your message is back in the box. Try again; if it repeats, choose another model.`, `an error at the provider says the model could not answer, got ${JSON.stringify((await errorTexts()).at(-1))}`);
		assert((await buttonsOf(newest())) === "Try again|Choose another model", `a server error offers Try again and Choose another model, got ${JSON.stringify(await buttonsOf(newest()))}`);
		healed = true;
		await composer.fill("A server error until healed, asked again.");
		const sentBefore = sentTexts.length;
		const answersBefore = await page.getByText("Answer from claude-haiku-5-5.").count();
		await newest().getByRole("button", { name: "Try again" }).click();
		await waitUntil(() => sentTexts.slice(sentBefore).includes("A server error until healed, asked again."), `Try again sends what is in the box, got ${JSON.stringify(sentTexts.slice(sentBefore))}`, 15000);
		await waitUntil(async () => (await page.getByText("Answer from claude-haiku-5-5.").count()) > answersBefore, "the message sent again is answered", 20000);
		await settled();
		assert((await composer.inputValue()) === "", `the box is empty once its text is sent, got ${JSON.stringify(await composer.inputValue())}`);
		assert((await newest().count()) === 0, "with the answer after it, the line folds");
		console.log("  ok  a server error offers Try again and Choose another model; Try again sends what is in the box");

		// A page that comes back while the runtime retries names the model from the retry itself.
		await send("Busy for a while, then an answer.");
		await page.getByText(`${MODEL_NAME} is busy. Trying again…`).waitFor({ timeout: 15000 });
		await page.reload();
		await page.waitForLoadState("domcontentloaded");
		const noteAfterReload = page.getByText(/is busy\. Trying again…/);
		await noteAfterReload.first().waitFor({ timeout: 20000 });
		const shownNote = (await noteAfterReload.first().innerText()).trim();
		assert(shownNote === `${MODEL_NAME} is busy. Trying again…`, `after a reload mid-retry the note names the model, got ${JSON.stringify(shownNote)}`);
		await settled();
		assert(retryFrames.length > 0 && retryFrames.every((frame) => frame.model?.provider === "anthropic-api-key" && frame.model?.model === "claude-haiku-5-5"), `every retry frame carries the model it retries, got ${JSON.stringify(retryFrames.map((frame) => frame.model ?? null))}`);
		console.log("  ok  a reload mid-retry: the note still names the model, which every retry frame carries");

		// The two lines for too much at once, each checked to the end so every miss is named.
		const sizeFailures: string[] = [];
		const expect = (condition: unknown, message: string) => { if (!condition) sizeFailures.push(message); };

		// The conversation and the room's memory more than the model reads at once: Review memory, beside Choose another model.
		const composerState = async () => JSON.stringify({ stop: await page.locator(".stop-btn").count(), send: await page.locator('button[title="Send"]').count(), box: (await composer.inputValue()).slice(0, 60) });
		const stateAfterReload = await composerState();
		await page.goto(`${baseUrl}/`);
		await page.waitForLoadState("networkidle");
		await page.locator(".persistent-agent-card").filter({ hasText: "Failure Room" }).getByRole("button", { name: /^(Enter|Resume) →$/ }).click();
		await page.locator('button[title="Send"]').first().waitFor({ timeout: 15000 });
		await page.waitForTimeout(800);
		await composer.fill("");
		const linesBeforeOverflow = (await errorTexts()).length;
		await send("Too much to read at once, with memory.");
		await waitUntil(async () => (await errorTexts()).length > linesBeforeOverflow, `the overflow shows a line (the room after the reload: ${stateAfterReload}; now ${await composerState()})`);
		await settled();
		const overflowShown = `${MODEL_NAME} can't read this conversation and the room's memory at once. Your message is back in the box. Shrink memory with Review, or continue on a model that can read more at once.`;
		await waitUntil(async () => (await errorTexts()).at(-1) === overflowShown, "the overflow line", 10000).catch(() => {});
		expect((await errorTexts()).at(-1) === overflowShown, `the overflow line names memory and Review, got ${JSON.stringify((await errorTexts()).at(-1))}`);
		expect((await buttonsOf(newest())) === "Review memory|Choose another model", `an overflow offers Review memory and Choose another model, got ${JSON.stringify(await buttonsOf(newest()))}`);
		await noRawWords("an overflow");
		const review = newest().getByRole("button", { name: "Review memory" });
		if (await review.count()) {
			await review.click();
			await page.locator('[aria-label="Review workflow"]').waitFor({ timeout: 20000 }).catch(() => {});
			expect(await page.locator('[aria-label="Review workflow"]').count(), "Review memory opens Review");
			await waitUntil(() => page.url().endsWith(`#/maintain/${agentId}`), "Review on this room", 10000).catch(() => {});
			expect(page.url().endsWith(`#/maintain/${agentId}`), `Review opens on this room, got ${page.url()}`);
		}

		// A message larger than the model's whole window by itself: shrinking memory cannot help, so the line says so.
		await page.goto(`${baseUrl}/`);
		await page.waitForLoadState("networkidle");
		await page.locator(".persistent-agent-card").filter({ hasText: "Small Room" }).getByRole("button", { name: /^(Enter|Resume) →$/ }).click();
		await page.locator('button[title="Send"]').first().waitFor({ timeout: 15000 });
		await page.waitForTimeout(800);
		// About 35,000 tokens by the app's estimate, over the small model's 32,000.
		const huge = `Too much to read at once, pasted. ${"A long pasted line of notes. ".repeat(4900)}`;
		await composer.fill(huge);
		await composer.press("Enter");
		await waitUntil(async () => (await errorTexts()).length > 0, "the large message shows a line", 30000);
		await waitUntil(async () => (await (await authedFetch(`${baseUrl}/api/persistent-agents/${smallRoomId}/status`)).json())?.activeThread?.inFlight === false, "the small room's turn settled", 30000);
		const overWindowShown = "Small Model can't read this message at once. Your message is back in the box. Shorten it, or continue on a model that can read more at once.";
		await waitUntil(async () => (await errorTexts()).at(-1) === overWindowShown, "the large message's line", 10000).catch(() => {});
		expect((await errorTexts()).at(-1) === overWindowShown, `a message over the window by itself says so, got ${JSON.stringify((await errorTexts()).at(-1))}`);
		expect((await buttonsOf(newest())) === "Choose another model", `a message over the window offers Choose another model only, got ${JSON.stringify(await buttonsOf(newest()))}`);
		expect((await composer.inputValue()).trim() === huge.trim(), `the large message is back in the box, got ${(await composer.inputValue()).length} characters of ${huge.length}`);

		// A short message whose text file alone is larger than the window: the file is part of the message, so the line names the message.
		await composer.fill("");
		const linesBeforeFile = (await errorTexts()).length;
		// About 36,000 tokens by the app's estimate, over the small model's 32,000.
		await page.locator(".composer-attach-input").setInputFiles({ name: "notes.txt", mimeType: "text/plain", buffer: Buffer.from("A line of pasted notes, kept.\n".repeat(4800)) });
		await page.locator(".composer-staged-card:not(.uploading)").waitFor({ timeout: 15000 });
		await send("Too much to read at once, with a file.");
		await waitUntil(async () => (await errorTexts()).length > linesBeforeFile, "the message with a large file shows a line", 30000);
		await waitUntil(async () => (await (await authedFetch(`${baseUrl}/api/persistent-agents/${smallRoomId}/status`)).json())?.activeThread?.inFlight === false, "the small room's turn settled", 30000);
		const fileOverWindowShown = "Small Model can't read this message at once. Your message is still above. Shorten it, or continue on a model that can read more at once.";
		await waitUntil(async () => (await errorTexts()).at(-1) === fileOverWindowShown, "the large file's line", 10000).catch(() => {});
		expect((await errorTexts()).at(-1) === fileOverWindowShown, `a short message with a text file over the window says the message is too large, got ${JSON.stringify((await errorTexts()).at(-1))}`);
		expect((await buttonsOf(newest())) === "Choose another model", `a message with a file over the window offers Choose another model only, got ${JSON.stringify(await buttonsOf(newest()))}`);

		// An overflow in a room with nothing in memory yet, the message short: no memory advice and no Review, which has nothing there to shrink.
		await page.goto(`${baseUrl}/`);
		await page.waitForLoadState("networkidle");
		await page.locator(".persistent-agent-card").filter({ hasText: "New Room" }).getByRole("button", { name: /^(Enter|Resume|Start) →$/ }).click();
		await page.locator('button[title="Send"]').first().waitFor({ timeout: 15000 });
		await page.waitForTimeout(800);
		await composer.fill("");
		await send("Too much to read at once, in a new room.");
		await waitUntil(async () => (await errorTexts()).length > 0, "the new room's overflow shows a line", 30000);
		await waitUntil(async () => (await (await authedFetch(`${baseUrl}/api/persistent-agents/${newRoomId}/status`)).json())?.activeThread?.inFlight === false, "the new room's turn settled", 30000);
		const newRoomShown = `${MODEL_NAME} can't read this conversation at once. Your message is back in the box. Continue on a model that can read more at once.`;
		await waitUntil(async () => (await errorTexts()).at(-1) === newRoomShown, "the new room's line", 10000).catch(() => {});
		expect((await errorTexts()).at(-1) === newRoomShown, `an overflow in a room with nothing in memory, the message short, names the conversation, not memory or the message, got ${JSON.stringify((await errorTexts()).at(-1))}`);
		expect((await buttonsOf(newest())) === "Choose another model", `an overflow in a room with nothing in memory offers Choose another model only, got ${JSON.stringify(await buttonsOf(newest()))}`);

		// A gateway's model that reads less than the window set for it in AI setup, in a room with memory: the number is the cause.
		await page.goto(`${baseUrl}/`);
		await page.waitForLoadState("networkidle");
		await page.locator(".persistent-agent-card").filter({ hasText: "Gateway Room" }).getByRole("button", { name: /^(Enter|Resume|Start) →$/ }).click();
		await page.locator('button[title="Send"]').first().waitFor({ timeout: 15000 });
		await page.waitForTimeout(800);
		await composer.fill("");
		await send("A question this model reads less of.");
		await waitUntil(async () => (await errorTexts()).length > 0, "the gateway room's overflow shows a line", 30000);
		await waitUntil(async () => (await (await authedFetch(`${baseUrl}/api/persistent-agents/${gatewayRoomId}/status`)).json())?.activeThread?.inFlight === false, "the gateway room's turn settled", 30000);
		const readsLess = /^(.+) can read only 8,192 tokens at once, less than the context window set in AI setup \(32,768\)\. Your message is back in the box\. Correct it in AI setup, or choose another model\.$/;
		await waitUntil(async () => readsLess.test((await errorTexts()).at(-1) ?? ""), "the gateway room's line", 10000).catch(() => {});
		expect(readsLess.test((await errorTexts()).at(-1) ?? ""), `a gateway's model that reads less than its window in AI setup says so, before memory, got ${JSON.stringify((await errorTexts()).at(-1))}`);
		expect((await buttonsOf(newest())) === "Choose another model", `a model that reads less than its window offers Choose another model only, got ${JSON.stringify(await buttonsOf(newest()))}`);
		const readsLessCause = (await newest().locator(".failure-cause").allInnerTexts()).join("").trim();
		expect(/can read only 8,192 tokens at once, less than the context window set in AI setup \(32,768\)\.$/.test(readsLessCause), `the number is the cause, in bold, got ${JSON.stringify(readsLessCause)}`);
		assert(sizeFailures.length === 0, `too much at once:\n  ${sizeFailures.join("\n  ")}`);
		console.log("  ok  an overflow says the conversation and memory are too much at once, and Review memory opens Review on the room");
		console.log("  ok  a message larger than the model's window by itself says so, with Choose another model and no Review");
		console.log("  ok  so does a short message whose text file is larger than the window; an overflow in a room with nothing in memory names the conversation");
		console.log("  ok  a gateway's model that reads less than the window set in AI setup names both numbers, before memory, with Choose another model");
		assert(retryLineFailures.length === 0, `a retried attempt drew a line:\n  ${retryLineFailures.join("\n  ")}`);
		console.log("  ok  an attempt the runtime asks again draws no failure line; the attempt that ends the turn does");
		await ctx.close();

		// A saved gateway's bare 404: the line says what the gateway's list found, on this computer and then on a shared server.
		const NOT_FOUND_LINES = {
			gone: ["Gone gateway no longer has Acme Reader. Your message is back in the box. Choose one of its current models.", "Choose another model"],
			address: ["Address gateway isn't answering at its saved address. Your message is back in the box. Check the address.", "Open AI setup"],
			listed: ["Listed gateway lists Acme Reader but couldn't run it. Your message is back in the box. Try again later, or tell whoever runs the gateway.", "Try again"],
			unread: ["Unread gateway could not find Acme Reader. Your message is back in the box. Check the gateway.", "Open AI setup"],
		};
		const NOT_FOUND_SHARED = {
			gone: ["Gone gateway no longer has Acme Reader. Your message is back in the box. Choose one of its current models, or tell your admin.", "Choose another model"],
			address: ["Address gateway isn't answering at its saved address. Your message is back in the box. Tell your admin.", ""],
			listed: ["Listed gateway lists Acme Reader but couldn't run it. Your message is back in the box. Try again later, or tell your admin.", "Try again"],
			unread: ["Unread gateway could not find Acme Reader. Your message is back in the box. Tell your admin.", ""],
		};
		const notFoundFailures: string[] = [];
		const framesSeen: string[] = [];
		// Saving a gateway and the start-up refresh read its list too; only the reads from here on count.
		modelListReads.clear();
		for (const shared of [false, true]) {
			const where = shared ? "shared" : "this computer";
			const notFoundCtx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
			await notFoundCtx.route("**/api/remote/client-context", (route) => route.fulfill({ contentType: "application/json", body: JSON.stringify({ remote: false, capability: "full", sharedServer: shared }) }));
			const notFoundPage = await notFoundCtx.newPage();
			notFoundPage.on("websocket", (socket) => socket.on("framereceived", (frame) => framesSeen.push(String(frame.payload))));
			await notFoundPage.goto(`${baseUrl}/auth/session?token=${SMOKE_AUTH_TOKEN}`);
			await notFoundPage.waitForLoadState("networkidle");
			const closeNews = notFoundPage.locator(".whats-new-close");
			if (await closeNews.count()) await closeNews.click();
			const shownLines = async () => (await notFoundPage.locator(".failure-line:not(.is-folded) .system-line-text").allInnerTexts()).map((text) => text.replace(/\s+/g, " ").trim());
			for (const kind of NOT_FOUND_KINDS) {
				const [line, buttons] = (shared ? NOT_FOUND_SHARED : NOT_FOUND_LINES)[kind];
				await notFoundPage.goto(`${baseUrl}/`);
				await notFoundPage.waitForLoadState("networkidle");
				await notFoundPage.locator(".persistent-agent-card").filter({ hasText: `Not Found ${kind} Room` }).getByRole("button", { name: /^(Enter|Resume|Start) →$/ }).click();
				await notFoundPage.locator('button[title="Send"]').first().waitFor({ timeout: 15000 });
				await notFoundPage.waitForTimeout(800);
				const box = notFoundPage.locator("textarea").first();
				await box.fill(`A question the ${kind} gateway cannot find${shared ? ", again" : ""}.`);
				await box.press("Enter");
				await waitUntil(async () => (await shownLines()).at(-1) === line, `${where}, ${kind}: the line`, 20000).catch(() => {});
				const shown = (await shownLines()).at(-1);
				const offered = (await notFoundPage.locator(".failure-line:not(.is-folded) .failure-actions .rs-btn").allInnerTexts()).map((text) => text.trim()).filter((text) => !/details/i.test(text)).join("|");
				if (shown !== line) notFoundFailures.push(`${where}, ${kind}: the line, got ${JSON.stringify(shown)}`);
				if (offered !== buttons) notFoundFailures.push(`${where}, ${kind}: the buttons, got ${JSON.stringify(offered)}`);
				if (!shared && kind === "address" && offered === "Open AI setup") {
					await notFoundPage.locator(".failure-line:not(.is-folded)").getByRole("button", { name: "Open AI setup" }).click();
					await notFoundPage.locator(".ai-setup-page").first().waitFor({ timeout: 10000 }).catch(() => notFoundFailures.push("Open AI setup opens AI setup"));
					await notFoundPage.keyboard.press("Escape");
				}
			}
			await notFoundCtx.close();
		}
		// Two failures on each gateway (this computer, then the shared page) read its list once.
		for (const kind of NOT_FOUND_KINDS) if (modelListReads.get(kind) !== 1) notFoundFailures.push(`${kind}: two failures read the list once, got ${modelListReads.get(kind)}`);
		// Only the outcome and the room's model travel: none of the gateway's words, and never its list.
		if (framesSeen.some((frame) => frame.includes("internal-route") || frame.includes("Shh") || frame.includes("another-reader"))) notFoundFailures.push("a frame carried the gateway's own words or its list");
		const findFrames = framesSeen.map((frame) => { try { return JSON.parse(frame); } catch { return null; } }).filter((frame) => frame?.type === "gateway_not_found");
		if (findFrames.length < NOT_FOUND_KINDS.length * 2 || findFrames.some((frame) => JSON.stringify(Object.keys(frame).sort()) !== JSON.stringify(["find", "model", "type"]))) notFoundFailures.push(`each failure's look is one frame with the outcome and the model only, got ${JSON.stringify(findFrames)}`);
		assert(notFoundFailures.length === 0, `a saved gateway's bare 404:\n  ${notFoundFailures.join("\n  ")}`);
		console.log("  ok  a saved gateway's bare 404 says what its model list found, with its button, on this computer and on a shared server; two failures read the list once; none of the gateway's words reach the page");
	} finally {
		await browser.close();
	}
	console.log("room-failure-line smoke: ok");
} catch (error) {
	console.error(serverOutput.join("").slice(-6000));
	throw error;
} finally {
	try { (endpoint as any).closeAllConnections?.(); } catch {}
	try { endpoint.close(); } catch {}
	await stopSmokeServer(server);
	fs.rmSync(tempRoot, { recursive: true, force: true });
}
