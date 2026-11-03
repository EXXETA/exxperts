// The page's two guards for the server's graceful stop, in the browser against
// a real spawned server, its real stop (SIGTERM) and one synthetic Anthropic
// endpoint on a Claude API key:
//
// - an answer that ends whole while the server stops (its agent_end carries no
//   stoppedByServer) is never stamped "the connection was lost", even while
//   its reveal is still running at the close, and is never saved so;
// - a question in the work card stops taking clicks at the stop's notice: a
//   click after it never records "Allowed";
// - the notice counts before the connection's ready too, and only for that
//   connection: the next one, after the restart, takes clicks again;
// - the person's Stop with the room's own command question open ends the
//   answer, and its row says "you pressed Stop" with no buttons, after a
//   reload too; the next turn's question asks again;
// - a card Stop closes takes its preview pane away, and a reload does not
//   open it again;
// - a click that reaches the server after Stop answered the question leaves
//   its row saying Stop answered it, never "Allowed";
// - the next turn after a Stop, with no reload between, can be stopped while
//   its card waits, and its yes leads to its answer;
// - a turn whose stopped card says Stop ended it shows no second Stop line,
//   after a reload too, while a Stop during a streamed answer keeps its own.
//
// The cards of the server's stop are sent by the smoke on the page's end of
// the room's socket; the notice is the server's own, except in the row that
// sends it before ready. The command card is the room's own.
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import { fileURLToPath } from "node:url";
import { ROOM_STATE_HEADING } from "../src/room-state-message.js";
import { chromium } from "playwright";
import { authedFetch, SMOKE_AUTH_TOKEN, SMOKE_SERVER_AUTH_ENV, SMOKE_SERVER_SPAWN_TREE_OPTIONS, smokeHomeEnv, stopSmokeServer, freePort } from "./smoke-server-process.js";
import { waitEvery } from "./smoke-wait.js";

function assert(condition: unknown, message: string): asserts condition {
	if (!condition) throw new Error(message);
}

{
	const p = typeof chromium?.executablePath === "function" ? chromium.executablePath() : "";
	if (!p || !fs.existsSync(p)) {
		console.log("room stop notice smoke skipped (Chromium not installed)");
		process.exit(0);
	}
}
// On Windows a stop is a forced kill, so no notice is ever sent.
if (process.platform === "win32") {
	console.log("room stop notice smoke skipped (no graceful stop on Windows)");
	process.exit(0);
}

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const webServerDir = path.resolve(scriptDir, "..");
const repoRoot = path.resolve(webServerDir, "..", "..");
const port = await freePort();
const baseUrl = `http://127.0.0.1:${port}`;

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "exxperts-stop-notice-"));
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
const CONNECTION_LOST = "Response interrupted: the connection was lost.";
// A question the person allowed, and one Stop answered, as their rows in the work card read.
const APPROVED = /^Allowed · Run this command\?/;
const STOPPED_LINE = "you pressed Stop";
const STOPPING_PLACEHOLDER = "Stopping current response…";
const STOP_NOTE = "You stopped this answer.";
// A message carrying it gets a `bash` call for an answer; the call's result gets a short one.
const CARD_TOKEN = "LIST_THE_FILES_TOKEN";
const CARD_ANSWER = "The files are listed.";
// A long answer streamed over about a second: it ends inside the stop's wait, and its reveal (at most about 130
// characters a second) runs on for seconds past the close.
const PARTS = 24;
const part = (index: number) => `Part ${index + 1} of the long answer, read slowly. `;
const LAST_WORDS = `Part ${PARTS} of the long answer`;
// A message carrying it gets an answer streamed slowly enough to press Stop in the middle of it.
const SLOW_TOKEN = "A_SLOW_ANSWER_TOKEN";

function sse(res: http.ServerResponse, event: string, payload: unknown): void {
	res.write(`event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`);
}

let deltasSent = 0;
const endpoint = http.createServer((req, res) => {
	let raw = "";
	req.on("data", (chunk) => { raw += chunk; });
	req.on("end", () => {
		const body = JSON.parse(raw || "{}");
		res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
		sse(res, "message_start", { type: "message_start", message: { id: "msg_smoke", type: "message", role: "assistant", model: body.model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 100, output_tokens: 1 } } });
		// The room-state copy rides after the person's message; the newest other message decides the answer.
		const textOf = (content: unknown) => (typeof content === "string" ? content : Array.isArray(content) ? content.map((block: any) => (typeof block?.text === "string" ? block.text : "")).join("") : "");
		const last = [...(body.messages ?? [])].reverse().find((message: any) => !textOf(message?.content).startsWith(ROOM_STATE_HEADING));
		const blocks: any[] = typeof last?.content === "string" ? [{ type: "text", text: last.content }] : (last?.content ?? []);
		const end = (stopReason: string) => {
			sse(res, "content_block_stop", { type: "content_block_stop", index: 0 });
			sse(res, "message_delta", { type: "message_delta", delta: { stop_reason: stopReason, stop_sequence: null }, usage: { output_tokens: 20 } });
			sse(res, "message_stop", { type: "message_stop" });
			res.end();
		};
		if (blocks.some((block) => block?.type === "tool_result")) {
			sse(res, "content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } });
			sse(res, "content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: CARD_ANSWER } });
			end("end_turn");
			return;
		}
		if (blocks.some((block) => block?.type === "text" && String(block.text).includes(CARD_TOKEN))) {
			sse(res, "content_block_start", { type: "content_block_start", index: 0, content_block: { type: "tool_use", id: `toolu_ls_${Date.now()}`, name: "bash", input: {} } });
			sse(res, "content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: JSON.stringify({ command: "ls" }) } });
			end("tool_use");
			return;
		}
		sse(res, "content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } });
		const slow = blocks.some((block) => block?.type === "text" && String(block.text).includes(SLOW_TOKEN));
		let index = 0;
		const timer = setInterval(() => {
			if (index < PARTS) {
				sse(res, "content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: part(index) } });
				deltasSent += 1;
				index += 1;
				return;
			}
			clearInterval(timer);
			sse(res, "content_block_stop", { type: "content_block_stop", index: 0 });
			sse(res, "message_delta", { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 400 } });
			sse(res, "message_stop", { type: "message_stop" });
			res.end();
		}, slow ? 400 : 40);
		res.on("close", () => clearInterval(timer));
	});
});

const waitUntil = waitEvery(100);

let server: ChildProcessWithoutNullStreams | undefined;
const serverOutput: string[] = [];
const failures: string[] = [];
const expect = (condition: unknown, message: string) => { if (!condition) failures.push(message); };

try {
	await new Promise<void>((resolve) => endpoint.listen(0, "127.0.0.1", resolve));
	const endpointUrl = `http://127.0.0.1:${(endpoint.address() as AddressInfo).port}`;
	fs.writeFileSync(path.join(agentDir, "models.json"), JSON.stringify({ providers: { [KEY_PROVIDER]: { baseUrl: endpointUrl } } }, null, 2), { mode: 0o600 });
	fs.writeFileSync(path.join(agentDir, "auth.json"), JSON.stringify({ [KEY_PROVIDER]: { type: "api_key", key: "synthetic-anthropic-key" } }, null, 2), { mode: 0o600 });
	fs.writeFileSync(path.join(agentDir, "settings.json"), JSON.stringify({ retry: { baseDelayMs: 1000, provider: { maxRetries: 0 } } }, null, 2), { mode: 0o600 });
	const agents = await import("../src/persistent-agents.js");
	const agentId = agents.createPersistentAgentFromScaffoldInput({ displayName: "Stop Room", userName: "Synthetic User", preferredUserAddress: "Synthetic User" }).agent.agentId;
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
	const approved = await authedFetch(`${baseUrl}/api/persistent-agent-ai-profiles/custom`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ providerId: KEY_PROVIDER, label: "Claude API key", roomModels: [ON_KEY.model], learnModel: ON_KEY.model }) });
	assert(approved.ok, `the key's model is approved, got ${approved.status}`);
	const picked = await authedFetch(`${baseUrl}/api/persistent-agents/${agentId}/models`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ conversation: ON_KEY }) });
	assert(picked.ok, `the room picks the key's model, got ${picked.status}`);
	// Full access with the terminal on, so the room asks before it runs a command.
	const workspaceRoot = path.join(tempRoot, "workspace");
	fs.mkdirSync(workspaceRoot, { recursive: true });
	fs.writeFileSync(path.join(workspaceRoot, "notes.txt"), "notes\n");
	const workspace = await authedFetch(`${baseUrl}/api/persistent-agents/${agentId}/workspace-default`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ root: workspaceRoot, displayLabel: "Stop Workspace", workspaceAccessMode: "localFiles", bashEnabled: true }) });
	assert(workspace.ok, `the room gets full access with the terminal on, got ${workspace.status}`);

	const browser = await chromium.launch();
	try {
		const page = await (await browser.newContext({ viewport: { width: 1280, height: 900 } })).newPage();
		// The page's end of the room's socket, passed through. A scene can send the page a frame of its own,
		// hold the close until it has looked, or put the notice ahead of the next connection's ready.
		let pageSocket: { send(message: string): void } | undefined;
		const socket = { noticeSeen: false, holdClose: false, release: undefined as undefined | (() => void), noticeBeforeReady: false, readies: 0, holdCardClosed: false, heldCardClosed: [] as string[] };
		await page.routeWebSocket(/\/ws\?/, (ws) => {
			pageSocket = ws;
			const upstream = ws.connectToServer();
			ws.onMessage((message) => upstream.send(message));
			upstream.onMessage((message) => {
				const text = String(message);
				if (socket.holdCardClosed && text.includes('"type":"ui_request_closed"')) {
					socket.heldCardClosed.push(text);
					return;
				}
				if (text.includes('"type":"server_stopping"')) socket.noticeSeen = true;
				if (text.includes('"type":"ready"')) socket.readies += 1;
				if (socket.noticeBeforeReady && text.includes('"type":"ready"')) {
					socket.noticeBeforeReady = false;
					ws.send(JSON.stringify({ type: "server_stopping" }));
				}
				ws.send(message);
			});
			upstream.onClose((code, reason) => {
				if (!socket.holdClose) { ws.close({ code, reason }); return; }
				socket.release = () => ws.close({ code, reason });
			});
			ws.onClose(() => upstream.close());
		});
		const open = async () => {
			await page.goto(`${baseUrl}/auth/session?token=${SMOKE_AUTH_TOKEN}`);
			await page.waitForLoadState("networkidle");
			const dismiss = page.locator(".whats-new-close");
			if (await dismiss.count()) await dismiss.click();
			const readies = socket.readies;
			await page.locator(".persistent-agent-card").filter({ hasText: "Stop Room" }).getByRole("button", { name: /^(Enter|Resume)$/ }).click();
			await page.locator('button[title="Send"]').first().waitFor({ timeout: 15000 });
			await waitUntil(() => socket.readies > readies, "the room's connection is ready");
		};
		await open();
		const composer = page.locator("textarea").first();
		const card = (id: string) => ({ type: "ui_request", kind: "confirm", id, title: "Run this command?", message: `echo ${id}` });
		const approvedLines = () => page.locator(".wk-row").filter({ hasText: APPROVED }).count();
		const cardAnswers = () => page.getByText(CARD_ANSWER).count();
		// Clicks the newest card's Yes when it still offers one; a card that stopped taking clicks has none.
		const clickYes = async () => {
			const yes = page.locator(".wk-ask .wk-btn.primary").last();
			if (await yes.count()) await yes.click({ timeout: 1000 }).catch(() => {});
		};
		const savedItems = async () => {
			const status = await (await authedFetch(`${baseUrl}/api/persistent-agents/${agentId}/status`)).json();
			const threadId = String(status?.activeThread?.threadId ?? "");
			const thread = await (await authedFetch(`${baseUrl}/api/persistent-agents/${agentId}/threads/${encodeURIComponent(threadId)}`)).json();
			return (thread?.thread?.items ?? thread?.items ?? []) as any[];
		};

		// An answer that ends whole while the server stops, with a card open: the server's notice comes first, the answer ends in the wait, then the close.
		await composer.fill("A long answer, please.");
		await composer.press("Enter");
		await waitUntil(() => deltasSent >= 2, "the answer has begun");
		pageSocket?.send(JSON.stringify(card("card-before-stop")));
		await page.locator(".wk-ask .wk-btn.primary").last().waitFor({ timeout: 5000 });
		socket.holdClose = true;
		const stopped = stopSmokeServer(server);
		await waitUntil(() => socket.noticeSeen, "the server's notice reached the page", 10_000);
		await page.waitForTimeout(300);
		await clickYes();
		await page.waitForTimeout(300);
		expect((await approvedLines()) === 0, "a click after the stop's notice recorded the approval");
		// The close, once the answer has ended: its reveal is still running.
		await waitUntil(() => socket.release !== undefined, "the server closed the connection", 10_000);
		socket.release?.();
		await stopped;
		await waitUntil(async () => (await page.getByText(LAST_WORDS).count()) > 0, "the whole answer is revealed", 30_000);
		// The reveal has ended once the last part shows whole; a lost-connection stamp would land right after it.
		await waitUntil(async () => (await page.getByText(part(PARTS - 1).trim()).count()) > 0, "the reveal has ended", 10_000);
		await page.waitForTimeout(700);
		expect((await page.getByText(CONNECTION_LOST).count()) === 0, "an answer that ended whole during the stop was stamped as a lost connection");
		socket.holdClose = false;
		socket.release = undefined;
		socket.noticeSeen = false;

		// The restart: the next connection gets the notice before its ready, as one still opening when a stop begins does.
		socket.noticeBeforeReady = true;
		await startServer();
		await page.locator('button[title="Send"]').first().waitFor({ timeout: 20000 });
		await waitUntil(() => !socket.noticeBeforeReady, "the notice went ahead of ready", 20_000);
		await waitUntil(async () => (await savedItems()).some((item) => item?.kind === "assistant" && String(item?.text ?? "").includes(LAST_WORDS)), "the page's save of the whole answer", 10_000).catch(() => {});
		const saved = await savedItems();
		expect(!JSON.stringify(saved).includes(CONNECTION_LOST), "the saved conversation calls an answer that ended during the stop a lost connection");
		expect(saved.some((item) => item?.kind === "assistant" && String(item?.text ?? "").includes(LAST_WORDS)), "the whole answer was not saved");
		pageSocket?.send(JSON.stringify(card("card-after-early-notice")));
		await page.waitForTimeout(500);
		await clickYes();
		await page.waitForTimeout(300);
		expect((await approvedLines()) === 0, "a card on a connection told of the stop before its ready took a click");

		// A new connection starts clean: its cards take clicks again.
		await open();
		const approvedBefore = await approvedLines();
		pageSocket?.send(JSON.stringify(card("card-on-a-new-connection")));
		await page.locator(".wk-ask .wk-btn.primary").last().waitFor({ timeout: 5000 });
		await clickYes();
		await waitUntil(async () => (await approvedLines()) === approvedBefore + 1, "a card on a new connection takes the click", 5000).catch(() => {});
		expect((await approvedLines()) === approvedBefore + 1, "a card on the next connection did not take its click");

		// A card Stop closes takes its preview away with it: the pane closes, and a reload does not open it again.
		const previewPane = page.locator("aside.preview-pane");
		pageSocket?.send(JSON.stringify({ type: "ui_request", kind: "confirm", id: "card-with-preview", title: "Create local HTML deck?", message: "Create deck.html", detail: "File: deck.html\nGenerated HTML preview:\n<!doctype html><html><body><h1>The deck</h1></body></html>" }));
		await previewPane.waitFor({ timeout: 5000 });
		pageSocket?.send(JSON.stringify({ type: "ui_request_closed", id: "card-with-preview", reason: "stopped" }));
		await waitUntil(async () => (await previewPane.count()) === 0, "the stopped card's preview closes", 5000).catch(() => {});
		expect((await previewPane.count()) === 0, "the preview of a card Stop closed stays open");

		// The person's Stop with the room's own command card open: the card says so, with no buttons, and the answer ends.
		const sendButton = page.locator('button[title="Send"]').first();
		const commandCard = page.locator(".wk-ask").filter({ hasText: "ls" }).last();
		const stoppedCards = page.locator(".wk-row").filter({ hasText: STOPPED_LINE }).filter({ hasNotText: "deck" });
		await composer.fill(`List the files, please. ${CARD_TOKEN}`);
		await composer.press("Enter");
		await commandCard.locator(".wk-btn.primary").waitFor({ timeout: 20000 });
		await page.locator("button.stop-btn").click();
		await waitUntil(async () => (await stoppedCards.count()) === 1, "the card says the person pressed Stop before answering", 10_000).catch(() => {});
		expect((await stoppedCards.count()) === 1, `Stop with a command card open: the card does not say "${STOPPED_LINE}", it shows ${JSON.stringify(await page.locator(".wk-row").last().innerText())}`);
		expect((await stoppedCards.locator(".wk-btn").count()) === 0, "the stopped card still offers buttons");
		await waitUntil(async () => (await sendButton.count()) > 0 && (await page.locator("button.stop-btn").count()) === 0, "the stopped answer ends", 10_000).catch(() => {});
		expect((await page.locator("button.stop-btn").count()) === 0, "the answer Stop ended with a card open did not end");
		const stopNotes = () => page.getByText(STOP_NOTE).count();
		expect((await stopNotes()) === 0, `under a card that says "${STOPPED_LINE}" the turn also says "${STOP_NOTE}"`);
		// What the page saved, read back after a reload.
		await waitUntil(async () => (await savedItems()).some((item) => item?.kind === "approval" && item?.title === "Run this command?" && item?.stopped === true), "the page's save of the stopped card", 10_000).catch(() => {});
		await open();
		expect((await stoppedCards.count()) === 1 && (await stoppedCards.locator(".wk-btn").count()) === 0, "after a reload the stopped card no longer says the person pressed Stop");
		await page.waitForTimeout(500);
		expect((await previewPane.count()) === 0, "after a reload the preview of a card Stop closed opens again");
		expect((await stopNotes()) === 0, `after a reload, under a card that says "${STOPPED_LINE}" the turn also says "${STOP_NOTE}"`);
		// The next turn asks again, and its yes runs the command.
		await composer.fill(`List them again, please. ${CARD_TOKEN}`);
		await composer.press("Enter");
		const askedAgain = await page.locator(".wk-ask .wk-btn.primary").last().waitFor({ timeout: 20000 }).then(() => true, () => false);
		expect(askedAgain, "the next turn's command card offers no buttons");
		if (askedAgain) {
			const answersBefore = await cardAnswers();
			await page.locator(".wk-ask .wk-btn.primary").last().click();
			await waitUntil(async () => (await cardAnswers()) === answersBefore + 1, "the next turn's answer", 20_000).catch(() => {});
			expect((await cardAnswers()) === answersBefore + 1, `the next turn's approved command did not lead to exactly one answer: ${answersBefore} before the yes, ${await cardAnswers()} after`);
		}
		expect((await stoppedCards.count()) === 1, "the stopped line is not on the stopped card alone");
		// A click after Stop that reaches the server after Stop answered the card: the command never runs, so the card says Stop answered it.
		// The answer above can still be revealing, and Enter sends nothing until its turn ends.
		await page.locator("button.stop-btn").waitFor({ state: "detached", timeout: 10000 });
		await composer.fill(`List them a third time, please. ${CARD_TOKEN}`);
		await composer.press("Enter");
		await page.locator(".wk-ask .wk-btn.primary").last().waitFor({ timeout: 20000 });
		const approvedBeforeLateClick = await approvedLines();
		socket.holdCardClosed = true;
		await page.locator("button.stop-btn").click();
		await waitUntil(() => socket.heldCardClosed.length > 0, "the server's word that Stop closed the card", 10_000);
		await page.locator(".wk-ask .wk-btn.primary").last().click();
		socket.holdCardClosed = false;
		for (const frame of socket.heldCardClosed.splice(0)) pageSocket?.send(frame);
		await waitUntil(async () => (await stoppedCards.count()) === 2, "the late-clicked card says Stop answered it", 5000).catch(() => {});
		expect((await stoppedCards.count()) === 2 && (await approvedLines()) === approvedBeforeLateClick, "a click that reached the server after Stop answered the card still says the command was approved");
		await waitUntil(async () => (await stopNotes()) === 0, "the late-clicked card's turn shows one Stop line", 3000).catch(() => {});
		expect((await stopNotes()) === 0, `a card that says "${STOPPED_LINE}" after its end frame came first still has "${STOP_NOTE}" under it`);
		// The next turn after a Stop, with no reload between: its card waits and Stop can stop it.
		await page.locator("button.stop-btn").waitFor({ state: "detached", timeout: 10000 });
		await composer.fill(`List them once more, please. ${CARD_TOKEN}`);
		await composer.press("Enter");
		await page.locator(".wk-ask .wk-btn.primary").last().waitFor({ timeout: 20000 });
		await waitUntil(async () => (await page.locator("button.stop-btn").isEnabled()) && (await composer.getAttribute("placeholder")) !== STOPPING_PLACEHOLDER, "the next turn's Stop can be pressed", 5000).catch(() => {});
		expect(await page.locator("button.stop-btn").isEnabled(), "after a Stop, the next turn's Stop stays disabled while its card waits");
		expect((await composer.getAttribute("placeholder")) !== STOPPING_PLACEHOLDER, "after a Stop, the next turn's box still says the answer is stopping");
		const answersBeforeLastYes = await cardAnswers();
		await page.locator(".wk-ask .wk-btn.primary").last().click();
		await waitUntil(async () => (await cardAnswers()) === answersBeforeLastYes + 1, "the last turn's answer", 20_000).catch(() => {});
		expect((await cardAnswers()) === answersBeforeLastYes + 1, `after a Stop with no reload, the next turn's approved command did not lead to exactly one answer: ${answersBeforeLastYes} before the yes, ${await cardAnswers()} after`);
		// A Stop while the answer streams, with no card: the turn says Stop ended it.
		await page.locator("button.stop-btn").waitFor({ state: "detached", timeout: 10000 });
		const deltasBeforeSlow = deltasSent;
		await composer.fill(`A slow answer, please. ${SLOW_TOKEN}`);
		await composer.press("Enter");
		await waitUntil(() => deltasSent >= deltasBeforeSlow + 2, "the slow answer streams", 20_000);
		await page.locator("button.stop-btn").click();
		await page.locator("button.stop-btn").waitFor({ state: "detached", timeout: 10000 });
		await waitUntil(async () => (await stopNotes()) === 1, "the streamed answer says Stop ended it", 5000).catch(() => {});
		expect((await stopNotes()) === 1, `Stop while the answer streams: "${STOP_NOTE}" shows ${await stopNotes()} times, not once`);

		assert(failures.length === 0, `the stop's guards:\n  ${failures.join("\n  ")}`);
		console.log("  ok  an answer that ends whole while the server stops is never stamped or saved as a lost connection, its reveal running on");
		console.log("  ok  a card stops taking clicks at the stop's notice, also when the notice comes before ready");
		console.log("  ok  the next connection starts clean: its cards take clicks");
		console.log("  ok  Stop with the room's command card open ends the answer; the card says so with no buttons, after a reload too, and the next turn asks again");
		console.log("  ok  a card Stop closes takes its preview pane away, also after a reload");
		console.log("  ok  a click that reaches the server after Stop answered the card leaves it saying Stop answered it");
		console.log("  ok  the next turn after a Stop can be stopped while its card waits, and its yes leads to its answer");
		console.log("  ok  a turn whose card says Stop ended it has no second Stop line, after a reload too; a Stop while text streams keeps its line");
	} finally {
		await browser.close();
	}
	console.log("room-stop-notice smoke: ok");
} catch (error) {
	console.error(serverOutput.join("").slice(-6000));
	throw error;
} finally {
	try { (endpoint as any).closeAllConnections?.(); } catch {}
	try { endpoint.close(); } catch {}
	await stopSmokeServer(server);
	fs.rmSync(tempRoot, { recursive: true, force: true });
}
