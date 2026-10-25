// A failed message goes back in the box, and Send waits while a retry runs,
// in the browser against one synthetic Anthropic endpoint on a Claude API key:
//
// - a message the model could not answer leaves the conversation: its bubble
//   goes, its text is back in the box, the line under it says so, and the
//   next request no longer carries it;
// - it is back in the box after a reload, and after a failure that ended
//   while nobody was in the room; left there, it comes back on every open
//   with its one line, a model switch after the line included;
// - while the runtime retries, the box shows Stop, and Stop ends the retry;
//   Send never comes back between a failed attempt and its retry;
// - a message sent while another answer is still running goes back in the
//   box with a plain line, its files' chips with it, and the running answer
//   still ends well; the line passes: it goes once that turn is over, and is
//   never saved;
// - Stop while it retries, a reload while it
//   retries, the connection lost while it retries, the app stopping while it
//   retries, and something typed in the box meanwhile each end true: back in
//   the box, or still above;
// - an answer cut off mid-way stays above with the message, one line, and
//   the box as the person left it, when the room is left and opened again,
//   any number of times; Try again has the model answer the message again,
//   which reaches it once, and its answer lands below the line; cut off
//   while nobody was there, the partial lands once and its turn ends failed:
//   Home never says a response is ready;
// - a message with a file stays above when it fails, and Try again asks
//   again with its file's note, never sending it twice;
// - cut off in a step while nobody was there, a message back in the box lands
//   no step and no question; one that stays above (a file note) still lands
//   its steps;
// - a refused key leaves only the key notice, with the failure lines' mark,
//   which on the way in also says why when the key was refused while nobody
//   was in the room; while it shows, the workspace hint waits, and it is back
//   once the notice goes; a message with a file note stays where it was;
// - a scheduled task that fails in the room's conversation, with Bash on or
//   off, keeps its failure where it is: nothing lands in the box at the next
//   open, since only a message the person typed is ever handed back.
// - a new message whose first attempt the runtime asks again leaves the last
//   turn's line where it is;
// - after a Try again refused before it began (the app stopping, or the
//   connection lost), the next message is one of its own: refused while an
//   answer runs, it is handed back with its line;
// - Try again for a message that cannot go whole again (its file gone from
//   the room's Files) sends nothing: its words go back in the box, focused,
//   and its line says so; with a draft in the box, or no words of its own,
//   the box stays as it is and the line says it can't be sent again as it was.
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { authedFetch, SMOKE_AUTH_HEADERS, SMOKE_AUTH_TOKEN, SMOKE_SERVER_AUTH_ENV, SMOKE_SERVER_SPAWN_TREE_OPTIONS, smokeHomeEnv, stopSmokeServer, killSmokeServer, freePort } from "./smoke-server-process.js";

function assert(condition: unknown, message: string): asserts condition {
	if (!condition) throw new Error(message);
}

// A machine without Chromium cannot run a browser assertion at all; skip
// whole, the same way remote-settings-readonly-smoke does.
{
	const p = typeof chromium?.executablePath === "function" ? chromium.executablePath() : "";
	if (!p || !fs.existsSync(p)) {
		console.log("room failed message returns smoke skipped (Chromium not installed)");
		process.exit(0);
	}
}

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const webServerDir = path.resolve(scriptDir, "..");
const repoRoot = path.resolve(webServerDir, "..", "..");
const port = await freePort();
const baseUrl = `http://127.0.0.1:${port}`;

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "exxperts-failed-message-"));
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
const SECOND = { provider: KEY_PROVIDER, model: "claude-sonnet-5-5" };
const MODEL_NAME = "Claude Haiku 5.5";
const TURN_RUNNING_LINE = "The last answer is still finishing. Your message is back in the box; send it in a moment.";
const CREDIT_WORDS = "Your credit balance is too low to access the Anthropic API. Please go to Plans & Billing to upgrade or purchase credits.";

// What the endpoint does with a message, by the words of the newest user message.
const attempts = new Map<string, number>();
// Messages a scene has since let the endpoint answer.
const answerNow = new Set<string>();
function scripted(lastUserText: string): { status: number; body: unknown; delayMs?: number } | "drop" | "text" | "cut" | "cut-late" | "tool-cut" | "tool-cut-late" | "slow" {
	const seen = (attempts.get(lastUserText) ?? 0) + 1;
	attempts.set(lastUserText, seen);
	if ([...answerNow].some((text) => lastUserText.includes(text))) return "text";
	if (/credit/i.test(lastUserText)) return { status: 400, body: { type: "error", error: { type: "invalid_request_error", message: CREDIT_WORDS }, request_id: "req_smoke_credit" } };
	if (/odd request/i.test(lastUserText)) return { status: 400, body: { type: "error", error: { type: "invalid_request_error", message: "messages.0.content: text content blocks must be non-empty" }, request_id: "req_smoke_odd" } };
	if (/always busy/i.test(lastUserText)) return { status: 529, body: { type: "error", error: { type: "overloaded_error", message: "Overloaded" }, request_id: "req_smoke_busy" } };
	if (/server error once/i.test(lastUserText) && seen === 1) return { status: 500, body: { type: "error", error: { type: "api_error", message: "Internal server error" }, request_id: "req_smoke_server" } };
	if (/dropped once/i.test(lastUserText) && seen === 1) return "drop";
	// Answered late, so a scene can leave the room before the failure ends.
	const late = /while I step out/i.test(lastUserText) ? 4000 : 0;
	if (/not on account/i.test(lastUserText)) return { status: 404, body: { type: "error", error: { type: "not_found_error", message: "The model `claude-haiku-5-5` does not exist or you do not have access to it." }, request_id: "req_smoke_account" }, delayMs: late };
	if (/no longer offered/i.test(lastUserText)) return { status: 404, body: { type: "error", error: { type: "not_found_error", message: "model: claude-haiku-5-5" }, request_id: "req_smoke_offered" }, delayMs: late };
	if (/key refused/i.test(lastUserText) && late) return { status: 401, body: { type: "error", error: { type: "authentication_error", message: "invalid x-api-key" }, request_id: "req_smoke_key" }, delayMs: late };
	if (/key refused/i.test(lastUserText)) return { status: 401, body: { type: "error", error: { type: "authentication_error", message: "invalid x-api-key" }, request_id: "req_smoke_key" } };
	if (/cut off midway/i.test(lastUserText)) return late && seen === 1 ? "cut-late" : "cut";
	if (/cut off in a step/i.test(lastUserText)) return late && seen === 1 ? "tool-cut-late" : "tool-cut";
	if (/slow answer/i.test(lastUserText)) return "slow";
	return "text";
}

function lastUserText(body: any): string {
	const messages = Array.isArray(body?.messages) ? body.messages : [];
	const last = [...messages].reverse().find((message: any) => message?.role === "user");
	const content = last?.content;
	if (typeof content === "string") return content;
	return Array.isArray(content) ? content.map((part: any) => (typeof part?.text === "string" ? part.text : "")).join("") : "";
}

// Every user message each request carried, in order.
const requestUserTexts: string[][] = [];
function allUserTexts(body: any): string[] {
	const messages = Array.isArray(body?.messages) ? body.messages : [];
	return messages.filter((message: any) => message?.role === "user").map((message: any) => (typeof message.content === "string" ? message.content : Array.isArray(message.content) ? message.content.map((part: any) => (typeof part?.text === "string" ? part.text : "")).join("") : ""));
}

function sse(res: http.ServerResponse, event: string, payload: unknown): void {
	res.write(`event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`);
}

const endpoint = http.createServer((req, res) => {
	let raw = "";
	req.on("data", (chunk) => { raw += chunk; });
	req.on("end", () => {
		const body = JSON.parse(raw || "{}");
		requestUserTexts.push(allUserTexts(body));
		const answer = scripted(lastUserText(body));
		if (answer === "drop") { req.socket.destroy(); return; }
		// Cut off once the scene has left the room.
		if (answer === "cut-late") {
			setTimeout(() => {
				res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
				sse(res, "message_start", { type: "message_start", message: { id: "msg_smoke_part", type: "message", role: "assistant", model: body.model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 100, output_tokens: 1 } } });
				sse(res, "content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } });
				sse(res, "content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "A partial answer that stops" } });
				setTimeout(() => req.socket.destroy(), 100);
			}, 4000);
			return;
		}
		// Cut off while it streams a step's call, so the attempt keeps a call that never ran.
		if (answer === "tool-cut" || answer === "tool-cut-late") {
			setTimeout(() => {
				res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
				sse(res, "message_start", { type: "message_start", message: { id: "msg_smoke_step", type: "message", role: "assistant", model: body.model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 100, output_tokens: 1 } } });
				sse(res, "content_block_start", { type: "content_block_start", index: 0, content_block: { type: "tool_use", id: `toolu_smoke_${requestUserTexts.length}`, name: "read", input: {} } });
				sse(res, "content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: "{\"path\": \"notes" } });
				setTimeout(() => req.socket.destroy(), 100);
			}, answer === "tool-cut-late" ? 4000 : 0);
			return;
		}
		if (answer === "cut" || answer === "slow") {
			res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
			sse(res, "message_start", { type: "message_start", message: { id: "msg_smoke_part", type: "message", role: "assistant", model: body.model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 100, output_tokens: 1 } } });
			sse(res, "content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } });
			sse(res, "content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "A partial answer that stops" } });
			if (answer === "cut") { setTimeout(() => req.socket.destroy(), 100); return; }
			const later = setTimeout(() => {
				sse(res, "content_block_stop", { type: "content_block_stop", index: 0 });
				sse(res, "message_delta", { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 20 } });
				sse(res, "message_stop", { type: "message_stop" });
				res.end();
			}, 8000);
			req.on("close", () => clearTimeout(later));
			return;
		}
		if (answer !== "text") {
			const reply = () => {
				res.writeHead(answer.status, { "content-type": "application/json" });
				res.end(JSON.stringify(answer.body));
			};
			if (answer.delayMs) setTimeout(reply, answer.delayMs);
			else reply();
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
	fs.writeFileSync(path.join(agentDir, "models.json"), JSON.stringify({ providers: { [KEY_PROVIDER]: { baseUrl: endpointUrl } } }, null, 2), { mode: 0o600 });
	fs.writeFileSync(path.join(agentDir, "auth.json"), JSON.stringify({ [KEY_PROVIDER]: { type: "api_key", key: "synthetic-anthropic-key" } }, null, 2), { mode: 0o600 });
	// Short waits between the runtime's own retries, so the smoke does not sit
	// through 2, 4 and 8 seconds, and no SDK retries under them, so each runtime
	// attempt is one request.
	fs.writeFileSync(path.join(agentDir, "settings.json"), JSON.stringify({ retry: { baseDelayMs: 1000, provider: { maxRetries: 0 } } }, null, 2), { mode: 0o600 });
	const agents = await import("../src/persistent-agents.js");
	const agentId = agents.createPersistentAgentFromScaffoldInput({ displayName: "Failure Room", userName: "Synthetic User", preferredUserAddress: "Synthetic User" }).agent.agentId;
	const startServer = async () => {
		server = spawn("npx", ["tsx", "src/index.ts"], {
			shell: process.platform === "win32",
			...SMOKE_SERVER_SPAWN_TREE_OPTIONS,
			cwd: webServerDir,
			env: smokeHomeEnv(tempHome, { PORT: String(port), ...SMOKE_SERVER_AUTH_ENV, EXXETA_HOME: repoRoot, EXXPERTS_CODING_AGENT_DIR: agentDir, EXXETA_PERSISTENT_AGENTS_ROOT: agentsRoot }) as NodeJS.ProcessEnv,
		});
		server.stdout.on("data", (chunk) => serverOutput.push(String(chunk)));
		server.stderr.on("data", (chunk) => serverOutput.push(String(chunk)));
		await waitUntil(() => fetch(`${baseUrl}/healthz`).then((r) => r.ok).catch(() => false), "server ready", 60_000);
	};
	await startServer();
	// The key's models approved and the room on one of them, as Add provider and Room settings do.
	const approved = await authedFetch(`${baseUrl}/api/persistent-agent-ai-profiles/custom`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ providerId: KEY_PROVIDER, label: "Claude API key", roomModels: [ON_KEY.model, SECOND.model], learnModel: ON_KEY.model }) });
	assert(approved.ok, `the key's models are approved, got ${approved.status} ${await approved.text()}`);
	const picked = await authedFetch(`${baseUrl}/api/persistent-agents/${agentId}/models`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ conversation: ON_KEY }) });
	assert(picked.ok, `the room picks the key's model, got ${picked.status} ${await picked.text()}`);

	const browser = await chromium.launch();
	try {
		const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
		const page = await ctx.newPage();
		// The room's socket, passed through; a message whose text says so is refused the way the server refuses one sent while an answer runs.
		// The page's end of the room's socket, so a scene can send it a frame of its own.
		let pageSocket: { send(message: string): void } | undefined;
		// A scene can hold the server's frames after the next end of an attempt, so the moment before its retry announces itself lasts long enough to look at.
		const gap = { armed: false, holding: false, end: undefined as any };
		// A scene can answer the next Try again that continues a turn itself, never reaching the server: with a frame, or by dropping the
		// connection; the server's ready frames are counted, so a scene knows when the connection is back.
		const continueAnswer = { next: undefined as object | "drop" | undefined, readies: 0 };
		// Each such message is refused once: sent again, it goes through.
		const refusedWhileRunning = new Set<string>();
		await page.routeWebSocket(/\/ws\?/, (ws) => {
			pageSocket = ws;
			const upstream = ws.connectToServer();
			ws.onMessage((message) => {
				if (String(message).includes("Refused while running") && !refusedWhileRunning.has(String(message))) {
					refusedWhileRunning.add(String(message));
					ws.send(JSON.stringify({ type: "error", code: "turn_running", message: "persistent-agent activeThread is still running" }));
					return;
				}
				if (continueAnswer.next && String(message).includes('"type":"continue"')) {
					const answer = continueAnswer.next;
					continueAnswer.next = undefined;
					if (answer === "drop") { void upstream.close(); void ws.close(); }
					else ws.send(JSON.stringify(answer));
					return;
				}
				upstream.send(message);
			});
			const held: Array<string | Buffer> = [];
			upstream.onMessage((message) => {
				if (gap.holding) { held.push(message); return; }
				ws.send(message);
				if (String(message).includes('"type":"ready"')) continueAnswer.readies++;
				if (gap.armed && String(message).includes('"type":"agent_end"')) {
					gap.armed = false;
					gap.holding = true;
					try { gap.end = JSON.parse(String(message)).event; } catch {}
					setTimeout(() => { gap.holding = false; while (held.length) ws.send(held.shift()!); }, 1500);
				}
			});
		});
		const open = async () => {
			await page.goto(`${baseUrl}/auth/session?token=${SMOKE_AUTH_TOKEN}`);
			await page.waitForLoadState("networkidle");
			const dismiss = page.locator(".whats-new-close");
			if (await dismiss.count()) await dismiss.click();
			await page.locator(".persistent-agent-card").filter({ hasText: "Failure Room" }).getByRole("button", { name: /^(Enter|Resume) →$/ }).click();
			await page.locator('button[title="Send"], .stop-btn').first().waitFor({ timeout: 15000 });
			await page.waitForTimeout(800);
		};
		await open();

		const composer = page.locator("textarea").first();
		// What each failure line shows: the newest its cause and the rest, an older one its cause.
		const errorTexts = async () => (await page.locator(".system-line.error .system-line-text").allInnerTexts()).map((text) => text.replace(/\s+/g, " ").trim());
		const causes = async () => (await page.locator(".system-line.error .failure-cause").allInnerTexts()).map((text) => text.trim());
		// The newest answer comes after the newest failure line.
		const answerBelowNewestLine = () => page.evaluate(() => {
			const line = [...document.querySelectorAll(".system-line.error")].at(-1);
			const answer = [...document.querySelectorAll(".bubble-row:not(.user)")].filter((row) => row.textContent?.includes("Answer from claude-haiku-5-5.")).at(-1);
			return !!line && !!answer && (line.compareDocumentPosition(answer) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0;
		});
		const bubbles = (text: string) => page.locator(".bubble-row.user", { hasText: text }).count();
		const status = async () => (await (await authedFetch(`${baseUrl}/api/persistent-agents/${agentId}/status`)).json());
		const settled = () => waitUntil(async () => (await status())?.activeThread?.inFlight === false, "the turn settled", 30000);
		// Sends, and waits until the message reached the model (a refused one never does).
		const send = async (text: string, reaches = true) => {
			const before = requestUserTexts.length;
			await composer.fill(text);
			await composer.press("Enter");
			if (reaches) await waitUntil(() => requestUserTexts.slice(before).some((texts) => texts.some((typed) => typed.includes(text))), `"${text}" reached the model`);
		};
		// The newest line shows its button in place of where it is; the conversation keeps every word.
		const returnedLine = `${MODEL_NAME} could not answer this message. Your message is back in the box. Try again; if it repeats, choose another model.`;
		const returnedSaved = `${MODEL_NAME} could not answer this message. Your message is back in the box. Try again; if it repeats, choose another model in Room settings, Model.`;
		const stillBusyReturned = `${MODEL_NAME} is still busy after several tries. Your message is back in the box. Try again in a minute.`;
		const retryNotes = () => page.getByText(/Trying again…|Retrying…/).count();
		// Sends a message the model answers, and waits for that answer and the turn's end.
		const ask = async (text: string) => {
			const answers = await page.getByText("Answer from claude-haiku-5-5.").count();
			await send(text);
			await waitUntil(async () => (await page.getByText("Answer from claude-haiku-5-5.").count()) > answers, `"${text}" is answered`);
			await settled();
		};
		const inBox = async (text: string, label: string) => {
			await waitUntil(async () => (await composer.inputValue()) === text, `${label}: the message is back in the box, got ${JSON.stringify(await composer.inputValue())}`, 15000);
		};
		const isReturned = async (text: string, label: string) => {
			await inBox(text, label);
			assert((await bubbles(text)) === 0, `${label}: its bubble is gone`);
		};

		// A message the model could not answer goes back in the box, and the next request no longer carries it.
		await send("An odd request, please.");
		await isReturned("An odd request, please.", "a failed message");
		await settled();
		assert((await errorTexts()).at(-1) === returnedLine, `the line says the message is back in the box, got ${JSON.stringify((await errorTexts()).at(-1))}`);
		await send("And now a fine question.");
		await page.getByText("Answer from claude-haiku-5-5.").first().waitFor({ timeout: 20000 });
		await settled();
		const fineRequest = requestUserTexts.at(-1) ?? [];
		assert(fineRequest.some((text) => text.includes("And now a fine question.")) && !fineRequest.some((text) => text.includes("odd request")), `the next request no longer carries the failed message, got ${JSON.stringify(fineRequest)}`);
		console.log("  ok  a failed message goes back in the box, its line says so, and the next request no longer carries it");

		// After a reload it is still in the box.
		await send("An odd request again.");
		await isReturned("An odd request again.", "before the reload");
		await settled();
		await open();
		await isReturned("An odd request again.", "after the reload");
		assert((await errorTexts()).at(-1) === returnedLine, `after the reload the line still says so, got ${JSON.stringify((await errorTexts()).at(-1))}`);
		console.log("  ok  after a reload the failed message is back in the box");

		// Left in the box, it comes back on every open with one line that says so: never one more per open.
		// Two messages failed so far (the first scene's and this one), each with its own line: the older one folded to its cause.
		const backInBox = async () => (await causes()).filter((text) => text === `${MODEL_NAME} could not answer this message.`).length;
		const savedBackInBox = async () => {
			const threadId = String((await status())?.activeThread?.threadId ?? "");
			const thread = await (await authedFetch(`${baseUrl}/api/persistent-agents/${agentId}/threads/${encodeURIComponent(threadId)}`)).json();
			const items: any[] = thread?.thread?.items ?? thread?.items ?? [];
			return items.filter((item) => item?.kind === "system" && item?.text === returnedSaved).length;
		};
		assert((await backInBox()) === 2, `after the reload each failed message has one line that says the message is back in the box, got ${await backInBox()}`);
		const otherRoom = await authedFetch(`${baseUrl}/api/persistent-agents`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ displayName: "Other Room", userName: "Synthetic User", preferredUserAddress: "Synthetic User" }) });
		assert(otherRoom.status === 201, `another room is made, got ${otherRoom.status}`);
		const enter = async (name: string) => {
			await page.locator(".persistent-agent-card").filter({ hasText: name }).getByRole("button", { name: /^(Enter|Resume) →$/ }).click();
			await page.locator('button[title="Send"], .stop-btn').first().waitFor({ timeout: 15000 });
			await page.waitForTimeout(800);
		};
		const home = async () => {
			await page.evaluate(() => { window.location.hash = "#/"; });
			await page.locator(".persistent-agent-card").filter({ hasText: "Failure Room" }).waitFor({ timeout: 10000 });
		};
		await home();
		await enter("Failure Room");
		await isReturned("An odd request again.", "Home and back");
		assert((await backInBox()) === 2, `Home and back: each failed message has one line that says the message is back in the box, got ${await backInBox()}`);
		await home();
		await enter("Other Room");
		await home();
		await enter("Failure Room");
		await isReturned("An odd request again.", "another room and back");
		assert((await backInBox()) === 2, `another room and back: one line each, got ${await backInBox()}`);
		await open();
		await isReturned("An odd request again.", "a second reload");
		assert((await backInBox()) === 2, `a second reload: one line each, got ${await backInBox()}`);
		await page.waitForTimeout(1500);
		assert((await savedBackInBox()) === 2, `the saved conversation keeps one such line each, got ${await savedBackInBox()}`);
		// The line's own advice, another model, puts its "Continued on" line after it: the next opens still add none.
		const switchTo = async (to: typeof ON_KEY, name: string) => {
			const threadId = String((await status())?.activeThread?.threadId ?? "");
			const switched = await authedFetch(`${baseUrl}/api/persistent-agents/${agentId}/threads/${encodeURIComponent(threadId)}/switch-model`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(to) });
			assert(switched.ok, `the conversation moves to ${name}, got ${switched.status} ${await switched.text()}`);
			await page.getByText(`Continued on ${name}`).last().waitFor({ timeout: 15000 });
		};
		await switchTo(SECOND, "Claude Sonnet 5.5");
		await home();
		await enter("Failure Room");
		await isReturned("An odd request again.", "after a model switch, Home and back");
		assert((await backInBox()) === 2, `after a model switch, Home and back: one line each, got ${await backInBox()}`);
		await open();
		await isReturned("An odd request again.", "after a model switch, a reload");
		assert((await backInBox()) === 2, `after a model switch, a reload: one line each, got ${await backInBox()}`);
		await page.waitForTimeout(1500);
		assert((await savedBackInBox()) === 2, `after a model switch, the saved conversation keeps one such line each, got ${await savedBackInBox()}`);
		await switchTo(ON_KEY, "Claude Haiku 5.5");
		console.log("  ok  a message left in the box comes back on every open with one line, never one more per open, after a model switch too");

		// Cleared from the box, it does not come back on the next open.
		await composer.fill("");
		await page.waitForTimeout(500);
		await open();
		assert((await composer.inputValue()) === "" && (await bubbles("An odd request again.")) === 0, `a message cleared from the box stays gone after a reload, got ${JSON.stringify(await composer.inputValue())}`);
		console.log("  ok  a message cleared from the box is not handed back again on the next open");

		// While the runtime retries, the box shows Stop; Stop ends the retry, and the message goes back in the box.
		await send("Always busy, sorry.");
		await page.getByText(`${MODEL_NAME} is busy. Trying again…`).waitFor({ timeout: 15000 });
		assert((await page.locator(".stop-btn").count()) === 1 && (await page.locator('button.send-btn[aria-label="Send"]').count()) === 0, "while the runtime retries, the box shows Stop, not Send");
		// A refusal for a message sent in the moment before this window saw the retry: Stop stays while the retry runs.
		pageSocket?.send(JSON.stringify({ type: "error", code: "turn_running", message: "persistent-agent activeThread is still running" }));
		await page.waitForTimeout(300);
		assert((await page.locator(".stop-btn").count()) === 1, "after the still-finishing line, Stop stays while the retry runs");
		await composer.fill("");
		await page.locator(".stop-btn").click();
		await isReturned("Always busy, sorry.", "a message stopped while the runtime waited to try again");
		await settled();
		assert((await retryNotes()) === 0, "Stop ends the retry and its note");
		await page.getByText("Response interrupted by Stop. Your message is back in the box.").waitFor({ timeout: 5000 });
		await composer.fill("");
		await ask("A fine question after the stop.");
		assert(!(requestUserTexts.at(-1) ?? []).some((text) => text.includes("Always busy, sorry.")), `the next request no longer carries the stopped message, got ${JSON.stringify(requestUserTexts.at(-1))}`);
		console.log("  ok  while the runtime retries, the box shows Stop; Stop ends the retry and hands the message back");

		// Something typed in the box while it retries: the failed message stays where it was, and the model still sees it.
		await send("Always busy, while I type.");
		await page.getByText(`${MODEL_NAME} is busy. Trying again…`).waitFor({ timeout: 15000 });
		await composer.fill("A new question I typed.");
		await settled();
		await page.waitForTimeout(500);
		assert((await bubbles("Always busy, while I type.")) === 1 && (await composer.inputValue()) === "A new question I typed.", `the failed message stays and the box keeps what was typed, got ${await bubbles("Always busy, while I type.")} bubble(s), box ${JSON.stringify(await composer.inputValue())}`);
		assert((await errorTexts()).at(-1) === `${MODEL_NAME} is still busy after several tries. Your message is still above. Try again in a minute.`, `the line says the message is still above, got ${JSON.stringify((await errorTexts()).at(-1))}`);
		await ask("A new question I typed.");
		assert((requestUserTexts.at(-1) ?? []).some((text) => text.includes("Always busy, while I type.")), `the model still sees the message the room still shows, got ${JSON.stringify(requestUserTexts.at(-1))}`);
		console.log("  ok  something typed while it retries: the failed message stays above, and the model still sees it");

		// A reload while it retries: one retry note at most, and none once the turn ends.
		await send("Always busy, then a reload.");
		await page.getByText(`${MODEL_NAME} is busy. Trying again…`).waitFor({ timeout: 15000 });
		await open();
		let mostNotes = 0;
		while ((await status())?.activeThread?.inFlight) {
			mostNotes = Math.max(mostNotes, await retryNotes());
			await page.waitForTimeout(200);
		}
		await page.waitForTimeout(800);
		assert(mostNotes <= 1 && (await retryNotes()) === 0, `one retry note at most, none after, got ${mostNotes} then ${await retryNotes()}`);
		await isReturned("Always busy, then a reload.", "a failure after a reload");
		await composer.fill("");
		console.log("  ok  a reload while it retries shows one retry note at most, and none once the turn ends");

		// A message with a file that stays above when it fails: Try again has the model answer it again, its file's note included, and never sends it twice.
		await composer.fill("");
		await page.locator(".composer-attach-input").setInputFiles({ name: "notes.txt", mimeType: "text/plain", buffer: Buffer.from("Monday: export finished.\nTuesday: import checked.\n") });
		await page.locator(".composer-staged-card:not(.uploading)").waitFor({ timeout: 15000 });
		await send("An odd request about the notes, please.");
		await settled();
		await page.waitForTimeout(500);
		const fileLine = `${MODEL_NAME} could not answer this message. Your message is still above. Try again; if it repeats, choose another model.`;
		await waitUntil(async () => (await errorTexts()).at(-1) === fileLine, `a message with a file stays above, and its line says so, got ${JSON.stringify((await errorTexts()).at(-1))}`, 10000);
		assert((await bubbles("An odd request about the notes, please.")) === 1 && (await composer.inputValue()) === "", "the message with its file stays above, and the box is empty");
		const fileRequestsBefore = requestUserTexts.length;
		await page.locator(".failure-line:not(.is-folded)").getByRole("button", { name: "Try again" }).click();
		await waitUntil(() => requestUserTexts.slice(fileRequestsBefore).some((texts) => texts.at(-1)?.includes("An odd request about the notes, please.") ?? false), "Try again asks the model again", 15000);
		await settled();
		const askedAgain = requestUserTexts.slice(fileRequestsBefore).find((texts) => texts.at(-1)?.includes("An odd request about the notes, please.")) ?? [];
		assert(askedAgain.filter((text) => text.includes("An odd request about the notes, please.")).length === 1 && (askedAgain.at(-1) ?? "").includes("[FILE ATTACHED: notes.txt"), `Try again asks with the message once, its file's note included, got ${JSON.stringify(askedAgain)}`);
		assert((await bubbles("An odd request about the notes, please.")) === 1, `the message is not shown twice, got ${await bubbles("An odd request about the notes, please.")} bubble(s)`);
		await composer.fill("");
		console.log("  ok  a message with a file that stays above: Try again asks again with its file's note, and never sends it twice");

		// An answer cut off mid-way: the question and its partial answer stay above, with one line, and the box is left as it was.
		await send("Cut off midway, please.");
		await settled();
		// Its "Try again." is what the button beside it does.
		const cutLine = `${MODEL_NAME} stopped in the middle of its answer. Your message is still above.`;
		await waitUntil(async () => (await errorTexts()).at(-1) === cutLine, `the cut-off line says the message is still above, got ${JSON.stringify((await errorTexts()).at(-1))}`, 10000);
		assert((await page.locator(".failure-line:not(.is-folded) .failure-actions .rs-btn").allInnerTexts()).join("|") === "Try again", `the cut-off line offers Try again, got ${JSON.stringify(await page.locator(".failure-line:not(.is-folded) .failure-actions .rs-btn").allInnerTexts())}`);
		const cutLines = async () => (await errorTexts()).filter((text) => text.startsWith(`${MODEL_NAME} stopped in the middle of its answer.`)).length;
		const partials = () => page.getByText("A partial answer that stops").count();
		const keptAbove = async (label: string) => {
			const seen = { bubbles: await bubbles("Cut off midway, please."), partials: await partials(), lines: await cutLines(), box: await composer.inputValue() };
			assert(seen.bubbles === 1 && seen.partials === 1 && seen.lines === 1 && seen.box === "", `${label}: the message and its partial answer stay above with one line, and the box is left as it was, got ${JSON.stringify(seen)}`);
		};
		await keptAbove("an answer cut off mid-way");
		// Left and opened again, any number of times, the room shows the same.
		for (const visit of [1, 2]) {
			await open();
			await keptAbove(`the cut-off message, opened again (${visit})`);
		}
		console.log("  ok  an answer cut off mid-way: the question and its partial answer stay above with one line, the box is left as it was, and leaving and opening the room again keeps it so");

		// Try again: the model answers the same message again, which reaches it once, and the answer lands below the line; the box keeps its draft.
		await composer.fill("A draft written meanwhile.");
		answerNow.add("Cut off midway, please.");
		const cutRequestsBefore = requestUserTexts.length;
		const answersBeforeCut = await page.getByText("Answer from claude-haiku-5-5.").count();
		await page.locator(".failure-line:not(.is-folded)").getByRole("button", { name: "Try again" }).click();
		await waitUntil(async () => (await page.getByText("Answer from claude-haiku-5-5.").count()) > answersBeforeCut, "the answer after Try again lands");
		await settled();
		const cutAsked = requestUserTexts.slice(cutRequestsBefore);
		assert(cutAsked.length === 1 && cutAsked[0]!.filter((text) => text.includes("Cut off midway, please.")).length === 1, `Try again asks once, with the message once, got ${JSON.stringify(cutAsked)}`);
		assert(await answerBelowNewestLine(), "the new answer lands below the line");
		assert((await bubbles("Cut off midway, please.")) === 1 && (await composer.inputValue()) === "A draft written meanwhile.", `the message is not shown twice and the box keeps its draft, got ${await bubbles("Cut off midway, please.")} bubble(s), box ${JSON.stringify(await composer.inputValue())}`);
		await composer.fill("");
		console.log("  ok  Try again under a cut-off answer: the model gets the message once, its answer lands below the line, and the box keeps its draft");

		const savedItems = async () => {
			const threadId = String((await status())?.activeThread?.threadId ?? "");
			const thread = await (await authedFetch(`${baseUrl}/api/persistent-agents/${agentId}/threads/${encodeURIComponent(threadId)}`)).json();
			return (thread?.thread?.items ?? thread?.items ?? []) as any[];
		};
		// Cut off while nobody is in the room: the message and its partial answer stay above on every open, the partial landed once,
		// and its turn ends failed: Home never says a response is ready.
		const linesBeforeAway = (await errorTexts()).length;
		await send("Cut off midway, while I step out.");
		await page.goto(`${baseUrl}/`);
		await settled();
		const readyBadge = page.locator(".persistent-agent-card").filter({ hasText: "Failure Room" }).locator(".persistent-agent-badge.ready");
		await waitUntil(async () => (await readyBadge.count()) > 0, "Home's next look at the room", 8000).catch(() => {});
		assert((await readyBadge.count()) === 0, "Home says a response is ready for an answer cut off while nobody was in the room");
		const outcome = await status();
		assert(outcome?.activeThread?.activeTurn?.lastTerminalReason === "failed" && outcome?.unseenLandedAnswer?.terminalReason === "failed", `the turn of an answer cut off ends failed, got ${JSON.stringify({ last: outcome?.activeThread?.activeTurn?.lastTerminalReason, unseen: outcome?.unseenLandedAnswer?.terminalReason })}`);
		for (const visit of [1, 2]) {
			await open();
			await page.waitForTimeout(500);
			const seen = { bubbles: await bubbles("Cut off midway, while I step out."), box: await composer.inputValue(), partials: await partials(), lines: (await errorTexts()).length - linesBeforeAway };
			assert(seen.bubbles === 1 && seen.box === "" && seen.partials === 2 && seen.lines === 1, `cut off while nobody was in the room, open ${visit}: the message and its partial answer stay above with one line, and the box is left as it was, got ${JSON.stringify(seen)}`);
		}
		const landedAnswers = (await savedItems()).filter((item) => item?.kind === "assistant" && String(item?.text ?? "").includes("A partial answer that stops")).map((item) => String(item.text));
		assert(landedAnswers.at(-1) === "A partial answer that stops", `the landed partial is said once, not once per attempt, got ${JSON.stringify(landedAnswers.at(-1))}`);
		console.log("  ok  an answer cut off while nobody was in the room: on every open the message and its partial answer stay above, landed once, with one line");

		// Cut off while it streams a step's call, with nobody in the room: the message handed back lands no step and no question.
		const landedSteps = async () => (await savedItems()).filter((item) => item?.kind === "tool" && String(item?.id ?? "").startsWith("detached-step-"));
		const stepsBefore = (await landedSteps()).length;
		const linesBeforeStep = (await errorTexts()).length;
		await send("Cut off in a step, while I step out.");
		await page.goto(`${baseUrl}/`);
		await settled();
		await open();
		await isReturned("Cut off in a step, while I step out.", "cut off in a step while nobody was in the room");
		const stepsAfter = await landedSteps();
		assert(stepsAfter.length === stepsBefore, `a message handed back lands no step, got ${JSON.stringify(stepsAfter.slice(stepsBefore).map((item) => ({ name: item.name, status: item.status })))}`);
		assert(!(await savedItems()).some((item) => item?.kind === "user" && String(item?.text ?? "").includes("Cut off in a step, while I step out.")), "a message handed back lands no question in the transcript");
		assert((await errorTexts()).length === linesBeforeStep + 1 && /Your message is back in the box\./.test((await errorTexts()).at(-1) ?? ""), `cut off in a step: one line, and it says the message is back in the box, got ${JSON.stringify((await errorTexts()).slice(linesBeforeStep))}`);
		await composer.fill("");
		console.log("  ok  an attempt cut off in a step while nobody was in the room: no stopped step, no question, the message in the box, one line");

		// The same with a file, whose message stays above: its turn still lands its steps.
		await page.locator(".composer-attach-input").setInputFiles({ name: "notes.txt", mimeType: "text/plain", buffer: Buffer.from("Monday: export finished.\n") });
		await page.locator(".composer-staged-card:not(.uploading)").waitFor({ timeout: 15000 });
		await send("Cut off in a step about the notes, while I step out.");
		await page.goto(`${baseUrl}/`);
		await settled();
		await open();
		await page.waitForTimeout(800);
		assert((await bubbles("Cut off in a step about the notes, while I step out.")) === 1 && (await composer.inputValue()) === "", `a message with a file cut off in a step stays above, got ${await bubbles("Cut off in a step about the notes, while I step out.")} bubble(s), box ${JSON.stringify(await composer.inputValue())}`);
		const keptSteps = (await landedSteps()).slice(stepsAfter.length);
		assert(keptSteps.length > 0 && keptSteps.every((item) => item.status === "stopped"), `a turn not handed back still lands its steps, got ${JSON.stringify(keptSteps.map((item) => ({ name: item.name, status: item.status })))}`);
		console.log("  ok  the same with a message that stays above: its turn still lands its steps");

		// Stop in the middle of an answer says so.
		const partialsBeforeSlow = await partials();
		await send("A slow answer, please.");
		await waitUntil(async () => (await partials()) > partialsBeforeSlow, "the slow answer has begun", 15000);
		await page.locator(".stop-btn").click();
		await settled();
		await page.getByText("Response interrupted by Stop.").last().waitFor({ timeout: 5000 });
		assert((await bubbles("A slow answer, please.")) === 1, "a message answered in part stays where it was");
		console.log("  ok  Stop in the middle of an answer says the answer was interrupted");

		// A failure that ends while nobody is in the room: the message is back in the box on the way in, with its own cause.
		await send("Always busy, while I step out.");
		await page.getByText(`${MODEL_NAME} is busy. Trying again…`).waitFor({ timeout: 15000 });
		await page.goto(`${baseUrl}/`);
		await settled();
		await open();
		await isReturned("Always busy, while I step out.", "a failure that ended while nobody was in the room");
		assert((await errorTexts()).at(-1) === stillBusyReturned && (await retryNotes()) === 0, `the line says what happened, in place of the retry note saved on the way out, got ${JSON.stringify(await page.locator(".system-line").allInnerTexts())}`);
		await composer.fill("");
		console.log("  ok  a failure that ended while nobody was in the room: the message is back in the box on the way in, with its cause");

		// The line said on the way in is the live line: the same cause, its Details, its way on.
		const lastErrorLine = async () => {
			const line = page.locator(".system-line.error").last();
			return { text: (await line.locator(".system-line-text").innerText()).replace(/\s+/g, " ").trim(), details: await line.locator(".failure-details-toggle").count() };
		};
		for (const cause of ["Not on account", "No longer offered"]) {
			await send(`${cause}, live.`);
			await isReturned(`${cause}, live.`, `${cause}, live`);
			await settled();
			const live = await lastErrorLine();
			await composer.fill("");
			await open();
			await send(`${cause}, while I step out.`);
			await page.goto(`${baseUrl}/`);
			await settled();
			await open();
			await isReturned(`${cause}, while I step out.`, `${cause}, while nobody was in the room`);
			const away = await lastErrorLine();
			assert(away.text === live.text, `${cause}: the line on the way in is the live line, got ${JSON.stringify(away.text)} for ${JSON.stringify(live.text)}`);
			assert(live.details === 1 && away.details === 1, `${cause}: both lines keep the provider's Details, got live ${live.details} and away ${away.details}`);
			await composer.fill("");
			await open();
		}
		console.log("  ok  a failure that ended while nobody was in the room says the live line, with its Details");

		// The connection is lost while it retries (the server killed, so no stop runs, as in a crash or a power cut): the note goes with the connection, and after the restart the message is back in the box.
		await send("Always busy, the connection is lost.");
		await page.getByText(`${MODEL_NAME} is busy. Trying again…`).waitFor({ timeout: 15000 });
		await killSmokeServer(server);
		await page.getByText("Response interrupted: the connection was lost.").waitFor({ timeout: 15000 });
		assert((await retryNotes()) === 0, "the retry note goes with the connection");
		await startServer();
		await isReturned("Always busy, the connection is lost.", "a message left unanswered when the connection was lost");
		assert((await retryNotes()) === 0, "no retry note after the restart");
		await composer.fill("");
		await ask("A fine question after the restart.");
		assert(!(requestUserTexts.at(-1) ?? []).some((text) => text.includes("the connection is lost")), `the next request no longer carries it, got ${JSON.stringify(requestUserTexts.at(-1))}`);
		console.log("  ok  the connection is lost while it retries: the note goes, and after the restart the message is back in the box");

		// The app stops while it retries: the stop hands the message back before the server ends, so it is in the box before the restart, with no retry note.
		if (process.platform === "win32") {
			console.log("  skip  the app stops while it retries: on Windows a stop is a forced kill, which the lost connection above covers");
		} else {
			await send("Always busy, the app stops.");
			await page.getByText(`${MODEL_NAME} is busy. Trying again…`).waitFor({ timeout: 15000 });
			await stopSmokeServer(server);
			await isReturned("Always busy, the app stops.", "a message left unanswered when the app stopped, before the restart");
			assert((await retryNotes()) === 0, "no retry note once the app stopped");
			await startServer();
			// The message never left the box, so the page's reconnect is awaited by its Send button.
			await page.locator('button.send-btn[aria-label="Send"]').waitFor({ timeout: 15000 });
			// After the restart the reconnect shows the saved thread, bubble included,
			// until the server's ready hands the message back again, so the bubble's
			// absence is waited for.
			await inBox("Always busy, the app stops.", "a message left unanswered when the app stopped, after the restart");
			await waitUntil(async () => (await bubbles("Always busy, the app stops.")) === 0, "a message left unanswered when the app stopped, after the restart: its bubble is gone", 15000);
			assert((await retryNotes()) === 0, "no retry note after the restart");
			await composer.fill("");
			await ask("A fine question after the restart.");
			assert(!(requestUserTexts.at(-1) ?? []).some((text) => text.includes("the app stops")), `the next request no longer carries it, got ${JSON.stringify(requestUserTexts.at(-1))}`);
			console.log("  ok  the app stops while it retries: the message is back in the box before the restart, and after it, its bubble gone once ready hands it back");
		}

		// Sent while an answer is still running (here, the refusal the server sends then): back in the box with a plain line.
		await send("Refused while running.", false);
		await isReturned("Refused while running.", "a message sent while an answer runs");
		await page.getByText(TURN_RUNNING_LINE).last().waitFor({ timeout: 5000 });
		assert((await page.getByText(/activeThread|still running/).count()) === 0, "no internal words on the page");
		assert((await page.locator('button.send-btn[aria-label="Send"]').count()) === 1, "Send is back");
		console.log("  ok  a message sent while an answer runs goes back in the box with a plain line");
		await composer.fill("");
		// The same with a file: its chip comes back with the text, and Send carries the file's note once.
		await page.locator(".composer-attach-input").setInputFiles({ name: "while-running.txt", mimeType: "text/plain", buffer: Buffer.from("Wednesday: backup checked.\n") });
		await page.locator(".composer-staged-card:not(.uploading)").waitFor({ timeout: 15000 });
		await send("Refused while running, with a file.", false);
		await isReturned("Refused while running, with a file.", "a message with a file sent while an answer runs");
		await page.locator(".composer-staged-card:not(.uploading)", { hasText: "while-running.txt" }).waitFor({ timeout: 5000 });
		const withFileBefore = requestUserTexts.length;
		const answersBeforeFile = await page.getByText("Answer from claude-haiku-5-5.").count();
		await composer.press("Enter");
		await waitUntil(() => requestUserTexts.slice(withFileBefore).some((texts) => texts.at(-1)?.includes("Refused while running, with a file.") ?? false), "the message is sent again with its file", 15000);
		await settled();
		await waitUntil(async () => (await page.getByText("Answer from claude-haiku-5-5.").count()) > answersBeforeFile, "the message sent again with its file is answered");
		await page.locator('button.send-btn[aria-label="Send"]').waitFor({ timeout: 10000 });
		const sentWithFile = requestUserTexts.slice(withFileBefore).find((texts) => texts.at(-1)?.includes("Refused while running, with a file.")) ?? [];
		const fileNotes = (sentWithFile.at(-1) ?? "").split("[FILE ATTACHED: while-running.txt").length - 1;
		assert(fileNotes === 1 && sentWithFile.filter((text) => text.includes("Refused while running, with a file.")).length === 1, `Send carries the message once with its file's note once, got ${JSON.stringify(sentWithFile)}`);
		assert((await page.locator(".composer-staged-card").count()) === 0 && (await bubbles("Refused while running, with a file.")) === 1, "the chip went with the message, shown once");
		await composer.fill("");
		console.log("  ok  a message with a file sent while an answer runs goes back in the box with its file's chip, and Send carries the file's note once");
		// A file dropped and sent before the room's Files list caught up: the list the page holds lacks it, and its chip still comes back.
		const staleName = "dropped-and-sent.txt";
		let staleLists = 1;
		await page.route(/\/api\/persistent-agents\/[^/]+\/files(\?|$)/, async (route) => {
			if (route.request().method() !== "GET" || staleLists === 0) return route.fallback();
			staleLists -= 1;
			const response = await route.fetch();
			const body = await response.json();
			await route.fulfill({ response, json: { ...body, files: (body.files ?? []).filter((file: { name: string }) => file.name !== staleName) } });
		});
		await page.locator(".composer-attach-input").setInputFiles({ name: staleName, mimeType: "text/plain", buffer: Buffer.from("Thursday: restore checked.\n") });
		await page.locator(".composer-staged-card:not(.uploading)").waitFor({ timeout: 15000 });
		await waitUntil(() => staleLists === 0, "the Files list read after the upload is the stale one");
		await send("Refused while running, dropped and sent.", false);
		await isReturned("Refused while running, dropped and sent.", "a message with a file sent before the Files list caught up");
		await page.locator(".composer-staged-card:not(.uploading)", { hasText: staleName }).waitFor({ timeout: 5000 });
		await page.unroute(/\/api\/persistent-agents\/[^/]+\/files(\?|$)/);
		const staleBefore = requestUserTexts.length;
		await composer.press("Enter");
		await waitUntil(() => requestUserTexts.slice(staleBefore).some((texts) => texts.at(-1)?.includes("Refused while running, dropped and sent.") ?? false), "the message is sent again with its file", 15000);
		await settled();
		await page.locator('button.send-btn[aria-label="Send"]').waitFor({ timeout: 10000 });
		const sentStale = requestUserTexts.slice(staleBefore).find((texts) => texts.at(-1)?.includes("Refused while running, dropped and sent.")) ?? [];
		assert((sentStale.at(-1) ?? "").split(`[FILE ATTACHED: ${staleName}`).length - 1 === 1, `Send carries the file's note once, got ${JSON.stringify(sentStale)}`);
		await composer.fill("");
		console.log("  ok  a file sent before the Files list caught up still comes back as a chip");
		// The moment between attempts and the still-finishing line, each checked to the end so every miss is named.
		const turnFailures: string[] = [];
		const expect = (condition: unknown, message: string) => { if (!condition) turnFailures.push(message); };

		// Between a failed attempt and its retry, Send never comes back: the turn goes on.
		gap.armed = true;
		const answersBeforeGap = await page.getByText("Answer from claude-haiku-5-5.").count();
		await send("A server error once, the gap.");
		await waitUntil(() => gap.holding, "the failed attempt's end reached the page", 15000);
		await page.waitForTimeout(500);
		const inGap = { stop: await page.locator(".stop-btn").count(), send: await page.locator('button.send-btn[aria-label="Send"]').count() };
		expect(inGap.stop === 1 && inGap.send === 0, `between a failed attempt and its retry the box shows Stop, not Send, got ${JSON.stringify(inGap)}`);
		expect(gap.end?.retrying === true, `the end of an attempt the runtime asks again says a retry follows, got ${JSON.stringify(gap.end)}`);
		await waitUntil(async () => (await page.getByText("Answer from claude-haiku-5-5.").count()) > answersBeforeGap, "the retried message is answered");
		await settled();
		await page.locator('button.send-btn[aria-label="Send"]').waitFor({ timeout: 10000 });

		// The still-finishing line passes: with no answer running it goes at once; once the turn it waited for is over it goes, live and after a reload; it is never saved.
		await page.waitForTimeout(1500);
		expect((await page.getByText(TURN_RUNNING_LINE).count()) === 0, "with no answer running, the still-finishing line goes");
		const answersBeforeNote = await page.getByText("Answer from claude-haiku-5-5.").count();
		await send("A server error once, the passing note.");
		await page.getByText(`${MODEL_NAME} hit an error at its provider. Trying again…`).waitFor({ timeout: 15000 });
		pageSocket?.send(JSON.stringify({ type: "error", code: "turn_running", message: "persistent-agent activeThread is still running" }));
		await page.getByText(TURN_RUNNING_LINE).last().waitFor({ timeout: 5000 });
		await waitUntil(async () => (await page.getByText("Answer from claude-haiku-5-5.").count()) > answersBeforeNote, "the running answer lands");
		await settled();
		await composer.fill("");
		await page.waitForTimeout(1500);
		expect((await page.getByText(TURN_RUNNING_LINE).count()) === 0, "the still-finishing line goes once the turn is over");
		const savedNotes = async () => {
			const threadId = String((await status())?.activeThread?.threadId ?? "");
			const thread = await (await authedFetch(`${baseUrl}/api/persistent-agents/${agentId}/threads/${encodeURIComponent(threadId)}`)).json();
			const items: any[] = thread?.thread?.items ?? thread?.items ?? [];
			return items.filter((item) => item?.text === TURN_RUNNING_LINE).length;
		};
		expect((await savedNotes()) === 0, `the still-finishing line is never saved, got ${await savedNotes()}`);
		await open();
		expect((await page.getByText(TURN_RUNNING_LINE).count()) === 0, "after a reload the still-finishing line is not there");
		assert(turnFailures.length === 0, `between attempts and the still-finishing line:\n  ${turnFailures.join("\n  ")}`);
		console.log("  ok  between a failed attempt and its retry, Stop stays and Send never comes back");
		console.log("  ok  the still-finishing line goes once the turn is over, is not there after a reload, and is never saved");

		// Two tabs: a room is open in one window at a time, so a message handed back in the first is still offered in the second until it is cleared from a box.
		await send("An odd request, two tabs.");
		await isReturned("An odd request, two tabs.", "the first tab");
		await settled();
		const second = await ctx.newPage();
		const enterOn = async (tab: typeof page) => {
			await tab.goto(`${baseUrl}/auth/session?token=${SMOKE_AUTH_TOKEN}`);
			await tab.waitForLoadState("networkidle");
			if (await tab.locator(".whats-new-close").count()) await tab.locator(".whats-new-close").click();
			return tab.locator(".persistent-agent-card").filter({ hasText: "Failure Room" }).getByRole("button", { name: /^(Enter|Resume) →$/ });
		};
		assert(await (await enterOn(second)).isDisabled(), "the second tab cannot enter while the first has the room");
		await page.goto(`${baseUrl}/`);
		await page.waitForLoadState("networkidle");
		await second.reload();
		await second.waitForLoadState("networkidle");
		await (await enterOn(second)).click();
		const secondComposer = second.locator("textarea").first();
		await waitUntil(async () => (await secondComposer.inputValue()) === "An odd request, two tabs.", `the second tab gets the message back, got ${JSON.stringify(await secondComposer.inputValue())}`, 15000);
		assert((await second.locator(".bubble-row.user", { hasText: "An odd request, two tabs." }).count()) === 0, "its bubble is gone in the second tab too");
		await secondComposer.fill("");
		await second.waitForTimeout(500);
		await second.close();
		await open();
		assert((await composer.inputValue()) === "", `cleared in the second tab, it is not handed back again in the first, got ${JSON.stringify(await composer.inputValue())}`);
		console.log("  ok  two tabs: the room is open in one at a time, and a message handed back is offered in the next one until it is cleared");

		// No key at all: refused before it reached the conversation, the message goes back in the box.
		const savedAuth = fs.readFileSync(path.join(agentDir, "auth.json"), "utf8");
		fs.writeFileSync(path.join(agentDir, "auth.json"), "{}", { mode: 0o600 });
		await send("With no key at all.", false);
		await page.getByText(/No Claude API key is saved/).first().waitFor({ timeout: 15000 });
		await settled();
		await isReturned("With no key at all.", "a message refused for a missing key");
		console.log("  ok  no key at all: the key notice says it, and the message is back in the box");
		fs.writeFileSync(path.join(agentDir, "auth.json"), savedAuth, { mode: 0o600 });
		await composer.fill("");
		await open();
		// The room has no folder, so the hint to connect one shows until a notice that stops the room takes its place.
		const workspaceHint = page.locator(".room-workspace-nudge:not(.room-model-notice)");
		await workspaceHint.waitFor({ timeout: 10000 });
		// A refused key: the key notice says it, and no red line beside it.
		const linesBeforeKey = (await errorTexts()).length;
		await send("Key refused, please.");
		await isReturned("Key refused, please.", "a message whose key was refused");
		await settled();
		await page.waitForTimeout(500);
		assert((await errorTexts()).length === linesBeforeKey, `no red line beside the key notice, got ${JSON.stringify((await errorTexts()).slice(linesBeforeKey))}`);
		const keyNotice = page.locator(".room-model-notice .room-workspace-nudge-text");
		await waitUntil(async () => (await keyNotice.count()) > 0 && (await keyNotice.first().innerText()).includes("Your message is back in the box."), `the key notice says the message is back in the box, got ${JSON.stringify(await keyNotice.allInnerTexts())}`, 10000);
		assert((await page.locator(".room-model-notice .failure-mark[aria-hidden='true']").count()) === 1, "the key notice carries the failure lines' mark");
		assert((await keyNotice.first().evaluate((sentence) => getComputedStyle(sentence).textWrapStyle)) === "pretty", "the key notice's sentence wraps with no word left alone on its last line");
		assert((await workspaceHint.count()) === 0, "while the key notice shows, the hint to connect a folder waits");
		console.log("  ok  a refused key: the key notice says it and that the message is back in the box, and no red line beside it");
		// The notice goes with the next message, and the hint is back.
		await ask("A fine question after the refused key.");
		await page.locator(".room-model-notice").waitFor({ state: "detached", timeout: 10000 });
		await workspaceHint.waitFor({ timeout: 10000 });
		console.log("  ok  while the key notice shows, the hint to connect a folder waits, and it is back once the notice goes");
		await composer.fill("");
		await open();
		// The same while nobody is in the room: on the way in the box has the message, and a sentence says so.
		await send("Key refused, while I step out.");
		await page.goto(`${baseUrl}/`);
		await settled();
		await open();
		await isReturned("Key refused, while I step out.", "a key refused while nobody was in the room");
		// On the way in, the key notice says why, with its button, and that the message is back: never a bare line.
		await waitUntil(async () => (await keyNotice.count()) > 0 && /did not accept the saved key/.test(await keyNotice.first().innerText()) && (await keyNotice.first().innerText()).includes("Your message is back in the box."), `the key notice says the cause and that the message is back in the box, got ${JSON.stringify(await page.locator(".room-model-notice, .system-line").allInnerTexts())}`, 10000);
		assert((await page.locator(".room-model-notice button", { hasText: "Replace key" }).count()) === 1, "the notice offers Replace key");
		assert((await page.locator(".system-line-text").allInnerTexts()).every((text) => text.trim() !== "Your message is back in the box."), `no bare line stands in for the notice, got ${JSON.stringify((await page.locator(".system-line-text").allInnerTexts()).slice(-3))}`);
		await composer.fill("");
		console.log("  ok  a key refused while nobody was in the room: the key notice says why, with Replace key, and that the message is back in the box");

		// A scheduled task fails in the room's conversation while nobody is in the room, with Bash off and then on.
		const background = await import("../src/persistent-room-background-execution.js");
		const policies = await import("../src/persistent-room-workspace-policy.js");
		const threads = await import("../src/persistent-agents.js");
		const workspaceRoot = path.join(tempRoot, "workspace");
		fs.mkdirSync(workspaceRoot, { recursive: true });
		const scheduledFailures: string[] = [];
		// The third run stands for one that failed before this update: its session file has no mark.
		for (const [bash, beforeUpdate] of [[false, false], [true, false], [false, true]] as const) {
			await composer.fill("");
			await page.waitForTimeout(300);
			await page.goto(`${baseUrl}/auth/session?token=${SMOKE_AUTH_TOKEN}`);
			await page.waitForLoadState("networkidle");
			await waitUntil(async () => (await status())?.activeThread?.inFlight === false, "the room is idle before the scheduled run");
			if (bash) {
				policies.writePersistentRoomDefaultCapabilityPolicy(policies.createPersistentRoomDefaultCapabilityPolicy({ agentId, root: workspaceRoot, repoRoot, persistentAgentsRoot: agentsRoot, exxetaStateRoot: path.join(tempHome, ".exxperts", "app"), workspaceAccessMode: "localFiles", bashEnabled: true, displayLabel: "Scheduled Smoke Workspace" }), { persistentAgentsRoot: agentsRoot });
			}
			const threadId = String((await status())?.activeThread?.threadId ?? "");
			const thread = threads.getPersistentAgentThread(agentId, threadId);
			assert(thread?.model, "the room's conversation has its model");
			const scheduledPrompt = `A scheduled odd request, bash ${bash ? "on" : "off"}${beforeUpdate ? ", before the update" : ""}.`;
			let failedRun = false;
			try {
				await background.executePersistentRoomBackgroundPrompt({ roomId: agentId, target: { kind: "resume-thread", roomId: agentId, threadId, model: { provider: thread.model.provider, model: thread.model.model } }, prompt: scheduledPrompt, executionId: `smoke_bash_${bash ? "on" : "off"}${beforeUpdate ? "_before" : ""}`, agentDir });
			} catch {
				failedRun = true;
			}
			assert(failedRun, `the scheduled run with Bash ${bash ? "on" : "off"} fails`);
			if (beforeUpdate) {
				const sessionFiles: string[] = [];
				const walk = (dir: string) => { for (const entry of fs.readdirSync(dir, { withFileTypes: true })) { const full = path.join(dir, entry.name); if (entry.isDirectory()) walk(full); else if (entry.name.endsWith(".jsonl")) sessionFiles.push(full); } };
				walk(agentsRoot);
				let stripped = 0;
				for (const file of sessionFiles) {
					// Only the run's own mark, the file's last entry: earlier marks have entries after them that point at them.
					const lines = fs.readFileSync(file, "utf8").split("\n");
					const last = lines.map((line) => line.trim()).lastIndexOf(lines.filter((line) => line.trim()).at(-1) ?? "");
					if (last >= 0 && lines[last]!.includes('"app-turn-failed"')) {
						lines.splice(last, 1);
						fs.writeFileSync(file, lines.join("\n"));
						stripped += 1;
					}
				}
				assert(stripped >= 1, "the run before the update has no mark in its session file");
			}
			const sentWithPrefix = requestUserTexts.some((texts) => texts.some((text) => text.includes(scheduledPrompt) && text.includes("Background scheduled execution does not have Bash")));
			assert(sentWithPrefix === bash, `the scheduled prompt carries the Bash prefix only with Bash on (Bash ${bash ? "on" : "off"}: ${sentWithPrefix})`);
			await open();
			await page.waitForTimeout(1500);
			const box = await composer.inputValue();
			const lines = await errorTexts();
			console.log(`  scheduled run, Bash ${bash ? "on" : "off"}${beforeUpdate ? ", before the update" : ""}: box ${JSON.stringify(box)}; bubble ${await bubbles(scheduledPrompt)}; last line ${JSON.stringify(lines.at(-1))}`);
			if (box !== "") scheduledFailures.push(`a failed scheduled run, Bash ${bash ? "on" : "off"}${beforeUpdate ? ", before the update" : ""}: nothing lands in the box, got ${JSON.stringify(box)}`);
			if (lines.at(-1)?.includes("back in the box")) scheduledFailures.push(`a failed scheduled run, Bash ${bash ? "on" : "off"}${beforeUpdate ? ", before the update" : ""}: no line says a message is back in the box, got ${JSON.stringify(lines.at(-1))}`);
			if ((await bubbles(scheduledPrompt)) !== 1) scheduledFailures.push(`a failed scheduled run, Bash ${bash ? "on" : "off"}${beforeUpdate ? ", before the update" : ""}: its prompt stays where it is`);
			await composer.fill("");
			if (bash) policies.deletePersistentRoomDefaultCapabilityPolicy(agentId, { persistentAgentsRoot: agentsRoot });
		}
		assert(scheduledFailures.length === 0, `scheduled runs:\n  ${scheduledFailures.join("\n  ")}`);
		console.log("  ok  a scheduled task that fails keeps its failure where it is, with Bash on and off, and one from before the update: nothing lands in the box");

		// A scheduled task whose answer is cut off keeps its partial as an ordinary answer, said once however often the runtime asked again.
		{
			await composer.fill("");
			await page.goto(`${baseUrl}/auth/session?token=${SMOKE_AUTH_TOKEN}`);
			await page.waitForLoadState("networkidle");
			await waitUntil(async () => (await status())?.activeThread?.inFlight === false, "the room is idle before the scheduled run");
			const threadId = String((await status())?.activeThread?.threadId ?? "");
			const thread = threads.getPersistentAgentThread(agentId, threadId);
			assert(thread?.model, "the room's conversation has its model");
			await background.executePersistentRoomBackgroundPrompt({ roomId: agentId, target: { kind: "resume-thread", roomId: agentId, threadId, model: { provider: thread.model.provider, model: thread.model.model } }, prompt: "Cut off midway, a scheduled task.", executionId: "smoke_cut", agentDir }).catch(() => undefined);
			const landed = (threads.getPersistentAgentThread(agentId, threadId)?.items ?? []).filter((item: any) => item?.kind === "assistant" && String(item?.id ?? "").startsWith("scheduled-assistant-smoke_cut")).map((item: any) => String(item.text));
			assert(landed.length === 1 && landed[0] === "A partial answer that stops", `a scheduled task's cut-off answer lands its partial once, as an answer, got ${JSON.stringify(landed)}`);
			await open();
		}
		console.log("  ok  a scheduled task whose answer is cut off keeps its partial once, as an ordinary answer");

		// A message handed back that the page shows no bubble for: it lands in the box with a line of its own, and no other line is changed.
		await composer.fill("");
		await page.waitForTimeout(300);
		const linesBefore = await errorTexts();
		const causesBefore = await causes();
		pageSocket?.send(JSON.stringify({ type: "prompt_returned", text: "A message this page never showed.", failure: "other" }));
		await waitUntil(async () => (await composer.inputValue()) === "A message this page never showed." || (await errorTexts()).length !== linesBefore.length, "the handed-back message is placed");
		await page.waitForTimeout(500);
		const linesAfter = await errorTexts();
		if ((await composer.inputValue()) === "A message this page never showed.") {
			assert(linesAfter.length === linesBefore.length + 1 && linesAfter.at(-1) === "The model could not answer this message. Your message is back in the box. Try again; if it repeats, choose another model.", `text in the box comes with its own line, got ${JSON.stringify(linesAfter.slice(-2))}`);
			// A line that was the newest folds to its cause; no line says anything else.
			const causesAfter = await causes();
			assert(JSON.stringify(causesAfter.slice(0, causesBefore.length)) === JSON.stringify(causesBefore), `no other line is changed, got ${JSON.stringify(causesAfter.slice(-3))} after ${JSON.stringify(causesBefore.slice(-2))}`);
		}
		await composer.fill("");
		await page.waitForTimeout(300);
		console.log("  ok  a message handed back with no bubble comes with its own line, and no other line changes");

		// A new message whose first attempt the runtime asks again (the retry's start sent here, then Stop): the last turn's line stays where it is.
		await send("An odd request, the last line.");
		await isReturned("An odd request, the last line.", "a failed message before a retried one");
		await settled();
		await composer.fill("");
		const linesBeforeRetry = await errorTexts();
		const partialsBeforeRetry = await page.getByText("A partial answer that stops").count();
		await send("Slow answer, then a retry.");
		await waitUntil(async () => (await page.getByText("A partial answer that stops").count()) > partialsBeforeRetry, "the slow answer has begun", 15000);
		pageSocket?.send(JSON.stringify({ type: "event", event: { type: "auto_retry_start", attempt: 1, maxAttempts: 3, delayMs: 1000, errorMessage: "Overloaded" } }));
		await page.getByText(/Trying again…/).waitFor({ timeout: 5000 });
		const linesInRetry = await errorTexts();
		assert(linesInRetry.length === linesBeforeRetry.length, `a retry of a new message leaves the last turn's line, got ${JSON.stringify(linesInRetry.slice(-2))} after ${JSON.stringify(linesBeforeRetry.slice(-2))}`);
		await page.locator(".stop-btn").click();
		await settled();
		console.log("  ok  a new message's first attempt asked again leaves the last turn's line where it is");

		// Try again under a message that stayed above, refused before it began (the app stopping, or the connection lost):
		// the next message is one of its own, so its refusal hands it back with its line, as any other's.
		for (const refusal of [{ type: "error", code: "server_stopping", message: "exxperts is stopping, so this cannot start now." }, "drop" as const]) {
			const label = refusal === "drop" ? "the connection lost" : "the app stopping";
			await composer.fill("");
			await send(`Cut off midway, then ${label}.`);
			await settled();
			await waitUntil(async () => (await errorTexts()).at(-1) === `${MODEL_NAME} stopped in the middle of its answer. Your message is still above.`, `${label}: the cut-off line says the message is still above, got ${JSON.stringify((await errorTexts()).at(-1))}`, 10000);
			const readiesBefore = continueAnswer.readies;
			continueAnswer.next = refusal;
			await page.locator(".failure-line:not(.is-folded)").getByRole("button", { name: "Try again" }).click();
			if (refusal === "drop") await waitUntil(() => continueAnswer.readies > readiesBefore, `${label}: the room is connected again`);
			else await page.getByText("exxperts is stopping, so this cannot start now.").last().waitFor({ timeout: 5000 });
			await page.locator('button.send-btn[aria-label="Send"]').waitFor({ timeout: 10000 });
			await page.waitForTimeout(500);
			const notesBefore = await page.getByText(TURN_RUNNING_LINE).count();
			await send(`Refused while running, after ${label}.`, false);
			await waitUntil(async () => (await page.getByText(TURN_RUNNING_LINE).count()) > notesBefore, `${label}: the next message refused while an answer runs says so, got ${await page.getByText(TURN_RUNNING_LINE).count()} line(s), ${await bubbles(`Refused while running, after ${label}.`)} bubble(s), box ${JSON.stringify(await composer.inputValue())}`, 8000);
			await isReturned(`Refused while running, after ${label}.`, `${label}: the next message refused while an answer runs`);
			await composer.fill("");
			await page.waitForTimeout(1500);
		}
		console.log("  ok  after a Try again refused before it began, by the app stopping or the connection lost, the next message refused is handed back with its line");

		// Try again where the conversation moved on, for a message that cannot go whole again (its file gone from the room's Files):
		// nothing is sent, its words go back in the box, focused, and its line says so.
		const goneAbove = `${MODEL_NAME} could not answer this message. Your message is still above. Try again; if it repeats, choose another model.`;
		// Sends a message with a file, which fails and stays above; the file then leaves the room's Files, the room opens again,
		// and Try again finds nothing to continue.
		const tryAgainWithFileGone = async (fileName: string, text: string, draft = "") => {
			await composer.fill("");
			await page.locator(".composer-attach-input").setInputFiles({ name: fileName, mimeType: "text/plain", buffer: Buffer.from("A file that leaves.\n") });
			await page.locator(".composer-staged-card:not(.uploading)").waitFor({ timeout: 15000 });
			const before = requestUserTexts.length;
			await composer.fill(text);
			await composer.press("Enter");
			await waitUntil(() => requestUserTexts.slice(before).some((texts) => texts.some((typed) => typed.includes(fileName))), `the message with ${fileName} reached the model`);
			await settled();
			await waitUntil(async () => (await errorTexts()).at(-1) === goneAbove, `the message with its file stays above, got ${JSON.stringify((await errorTexts()).at(-1))}`, 10000);
			const deleted = await authedFetch(`${baseUrl}/api/persistent-agents/${agentId}/files/${encodeURIComponent(fileName)}/delete`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
			assert(deleted.ok, `the file leaves the room's Files, got ${deleted.status}`);
			const committed = await authedFetch(`${baseUrl}/api/persistent-agents/${agentId}/files/${encodeURIComponent(fileName)}/delete/commit`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ token: (await deleted.json()).token }) });
			assert(committed.ok, `the delete is final, got ${committed.status}`);
			await open();
			await waitUntil(async () => (await errorTexts()).at(-1) === goneAbove, "the line is there after the reload", 10000);
			await composer.fill(draft);
			const sentBefore = requestUserTexts.length;
			continueAnswer.next = { type: "error", code: "nothing_to_continue", message: "There is nothing to continue." };
			await page.locator(".failure-line:not(.is-folded)").getByRole("button", { name: "Try again" }).click();
			return sentBefore;
		};
		const nothingSent = async (sentBefore: number) => {
			assert(await page.evaluate(() => document.activeElement?.tagName === "TEXTAREA"), "the box has the focus");
			await page.waitForTimeout(500);
			assert(requestUserTexts.length === sentBefore, `nothing is sent, got ${JSON.stringify(requestUserTexts.slice(sentBefore))}`);
			await composer.fill("");
		};
		const requestsBeforeGone = await tryAgainWithFileGone("gone.txt", "An odd request about the gone file, please.");
		await inBox("An odd request about the gone file, please.", "Try again for a message that cannot go whole");
		await waitUntil(async () => (await errorTexts()).at(-1) === `${MODEL_NAME} could not answer this message. Your message is back in the box. Try again; if it repeats, choose another model.`, `the line says the message is back in the box, got ${JSON.stringify((await errorTexts()).at(-1))}`, 5000);
		await nothingSent(requestsBeforeGone);
		console.log("  ok  Try again for a message that cannot go whole again: nothing is sent, its words are back in the box, focused, and its line says so");

		// The same with a draft in the box, and for a message that was only its file: the draft stays, nothing is sent, and the line says the message can't go as it was.
		const notSentAgain = `${MODEL_NAME} could not answer this message. Your message is still above. It can't be sent again as it was. Send what you need in a new message.`;
		for (const scene of [{ fileName: "draft.txt", text: "An odd request, with a draft after it.", draft: "A draft of my own." }, { fileName: "odd request only.txt", text: "", draft: "" }]) {
			const label = scene.draft ? "with a draft in the box" : "for a message that was only its file";
			const sentBefore = await tryAgainWithFileGone(scene.fileName, scene.text, scene.draft);
			await waitUntil(async () => (await errorTexts()).at(-1) === notSentAgain, `${label}: the line says the message can't be sent again as it was, got ${JSON.stringify((await errorTexts()).at(-1))}`, 5000);
			assert((await composer.inputValue()) === scene.draft, `${label}: the box keeps ${JSON.stringify(scene.draft)}, got ${JSON.stringify(await composer.inputValue())}`);
			await nothingSent(sentBefore);
		}
		console.log("  ok  Try again for a message that cannot go whole, with a draft in the box or no words of its own: nothing is sent, the box stays, and its line says so");

		await ctx.close();
	} finally {
		await browser.close();
	}

	// The server: a message sent while an answer runs is refused for that window only, and the running answer still ends well.
	const WebSocketImpl: any = (await import("ws")).default;
	const conversationId = String((await (await authedFetch(`${baseUrl}/api/persistent-agents/${agentId}/status`)).json())?.activeThread?.threadId ?? "");
	assert(conversationId, "the room has an active conversation");
	const frames: any[] = [];
	const socket = new WebSocketImpl(`ws://127.0.0.1:${port}/ws?persistentAgentId=${agentId}&conversationId=${conversationId}`, { headers: { ...SMOKE_AUTH_HEADERS } });
	socket.addEventListener("message", (event: { data: unknown }) => { try { frames.push(JSON.parse(String(event.data))); } catch {} });
	await new Promise<void>((resolve, reject) => { socket.addEventListener("open", () => resolve()); socket.addEventListener("error", () => reject(new Error("websocket failed to connect"))); });
	await waitUntil(() => frames.some((frame) => frame.type === "ready"), "ready frame");
	socket.send(JSON.stringify({ type: "prompt", text: "A server error once, on the socket." }));
	await waitUntil(() => frames.some((frame) => frame.type === "event" && frame.event?.type === "auto_retry_start"), "the retry starts");
	socket.send(JSON.stringify({ type: "prompt", text: "Second while running." }));
	await waitUntil(() => frames.some((frame) => frame.type === "error" && frame.code === "turn_running"), "the second message is refused as sent while an answer runs");
	await waitUntil(async () => frames.some((frame) => JSON.stringify(frame).includes("Answer from")) && (await (await authedFetch(`${baseUrl}/api/persistent-agents/${agentId}/status`)).json())?.activeThread?.inFlight === false, "the running answer lands");
	// A message that carries more than the person typed (a file note) stays where it was when it fails: only typed text can go back in the box.
	const inFlight = async () => (await (await authedFetch(`${baseUrl}/api/persistent-agents/${agentId}/status`)).json())?.activeThread?.inFlight === true;
	const framesBeforeFile = frames.length;
	socket.send(JSON.stringify({ type: "prompt", text: "[FILE ATTACHED: notes.txt (1 KB)]\nAn odd request with a file." }));
	await waitUntil(() => requestUserTexts.some((texts) => texts.some((text) => text.includes("An odd request with a file."))), "the message with a file note reached the model");
	await waitUntil(async () => !(await inFlight()), "the failed message with a file note settled");
	await new Promise((resolve) => setTimeout(resolve, 500));
	assert(!frames.slice(framesBeforeFile).some((frame) => frame.type === "prompt_returned"), `a message with a file note is not handed back, got ${JSON.stringify(frames.slice(framesBeforeFile).filter((frame) => frame.type === "prompt_returned"))}`);
	socket.send(JSON.stringify({ type: "prompt", text: "And a fine question about the file." }));
	await waitUntil(async () => requestUserTexts.some((texts) => texts.some((text) => text.includes("And a fine question about the file."))) && !(await inFlight()), "the next message is answered");
	const fileRequest = requestUserTexts.filter((texts) => texts.some((text) => text.includes("And a fine question about the file."))).at(-1) ?? [];
	assert(fileRequest.some((text) => text.includes("FILE ATTACHED: notes.txt")), `the model still sees the message with its file note, got ${JSON.stringify(fileRequest)}`);
	console.log("  ok  a failed message that carries a file note stays where it was, and the model still sees it");
	socket.close();
	assert(!requestUserTexts.some((texts) => texts.some((text) => text.includes("Second while running."))), "the refused message never reached the model");
	const turnState = JSON.stringify(await (await authedFetch(`${baseUrl}/api/persistent-agents/${agentId}/status`)).json());
	assert(turnState.includes('"lastTerminalReason":"completed"'), `the running answer still ends well, got ${turnState.match(/"activeTurn":\{[^}]*\}/)?.[0]}`);
	console.log("  ok  the server refuses a message sent while an answer runs for that window only, and the running answer still ends well");
	console.log("room-failed-message-returns smoke: ok");
} catch (error) {
	console.error(serverOutput.join("").slice(-6000));
	throw error;
} finally {
	try { (endpoint as any).closeAllConnections?.(); } catch {}
	try { endpoint.close(); } catch {}
	await stopSmokeServer(server);
	fs.rmSync(tempRoot, { recursive: true, force: true });
}
