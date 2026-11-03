// The setup both parts of the room-failed-message-returns smoke share: one
// synthetic Anthropic endpoint on a Claude API key, the server, a room on the
// key's model, and a page in that room whose socket a scene can hold, answer
// or cut. Each part opens its own with openFailureRoom() and closes it at the end.
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { authedFetch, SMOKE_AUTH_TOKEN, SMOKE_SERVER_AUTH_ENV, SMOKE_SERVER_SPAWN_TREE_OPTIONS, smokeHomeEnv, stopSmokeServer, killSmokeServer, freePort } from "./smoke-server-process.js";
import { waitEvery } from "./smoke-wait.js";
import { closeBrowser } from "./smoke-close-context.js";

export function assert(condition: unknown, message: string): asserts condition {
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
export const ON_KEY = { provider: KEY_PROVIDER, model: "claude-haiku-5-5" };
export const SECOND = { provider: KEY_PROVIDER, model: "claude-sonnet-5-5" };
export const MODEL_NAME = "Claude Haiku 5.5";
export const TURN_RUNNING_LINE = "The last answer is still finishing; send your message in a moment.";
const CREDIT_WORDS = "Your credit balance is too low to access the Anthropic API. Please go to Plans & Billing to upgrade or purchase credits.";

// What the endpoint does with a message, by the words of the newest user message.
const attempts = new Map<string, number>();
// Messages a scene has since let the endpoint answer.
export const answerNow = new Set<string>();
function scripted(lastUserText: string): { status: number; body: unknown } | "drop" | "text" | "cut" | "tool-cut" | "slow" {
	const seen = (attempts.get(lastUserText) ?? 0) + 1;
	attempts.set(lastUserText, seen);
	if ([...answerNow].some((text) => lastUserText.includes(text))) return "text";
	if (/credit/i.test(lastUserText)) return { status: 400, body: { type: "error", error: { type: "invalid_request_error", message: CREDIT_WORDS }, request_id: "req_smoke_credit" } };
	if (/odd request/i.test(lastUserText)) return { status: 400, body: { type: "error", error: { type: "invalid_request_error", message: "messages.0.content: text content blocks must be non-empty" }, request_id: "req_smoke_odd" } };
	if (/always busy/i.test(lastUserText)) return { status: 529, body: { type: "error", error: { type: "overloaded_error", message: "Overloaded" }, request_id: "req_smoke_busy" } };
	if (/server error once/i.test(lastUserText) && seen === 1) return { status: 500, body: { type: "error", error: { type: "api_error", message: "Internal server error" }, request_id: "req_smoke_server" } };
	if (/dropped once/i.test(lastUserText) && seen === 1) return "drop";
	if (/not on account/i.test(lastUserText)) return { status: 404, body: { type: "error", error: { type: "not_found_error", message: "The model `claude-haiku-5-5` does not exist or you do not have access to it." }, request_id: "req_smoke_account" } };
	if (/no longer offered/i.test(lastUserText)) return { status: 404, body: { type: "error", error: { type: "not_found_error", message: "model: claude-haiku-5-5" }, request_id: "req_smoke_offered" } };
	if (/key refused/i.test(lastUserText)) return { status: 401, body: { type: "error", error: { type: "authentication_error", message: "invalid x-api-key" }, request_id: "req_smoke_key" } };
	if (/cut off midway/i.test(lastUserText)) return "cut";
	if (/cut off in a step/i.test(lastUserText)) return "tool-cut";
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
export const requestUserTexts: string[][] = [];
function allUserTexts(body: any): string[] {
	const messages = Array.isArray(body?.messages) ? body.messages : [];
	return messages.filter((message: any) => message?.role === "user").map((message: any) => (typeof message.content === "string" ? message.content : Array.isArray(message.content) ? message.content.map((part: any) => (typeof part?.text === "string" ? part.text : "")).join("") : ""));
}

function sse(res: http.ServerResponse, event: string, payload: unknown): void {
	res.write(`event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`);
}

// A message sent before stepping out is answered once the scene has left the
// room: the scene holds the endpoint's answers to it and lets them go when the
// server answers with nobody in the room.
let heldAnswers: Promise<void> | undefined;
let letGo = () => {};
const holdAnswers = () => { heldAnswers = new Promise<void>((resolve) => { letGo = () => { heldAnswers = undefined; resolve(); }; }); };

const endpoint = http.createServer((req, res) => {
	let raw = "";
	req.on("data", (chunk) => { raw += chunk; });
	req.on("end", async () => {
		const body = JSON.parse(raw || "{}");
		requestUserTexts.push(allUserTexts(body));
		const answer = scripted(lastUserText(body));
		if (heldAnswers && /while I step out/i.test(lastUserText(body))) {
			await heldAnswers;
			if (res.destroyed) return;
		}
		if (answer === "drop") { req.socket.destroy(); return; }
		// Cut off while it streams a step's call, so the attempt keeps a call that never ran.
		if (answer === "tool-cut") {
			res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
			sse(res, "message_start", { type: "message_start", message: { id: "msg_smoke_step", type: "message", role: "assistant", model: body.model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 100, output_tokens: 1 } } });
			sse(res, "content_block_start", { type: "content_block_start", index: 0, content_block: { type: "tool_use", id: `toolu_smoke_${requestUserTexts.length}`, name: "read", input: {} } });
			sse(res, "content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: "{\"path\": \"notes" } });
			setTimeout(() => req.socket.destroy(), 100);
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

export const waitUntil = waitEvery(150);

let server: ChildProcessWithoutNullStreams | undefined;
const serverOutput: string[] = [];
let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;

export async function openFailureRoom() {
	try {
		await new Promise<void>((resolve) => endpoint.listen(0, "127.0.0.1", resolve));
		const endpointUrl = `http://127.0.0.1:${(endpoint.address() as AddressInfo).port}`;
		fs.writeFileSync(path.join(agentDir, "models.json"), JSON.stringify({ providers: { [KEY_PROVIDER]: { baseUrl: endpointUrl } } }, null, 2), { mode: 0o600 });
		fs.writeFileSync(path.join(agentDir, "auth.json"), JSON.stringify({ [KEY_PROVIDER]: { type: "api_key", key: "synthetic-anthropic-key" } }, null, 2), { mode: 0o600 });
		// The runtime waits 2, 4 and 8 seconds between its own retries by default. A
		// room reads its waits when it is opened: most scenes only wait a retry out,
		// so the room is opened with short waits; a scene that acts while the runtime
		// waits to try again opens it with waits of 1, 2 and 4 seconds first. No SDK
		// retries under them, so each runtime attempt is one request.
		const retryWaits = (baseDelayMs: number) => fs.writeFileSync(path.join(agentDir, "settings.json"), JSON.stringify({ retry: { baseDelayMs, provider: { maxRetries: 0 } } }, null, 2), { mode: 0o600 });
		retryWaits(50);
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

		browser = await chromium.launch();
		const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
		const page = await ctx.newPage();
		// The room's socket, passed through; a message whose text says so is refused the way the server refuses one sent while an answer runs.
		// The page's end of the room's socket, so a scene can send it a frame of its own.
		let pageSocket: { send(message: string): void } | undefined;
		// A scene can hold the server's frames after the next end of an attempt, so the moment before its retry announces itself lasts until it has looked.
		const gap = { armed: false, holding: false, end: undefined as any, letGo: () => {} };
		// A scene can answer the next Try again that continues a turn itself, never reaching the server: with a frame, or by dropping the
		// connection; the server's ready frames are counted, so a scene knows when the connection is back.
		const continueAnswer = { next: undefined as object | "drop" | undefined, readies: 0 };
		// Each such message is refused once: sent again, it goes through.
		const refusedWhileRunning = new Set<string>();
		await page.routeWebSocket(/\/ws\?/, (ws) => {
			pageSocket = ws;
			const upstream = ws.connectToServer();
			ws.onMessage((message) => {
				// Keyed by the message's words: each send carries an id of its own.
				let words = String(message);
				try { words = String(JSON.parse(words)?.text ?? words); } catch {}
				if (words.includes("Refused while running") && !refusedWhileRunning.has(words)) {
					refusedWhileRunning.add(words);
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
					gap.letGo = () => { gap.holding = false; while (held.length) ws.send(held.shift()!); };
				}
			});
		});
		const open = async () => {
			await page.goto(`${baseUrl}/auth/session?token=${SMOKE_AUTH_TOKEN}`);
			await page.waitForLoadState("networkidle");
			const dismiss = page.locator(".whats-new-close");
			if (await dismiss.count()) await dismiss.click();
			await page.locator(".persistent-agent-card").filter({ hasText: "Failure Room" }).getByRole("button", { name: /^(Enter|Resume)$/ }).click();
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
		// Leaves the room for Home, and lets the held answer go once the server answers with nobody in the room.
		const stepOut = async () => {
			await page.goto(`${baseUrl}/`);
			await waitUntil(async () => ((await (await authedFetch(`${baseUrl}/api/persistent-agents`)).json()) as any[]).find((room) => room.id === agentId)?.answeringDetached === true, "the room answers with nobody in it");
			letGo();
		};
		// Sends, and waits until the message reached the model (a refused one never does).
		const send = async (text: string, reaches = true) => {
			const before = requestUserTexts.length;
			await composer.fill(text);
			// Enter sends only while Send is enabled, and Send waits for the room's connection: entering a room can
			// replace its first socket at once, and Send shows before the new one is up.
			await waitUntil(() => page.getByRole("button", { name: "Send", exact: true }).isEnabled(), "Send is enabled with the message typed");
			await composer.press("Enter");
			if (reaches) await waitUntil(() => requestUserTexts.slice(before).some((texts) => texts.some((typed) => typed.includes(text))), `"${text}" reached the model`);
		};
		// The newest line shows its button in place of where it is; the conversation keeps every word.
		const returnedSaved = `${MODEL_NAME} could not answer this message. Try again; if it repeats, choose another model in Room settings, Model.`;
		const stillBusyReturned = `${MODEL_NAME} is still busy after several tries. Try again in a minute.`;
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

		return {
			page, ctx, composer, agentId, agentDir, agentsRoot, tempRoot, tempHome, repoRoot, port, baseUrl,
			retryWaits, startServer, killServer: () => killSmokeServer(server), stopServer: () => stopSmokeServer(server),
			sendToPage: (frame: string) => pageSocket?.send(frame), gap, continueAnswer, holdAnswers, open, stepOut,
			errorTexts, causes, answerBelowNewestLine, bubbles, status, settled, send, ask, inBox, isReturned, retryNotes,
			returnedSaved, stillBusyReturned,
		};
	} catch (error) {
		await closeFailureRoom(error);
		throw error;
	}
}

/** Stops the browser, the endpoint and the server; with an error, prints the server's last output first. */
export async function closeFailureRoom(error?: unknown): Promise<void> {
	if (error) console.error(serverOutput.join("").slice(-6000));
	try { if (browser) await closeBrowser(browser); } catch {}
	browser = undefined;
	try { (endpoint as any).closeAllConnections?.(); } catch {}
	try { endpoint.close(); } catch {}
	await stopSmokeServer(server);
	fs.rmSync(tempRoot, { recursive: true, force: true });
}
