// How a chat turn ends when the model brings no answer, in the browser. One
// synthetic Anthropic endpoint answers a room on a Claude API key, scripted by
// the newest user message:
//
// - a spent quota is not retried by the runtime: one call, then the usage-limit line;
// - an HTML page sent with status 200 (a company proxy's sign-in page) is an
//   empty answer: its own line, and no Wallet row;
// - a turn that ran a tool and then failed is not asked again on its own: its
//   line says the message is still above, and Try again has the model go on
//   from the tool's result, the message and the tool's call once each,
//   leaving the box as it is;
// - a daily quota spent after a tool, in words the runtime would ask again,
//   ends the turn failed, and the spent model is not asked for the answer;
// - a conversation too long for the model ends in one line: with nothing
//   earlier to summarize, no summary is asked for and the overflow line stays,
//   naming the model, then where the message is, then the way on; in a
//   room with nothing in memory yet it names the message, not memory;
//   with earlier turns, one summary is asked for and the room's notice replaces it.
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { authedFetch, SMOKE_AUTH_TOKEN, SMOKE_SERVER_AUTH_ENV, SMOKE_SERVER_SPAWN_TREE_OPTIONS, smokeHomeEnv, stopSmokeServer, freePort } from "./smoke-server-process.js";

function assert(condition: unknown, message: string): asserts condition {
	if (!condition) throw new Error(message);
}

{
	const p = typeof chromium?.executablePath === "function" ? chromium.executablePath() : "";
	if (!p || !fs.existsSync(p)) {
		console.log("room turn outcomes smoke skipped (Chromium not installed)");
		process.exit(0);
	}
}

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const webServerDir = path.resolve(scriptDir, "..");
const repoRoot = path.resolve(webServerDir, "..", "..");
const port = await freePort();
const baseUrl = `http://127.0.0.1:${port}`;

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "exxperts-turn-outcomes-"));
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

/** The newest user words, skipping a message that only carries tool results, and whether the request answers a tool. */
function lastUserWords(body: any): { words: string; afterTool: boolean } {
	const messages = Array.isArray(body?.messages) ? body.messages : [];
	const textOf = (message: any) => typeof message?.content === "string" ? message.content : Array.isArray(message?.content) ? message.content.map((part: any) => (part?.type === "text" ? String(part.text ?? "") : "")).join("") : "";
	const last = messages.at(-1);
	const afterTool = Array.isArray(last?.content) && last.content.some((part: any) => part?.type === "tool_result");
	const words = [...messages].reverse().find((message: any) => message?.role === "user" && textOf(message).trim());
	return { words: words ? textOf(words) : "", afterTool };
}

const calls: string[] = [];
// Each request's shape: whether it answers a tool, how often it carries each user text, and how many tool calls it holds.
const requests: { afterTool: boolean; userTexts: string[]; toolCalls: number }[] = [];
// While a scene says so, the summary call is refused for a rate limit.
let summaryBusy = false;
// Once a scene's daily quota is spent, every call is refused for it until the scene ends.
let dailyQuotaSpent = false;

function sse(res: http.ServerResponse, event: string, payload: unknown): void {
	res.write(`event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`);
}

const endpoint = http.createServer((req, res) => {
	let raw = "";
	req.on("data", (chunk) => { raw += chunk; });
	req.on("end", () => {
		const body = JSON.parse(raw || "{}");
		const { words, afterTool } = lastUserWords(body);
		calls.push(words);
		const messages: any[] = Array.isArray(body?.messages) ? body.messages : [];
		requests.push({
			afterTool,
			userTexts: messages.filter((message) => message?.role === "user").map((message) => (typeof message.content === "string" ? message.content : Array.isArray(message.content) ? message.content.map((part: any) => (part?.type === "text" ? String(part.text ?? "") : "")).join("") : "")).filter((text) => text.trim()),
			toolCalls: messages.flatMap((message) => (Array.isArray(message?.content) ? message.content : [])).filter((part: any) => part?.type === "tool_use").length,
		});
		// A summary request quotes the earlier messages; it is answered as a summary, never scripted by them. So is a turn prefix's summary.
		const asked = /<conversation>|^# Conversation\b/i.test(words) ? "" : words;
		const json = (status: number, payload: unknown) => { res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify(payload)); };
		if (summaryBusy && !asked) return json(429, { type: "error", error: { type: "rate_limit_error", message: "Number of request tokens has exceeded your per-minute rate limit." } });
		// Google's per-minute limit, once: no wait named, and the next try gets through.
		if (/per-minute quota/i.test(asked) && calls.filter((call) => /per-minute quota/i.test(call)).length === 1) return json(429, { error: { code: 429, message: "Resource has been exhausted (e.g. check quota).", status: "RESOURCE_EXHAUSTED" } });
		if (/spent quota/i.test(asked)) return json(429, { error: { message: "You exceeded your current quota, please check your plan and billing details.", type: "insufficient_quota", code: "insufficient_quota" } });
		if (/empty page/i.test(asked)) { res.writeHead(200, { "content-type": "text/html" }); res.end("<html><head><title>Sign in</title></head><body>Sign in to continue</body></html>"); return; }
		if (/too long/i.test(asked)) return json(400, { type: "error", error: { type: "invalid_request_error", message: "prompt is too long: 210000 tokens > 200000 maximum" } });
		// A daily quota spent after a tool: a 429 the runtime would ask again, in words that say the quota is spent.
		if ((/daily quota/i.test(asked) && afterTool) || dailyQuotaSpent) { dailyQuotaSpent = true; return json(429, { error: { code: 429, message: "Resource has been exhausted: you have used the daily free allocation for this model (check quota).", status: "RESOURCE_EXHAUSTED" } }); }
		if (/use a tool/i.test(asked) && afterTool) return json(400, { type: "error", error: { type: "invalid_request_error", message: "messages.3.content: text content blocks must be non-empty" } });
		res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
		sse(res, "message_start", { type: "message_start", message: { id: "msg_smoke", type: "message", role: "assistant", model: body.model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 100, output_tokens: 1 } } });
		if (/use a tool/i.test(asked)) {
			sse(res, "content_block_start", { type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "toolu_smoke", name: "no_such_tool", input: {} } });
			sse(res, "content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: "{}" } });
			sse(res, "content_block_stop", { type: "content_block_stop", index: 0 });
			sse(res, "message_delta", { type: "message_delta", delta: { stop_reason: "tool_use", stop_sequence: null }, usage: { output_tokens: 10 } });
		} else {
			sse(res, "content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } });
			sse(res, "content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "A short summary." } });
			sse(res, "content_block_stop", { type: "content_block_stop", index: 0 });
			sse(res, "message_delta", { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 20 } });
		}
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
	// Short waits between the runtime's own retries, and no SDK retries under them, so each runtime attempt is one request.
	fs.writeFileSync(path.join(agentDir, "settings.json"), JSON.stringify({ retry: { baseDelayMs: 1000, provider: { maxRetries: 0 } }, compaction: { keepRecentTokens: 5 } }, null, 2), { mode: 0o600 });
	const agents = await import("../src/persistent-agents.js");
	const agentId = agents.createPersistentAgentFromScaffoldInput({ displayName: "Outcome Room", userName: "Synthetic User", preferredUserAddress: "Synthetic User" }).agent.agentId;
	server = spawn("npx", ["tsx", "src/index.ts"], {
		shell: process.platform === "win32",
		...SMOKE_SERVER_SPAWN_TREE_OPTIONS,
		cwd: webServerDir,
		env: smokeHomeEnv(tempHome, { PORT: String(port), ...SMOKE_SERVER_AUTH_ENV, EXXETA_HOME: repoRoot, EXXPERTS_CODING_AGENT_DIR: agentDir, EXXETA_PERSISTENT_AGENTS_ROOT: agentsRoot }) as NodeJS.ProcessEnv,
	});
	server.stdout.on("data", (chunk) => serverOutput.push(String(chunk)));
	server.stderr.on("data", (chunk) => serverOutput.push(String(chunk)));
	await waitUntil(() => fetch(`${baseUrl}/healthz`).then((r) => r.ok).catch(() => false), "server ready");
	const approved = await authedFetch(`${baseUrl}/api/persistent-agent-ai-profiles/custom`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ providerId: KEY_PROVIDER, label: "Claude API key", roomModels: [ON_KEY.model], learnModel: ON_KEY.model }) });
	assert(approved.ok, `the key's models are approved, got ${approved.status} ${await approved.text()}`);
	const picked = await authedFetch(`${baseUrl}/api/persistent-agents/${agentId}/models`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ conversation: ON_KEY }) });
	assert(picked.ok, `the room picks the key's model, got ${picked.status} ${await picked.text()}`);

	const browser = await chromium.launch();
	try {
		const page = await (await browser.newContext({ viewport: { width: 1280, height: 900 } })).newPage();
		await page.goto(`${baseUrl}/auth/session?token=${SMOKE_AUTH_TOKEN}`);
		await page.waitForLoadState("networkidle");
		const dismiss = page.locator(".whats-new-close");
		if (await dismiss.count()) await dismiss.click();
		await page.locator(".persistent-agent-card").filter({ hasText: "Outcome Room" }).getByRole("button", { name: /Enter|Resume/ }).first().click();

		const errorLines = page.locator(".system-line.error .system-line-text");
		const errorTexts = async () => (await errorLines.allInnerTexts()).map((text) => text.replace(/\s+/g, " ").trim());
		const newest = page.locator(".failure-line:not(.is-folded)");
		const composer = page.locator("textarea").first();
		await page.locator('button[title="Send"]').first().waitFor({ timeout: 15000 });
		const settled = () => waitUntil(async () => (await (await authedFetch(`${baseUrl}/api/persistent-agents/${agentId}/status`)).json())?.activeThread?.inFlight === false, "the turn settled", 30000);
		// A new room opens its session after the page shows; a send that came too early stays in the box.
		// Sent means it reached the endpoint: a failed message comes back to the box afterwards.
		const send = async (text: string) => {
			const seen = calls.filter((words) => words.includes(text)).length;
			const reached = () => calls.filter((words) => words.includes(text)).length > seen;
			await composer.fill(text);
			await waitUntil(async () => {
				if (reached()) return true;
				if ((await composer.inputValue()) === text) await composer.press("Enter");
				await new Promise((resolve) => setTimeout(resolve, 500));
				return reached();
			}, `"${text}" was sent`, 15000);
		};
		const callsFor = (pattern: RegExp) => calls.filter((words) => pattern.test(words)).length;

		// Too long in a fresh conversation: nothing earlier to summarize, so no summary call, and the overflow line is the turn's one line.
		let before = (await errorTexts()).length;
		await send("Too long already, sorry.");
		await waitUntil(async () => (await errorTexts()).length > before, "the fresh overflow shows a line", 30000);
		await settled();
		await new Promise((resolve) => setTimeout(resolve, 1500));
		const freshLines = (await errorTexts()).slice(before);
		assert(freshLines.length === 1 && freshLines[0] === `${MODEL_NAME} can't read this conversation at once. Your message is back in the box. Continue on a model that can read more at once.`, `one overflow line for the fresh turn in a room with nothing in memory: the model and the conversation, where the message is, then the way on, got ${JSON.stringify(freshLines)}`);
		assert((await newest.locator(".failure-actions .rs-btn").allInnerTexts()).join("|") === "Choose another model", `with nothing in memory yet, the overflow line offers another model and no Review, got ${JSON.stringify(await newest.locator(".failure-actions .rs-btn").allInnerTexts())}`);
		assert((await composer.inputValue()) === "Too long already, sorry.", `the fresh overflow hands the message back, got ${JSON.stringify(await composer.inputValue())}`);
		assert(callsFor(/<conversation>/i) === 0, `no summary is asked for when nothing precedes the message, got ${callsFor(/<conversation>/i)}`);
		console.log("  ok  a fresh conversation too long for the model asks for no summary and ends in one line");

		// A spent quota: one call, no runtime retries.
		before = (await errorTexts()).length;
		await send("A spent quota, sorry.");
		await waitUntil(async () => (await errorTexts()).length > before, "the spent quota shows a line");
		await settled();
		await new Promise((resolve) => setTimeout(resolve, 2500));
		assert(callsFor(/spent quota/i) === 1, `a spent quota is asked once, got ${callsFor(/spent quota/i)} calls`);
		assert((await errorTexts()).at(-1) === `${MODEL_NAME} has reached its usage limit or run out of credit. Your message is back in the box. Check the balance at console.anthropic.com, or choose another model.`, `the usage-limit line stays, got ${JSON.stringify((await errorTexts()).at(-1))}`);
		assert((await page.getByText(/Trying again…|Retrying…/).count()) === 0, "no retry note is left");
		console.log("  ok  a spent quota is asked once, then the usage-limit line");

		// A per-minute limit that says "quota" and names no wait: the runtime asks again, and the answer comes.
		before = (await errorTexts()).length;
		await send("A per-minute quota, please.");
		// The assert below says what happened when the second call never comes.
		await waitUntil(() => callsFor(/per-minute quota/i) >= 2, "the per-minute quota is asked again", 30000).catch(() => {});
		await settled();
		await new Promise((resolve) => setTimeout(resolve, 1500));
		assert(callsFor(/per-minute quota/i) >= 2, `a per-minute quota is asked again, got ${callsFor(/per-minute quota/i)} calls and the line ${JSON.stringify((await errorTexts()).at(-1))}`);
		assert((await errorTexts()).length === before, `no failure line after the retry got through, got ${JSON.stringify((await errorTexts()).slice(before))}`);
		console.log("  ok  a per-minute limit that says quota is asked again, and answers");

		// An HTML page with status 200: an empty answer, its own line, and no Wallet row.
		const usageFile = path.join(tempHome, ".exxperts", "app", "usage.jsonl");
		const usageRows = () => (fs.existsSync(usageFile) ? fs.readFileSync(usageFile, "utf8").split("\n").filter(Boolean).length : 0);
		const rowsBefore = usageRows();
		before = (await errorTexts()).length;
		await send("An empty page, please.");
		await waitUntil(async () => (await errorTexts()).length > before, "the empty answer shows a line");
		await settled();
		assert((await errorTexts()).at(-1) === `${MODEL_NAME} sent back an empty answer. Your message is back in the box. Try again; if it repeats, choose another model.`, `an empty answer says so, got ${JSON.stringify((await errorTexts()).at(-1))}`);
		await waitUntil(async () => (await composer.inputValue()) === "An empty page, please.", `an empty answer hands the message back, got ${JSON.stringify(await composer.inputValue())}`, 15000);
		assert(usageRows() === rowsBefore, `an empty answer writes no Wallet row, got ${usageRows() - rowsBefore} new`);
		console.log("  ok  an HTML page sent as an answer reads as an empty answer, with no Wallet row");

		// A tool, then a failure: the room does not ask the failing model again on its own.
		before = (await errorTexts()).length;
		await send("Use a tool, then fail.");
		await waitUntil(async () => (await errorTexts()).length > before, "the failed tool turn shows a line");
		await settled();
		await new Promise((resolve) => setTimeout(resolve, 2500));
		assert(callsFor(/INTERNAL_TOOL_SUMMARY_REQUEST/) === 0, `no summary request after a failed tool turn, got ${callsFor(/INTERNAL_TOOL_SUMMARY_REQUEST/)}`);
		assert((await errorTexts()).length === before + 1, `one line for the failed tool turn, got ${JSON.stringify((await errorTexts()).slice(before))}`);
		// The message was not handed back: it stays above, and the line says so, as when something was typed meanwhile.
		assert((await errorTexts()).at(-1) === `${MODEL_NAME} could not answer this message. Your message is still above. Try again; if it repeats, choose another model.`, `the failed tool turn's line says the message is still above, got ${JSON.stringify((await errorTexts()).at(-1))}`);
		// Try again has the model go on from the tool's result: the message reaches it once, the tool is not asked for again, and the box is left as it is.
		await composer.fill("A draft written meanwhile.");
		const toolRequestsBefore = requests.length;
		await newest.getByRole("button", { name: "Try again" }).click();
		await waitUntil(() => requests.length > toolRequestsBefore, "Try again asks the model again");
		await settled();
		const askedAgain = requests.slice(toolRequestsBefore);
		const once = askedAgain.every((request) => request.afterTool && request.toolCalls === 1 && request.userTexts.filter((text) => text === "Use a tool, then fail.").length === 1);
		assert(once, `Try again goes on from the tool's result, with the message and the tool's call once each, got ${JSON.stringify(askedAgain)}`);
		assert((await page.locator(".bubble-row.user", { hasText: "Use a tool, then fail." }).count()) === 1, "the message is not shown twice");
		assert((await composer.inputValue()) === "A draft written meanwhile.", `Try again leaves the box as it is, got ${JSON.stringify(await composer.inputValue())}`);
		console.log("  ok  a turn that ran a tool and then failed is not asked again; its message is still above, and Try again goes on from the tool's result, never asking for it twice");

		// A tool, then a spent daily quota: the turn ends failed, and the spent model is not asked for the missing answer.
		before = (await errorTexts()).length;
		await send("Use a tool, then a daily quota.");
		await waitUntil(async () => (await errorTexts()).length > before, "the daily quota after a tool shows a line");
		await settled();
		await new Promise((resolve) => setTimeout(resolve, 2500));
		dailyQuotaSpent = false;
		assert(callsFor(/INTERNAL_TOOL_SUMMARY_REQUEST/) === 0, `the spent model is not asked for the missing answer, got ${callsFor(/INTERNAL_TOOL_SUMMARY_REQUEST/)} requests and the lines ${JSON.stringify((await errorTexts()).slice(before))}`);
		assert((await errorTexts()).length === before + 1 && (await errorTexts()).at(-1)!.startsWith(`${MODEL_NAME} has reached its usage limit`), `one usage-limit line for the turn, got ${JSON.stringify((await errorTexts()).slice(before))}`);
		console.log("  ok  a daily quota spent after a tool ends the turn failed, and the spent model is not asked again");

		// Too long after earlier turns, and the summary call refused for a rate limit: the line says the model is busy, not that the
		// conversation could not be shortened, cause first, then where the message is, with Details.
		before = (await errorTexts()).length;
		summaryBusy = true;
		const summariesBefore = callsFor(/<conversation>/i);
		await send("Again too long, and the summary is busy.");
		await waitUntil(async () => callsFor(/<conversation>/i) > summariesBefore && (await errorTexts()).length > before, "the summary call is refused and a line shows", 30000);
		await settled();
		await new Promise((resolve) => setTimeout(resolve, 1500));
		summaryBusy = false;
		const busyLines = (await errorTexts()).slice(before);
		assert(busyLines.length === 1 && /^Claude Haiku 5\.5 is still busy after several tries\. Your message is (?:back in the box|still above)\. Try again in a minute\.$/.test(busyLines[0] ?? ""), `a summary call refused for a rate limit says the model is busy, got ${JSON.stringify(busyLines)}`);
		assert((await newest.locator(".failure-cause").innerText()).trim() === `${MODEL_NAME} is still busy after several tries.` && (await newest.locator(".failure-details-toggle").count()) === 1, `the busy line is a usual failure row: its cause first, with Details, got ${JSON.stringify(await newest.innerText())}`);
		await composer.fill("");
		console.log("  ok  a summary call refused for a rate limit ends in the busy line, a usual failure row, never the line about shortening");

		// Too long after earlier turns: one summary is asked for, and the room's notice is the turn's one line.
		before = (await errorTexts()).length;
		const summariesBeforeTooLong = callsFor(/<conversation>/i);
		await send("This conversation is too long, sorry.");
		// A usual failure row: the cause, then where the message is, then the rest; the button takes the place of where its way on is.
		const shorten = `The room could not shorten this conversation enough for ${MODEL_NAME}. Your message is still above. Your memory is unchanged. Remember, then continue, or choose a model that reads more at once.`;
		await waitUntil(async () => (await errorTexts()).includes(shorten), `the overflow notice shows, got ${JSON.stringify((await errorTexts()).slice(before))}`, 30000);
		await settled();
		await new Promise((resolve) => setTimeout(resolve, 1500));
		const overflowLines = (await errorTexts()).slice(before);
		assert(overflowLines.length === 1 && overflowLines[0] === shorten, `one line for the turn, the room's own words, got ${JSON.stringify(overflowLines)}`);
		assert((await newest.locator(".failure-actions .rs-btn").allInnerTexts()).join("|") === "Choose another model", `the line offers another model, got ${JSON.stringify(await newest.locator(".failure-actions .rs-btn").allInnerTexts())}`);
		assert(callsFor(/<conversation>/i) - summariesBeforeTooLong === 1, `one summary is asked for, got ${callsFor(/<conversation>/i) - summariesBeforeTooLong}`);
		// The runtime asked it again once the conversation was shorter: it stays above, not back in the box.
		assert((await composer.inputValue()) === "" && callsFor(/^This conversation is too long/) === 2, `the message stays for the runtime's second try, got box ${JSON.stringify(await composer.inputValue())} and ${callsFor(/^This conversation is too long/)} tries`);
		console.log("  ok  a conversation too long for the model ends in one line, the room's own words");
	} finally {
		await browser.close();
	}
	console.log("room-turn-outcomes smoke: ok");
} catch (error) {
	console.error(serverOutput.join("").slice(-6000));
	console.error("calls:", JSON.stringify(calls.map((words) => words.slice(0, 80))));
	throw error;
} finally {
	try { (endpoint as any).closeAllConnections?.(); } catch {}
	try { endpoint.close(); } catch {}
	await stopSmokeServer(server);
	fs.rmSync(tempRoot, { recursive: true, force: true });
}
