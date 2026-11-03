// The app's quit mid-answer, then the next message, in the browser against a
// real spawned server, its real stop (SIGTERM, as the Mac app stops it) and
// one synthetic Anthropic endpoint on a Claude API key. The runtime drops a
// stopped answer before it reaches the provider, so after the restart the
// first message must carry the note (cut-answer-note.ts, kind "server-stop")
// with exactly the words the conversation saved, or the model gets the two
// messages back to back and starts the cut answer again.
//
// Rows, in one run: the first message after the restart is refused by the
// model and goes back to the box, carrying the note; after a second quit and
// restart it is sent again from the box and carries the same note; a message
// sent the moment that answer ends carries none. The bubble and the saved
// conversation keep only the person's words throughout.
//
// Run: npm run smokes -- quit-answer-note   (or tsx this file)
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { ROOM_STATE_HEADING } from "../src/room-state-message.js";
import { STOP_CUT_ANSWER_SENTENCE } from "../src/turn-ended-by.js";
import { authedFetch, SMOKE_AUTH_TOKEN, SMOKE_SERVER_AUTH_ENV, SMOKE_SERVER_SPAWN_TREE_OPTIONS, smokeHomeEnv, stopSmokeServer, freePort } from "./smoke-server-process.js";
import { waitEvery } from "./smoke-wait.js";

function assert(condition: unknown, message: string): asserts condition {
	if (!condition) throw new Error(message);
}

{
	const p = typeof chromium?.executablePath === "function" ? chromium.executablePath() : "";
	if (!p || !fs.existsSync(p)) {
		console.log("quit answer note smoke skipped (Chromium not installed)");
		process.exit(0);
	}
}
// On Windows a stop is a forced kill, so no careful stop runs and no cut answer is landed.
if (process.platform === "win32") {
	console.log("quit answer note smoke skipped (no graceful stop on Windows)");
	process.exit(0);
}

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const webServerDir = path.resolve(scriptDir, "..");
const repoRoot = path.resolve(webServerDir, "..", "..");
const port = await freePort();
const baseUrl = `http://127.0.0.1:${port}`;

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "exxperts-quit-answer-note-"));
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
const STORY = "Write me a long story, please.";
const HELLO = "Say hello";
const THANKS = "Thanks, that is all.";
const HELLO_ANSWER = "Hello there.";
const THANKS_ANSWER = "You are welcome.";
// Far longer than the stop's wait: the stop cuts it.
const PARTS = 120;
const PART_MS = 150;
// Longer than the page's debounced save (500 ms), so a quiet spell this long means no save is still waiting.
const FILE_QUIET_MS = 1500;
const part = (index: number) => `Part ${index + 1} of the long story, cut by the quit. `;
const FIRST_WORDS = "Part 1 of the long story";
const NOTE_OPEN = "[ANSWER CUT OFF]";
// What the model must read in front of the message: the words pinned here, the saved answer between the fence lines.
const expectedNote = (saved: string) => [
	NOTE_OPEN,
	"Your previous answer was cut off because exxperts stopped while you were writing. This is exactly what had been written; it stays on the person's screen:",
	"---",
	saved,
	"---",
	"Answer their message below. Continue the earlier answer only if they ask you to, and then start again at the beginning of the sentence it stopped in.",
	"[/ANSWER CUT OFF]",
	"",
	"",
].join("\n");

function sse(res: http.ServerResponse, event: string, payload: unknown): void {
	res.write(`event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`);
}
const textOf = (content: unknown) => (typeof content === "string" ? content : Array.isArray(content) ? content.map((block: any) => (typeof block?.text === "string" ? block.text : "")).join("") : "");

// After the restart, what each model call got as the person's message, and how the endpoint answers it, in order.
const received: string[] = [];
let afterRestart = false;
const replies: Array<"refuse" | string> = ["refuse", HELLO_ANSWER, THANKS_ANSWER];
let deltasSent = 0;
const endpoint = http.createServer((req, res) => {
	let raw = "";
	req.on("data", (chunk) => { raw += chunk; });
	req.on("end", () => {
		const body = JSON.parse(raw || "{}");
		// The room-state copy rides after the person's message; the person's message is the last user message before it.
		const own = (body.messages ?? []).filter((message: any) => message?.role === "user" && !textOf(message?.content).startsWith(ROOM_STATE_HEADING));
		const message = textOf(own.at(-1)?.content);
		if (afterRestart) {
			received.push(message);
			const reply = replies[received.length - 1] ?? "Done.";
			if (reply === "refuse") {
				res.writeHead(400, { "content-type": "application/json" });
				res.end(JSON.stringify({ type: "error", error: { type: "invalid_request_error", message: "synthetic refusal of this one call" } }));
				return;
			}
			res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
			sse(res, "message_start", { type: "message_start", message: { id: "msg_smoke", type: "message", role: "assistant", model: body.model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 100, output_tokens: 1 } } });
			sse(res, "content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } });
			sse(res, "content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: reply } });
			sse(res, "content_block_stop", { type: "content_block_stop", index: 0 });
			sse(res, "message_delta", { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 5 } });
			sse(res, "message_stop", { type: "message_stop" });
			res.end();
			return;
		}
		res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
		sse(res, "message_start", { type: "message_start", message: { id: "msg_smoke", type: "message", role: "assistant", model: body.model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 100, output_tokens: 1 } } });
		sse(res, "content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } });
		const asked = message.includes(STORY);
		let index = 0;
		const timer = setInterval(() => {
			if (asked && index < PARTS) {
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
		}, PART_MS);
		res.on("close", () => clearInterval(timer));
	});
});

const waitUntil = waitEvery(100);

let server: ChildProcessWithoutNullStreams | undefined;
const serverOutput: string[] = [];
const failures: string[] = [];
const expect = (condition: unknown, message: string) => { if (!condition) failures.push(message); };
const itemLine = (item: any) => `${item?.kind}${item?.level ? `/${item.level}` : ""} ${item?.id ?? "-"}: …${String(item?.text ?? "").slice(-70).replace(/\s+/g, " ")}`;

try {
	await new Promise<void>((resolve) => endpoint.listen(0, "127.0.0.1", resolve));
	const endpointUrl = `http://127.0.0.1:${(endpoint.address() as AddressInfo).port}`;
	fs.writeFileSync(path.join(agentDir, "models.json"), JSON.stringify({ providers: { [KEY_PROVIDER]: { baseUrl: endpointUrl } } }, null, 2), { mode: 0o600 });
	fs.writeFileSync(path.join(agentDir, "auth.json"), JSON.stringify({ [KEY_PROVIDER]: { type: "api_key", key: "synthetic-anthropic-key" } }, null, 2), { mode: 0o600 });
	fs.writeFileSync(path.join(agentDir, "settings.json"), JSON.stringify({ retry: { baseDelayMs: 1000, provider: { maxRetries: 0 } } }, null, 2), { mode: 0o600 });
	const agents = await import("../src/persistent-agents.js");
	const { createPersistentAgentInstance } = await import("../src/persistent-agent-store.js");
	const agentId = agents.createPersistentAgentFromScaffoldInput({ displayName: "Quit Room", userName: "Synthetic User", preferredUserAddress: "Synthetic User" }).agent.agentId;
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

	const browser = await chromium.launch();
	try {
		const page = await (await browser.newContext({ viewport: { width: 1280, height: 900 } })).newPage();
		let readies = 0;
		// Set for the last row: a message sent on the room's connection the moment the answer's agent_end comes, before
		// any save of that exchange can land, as a second window or a quick client would.
		let sendOnAgentEnd: string | undefined;
		await page.routeWebSocket(/\/ws\?/, (ws) => {
			const upstream = ws.connectToServer();
			ws.onMessage((message) => upstream.send(message));
			upstream.onMessage((message) => {
				if (String(message).includes('"type":"ready"')) readies += 1;
				if (sendOnAgentEnd && String(message).includes('"type":"agent_end"')) {
					upstream.send(JSON.stringify({ type: "prompt", text: sendOnAgentEnd }));
					sendOnAgentEnd = undefined;
				}
				ws.send(message);
			});
			upstream.onClose((code, reason) => ws.close({ code, reason }));
			ws.onClose(() => upstream.close());
		});
		const open = async () => {
			await page.goto(`${baseUrl}/auth/session?token=${SMOKE_AUTH_TOKEN}`);
			await page.waitForLoadState("networkidle");
			const dismiss = page.locator(".whats-new-close");
			if (await dismiss.count()) await dismiss.click();
			const before = readies;
			await page.locator(".persistent-agent-card").filter({ hasText: "Quit Room" }).getByRole("button", { name: /^(Enter|Resume)$/ }).click();
			await page.locator('button[title="Send"]').first().waitFor({ timeout: 15000 });
			await waitUntil(() => readies > before, "the room's connection is ready");
		};
		await open();
		const composer = page.locator("textarea").first();
		await composer.fill(STORY);
		await composer.press("Enter");
		await page.getByText(FIRST_WORDS).first().waitFor({ timeout: 20000 });
		await waitUntil(() => deltasSent >= 6, "the story streams");
		const status = await (await authedFetch(`${baseUrl}/api/persistent-agents/${agentId}/status`)).json();
		const threadId = String(status?.activeThread?.threadId ?? "");
		assert(threadId, "the room has an open conversation");
		const threadFile = createPersistentAgentInstance(agentId).runtimeThreadPath(threadId);
		const threadItems = (): any[] => {
			try { return JSON.parse(fs.readFileSync(threadFile, "utf8"))?.items ?? []; } catch { return []; }
		};
		// The file unchanged for a quiet spell: no save of the page's or the server's is still on its way.
		const fileSettled = async (label: string) => {
			let seen = "";
			let since = Date.now();
			await waitUntil(() => {
				const now = fs.existsSync(threadFile) ? fs.readFileSync(threadFile, "utf8") : "";
				if (now !== seen) { seen = now; since = Date.now(); }
				return Date.now() - since >= FILE_QUIET_MS;
			}, label, 15_000);
		};

		// The quit, then the restart on the same home and a reload.
		await stopSmokeServer(server);
		afterRestart = true;
		await startServer();
		await open();
		await page.getByText(FIRST_WORDS).first().waitFor({ timeout: 15000 });
		await fileSettled("the reopened room's saves have settled");

		// The words the conversation saved for the cut answer, in either writer's form: the server's partial before its
		// own line, or the page's copy with the line at the end of its text.
		const saved = threadItems();
		const last = saved.at(-1);
		const pageForm = `\n\n_${STOP_CUT_ANSWER_SENTENCE}_`;
		const savedWords = last?.kind === "system" && last?.text === STOP_CUT_ANSWER_SENTENCE && saved.at(-2)?.kind === "assistant"
			? String(saved.at(-2).text).trim()
			: last?.kind === "assistant" && String(last?.text ?? "").trimEnd().endsWith(pageForm.trim())
				? String(last.text).trimEnd().slice(0, -pageForm.trim().length).trim()
				: "";
		console.log(`  thread file after the restart:\n    ${saved.slice(-3).map(itemLine).join("\n    ")}`);
		assert(savedWords.startsWith(FIRST_WORDS), `the conversation saved no cut answer ending with the server's line: ${saved.slice(-3).map(itemLine).join(", ")}`);

		// 1. The first message after the restart: the model refuses this call, the message goes back to the box.
		await composer.fill(HELLO);
		await composer.press("Enter");
		await waitUntil(() => received.length >= 1, "the first message after the restart reaches the model");
		await waitUntil(async () => (await composer.inputValue()) === HELLO, "the refused message is back in the box", 15_000);
		await fileSettled("the page's save of the failure's line has settled");
		// The note now comes from a cut answer with a line after it, which the reader skips.
		const refusedLine = threadItems().at(-1);
		assert(refusedLine?.kind === "system" && refusedLine?.text !== STOP_CUT_ANSWER_SENTENCE, `the page saved no line for the refused message after the cut answer: ${itemLine(refusedLine)}`);
		// 2. A second quit and restart with the message in the box; sent from the box again, it answers.
		await stopSmokeServer(server);
		await startServer();
		await open();
		await waitUntil(async () => (await composer.inputValue()) === HELLO, "the reopened room puts the refused message back in the box", 15_000);
		// 3. A message sent the moment that answer ends.
		sendOnAgentEnd = THANKS;
		await composer.press("Enter");
		await waitUntil(() => received.length >= 3, "the message sent again and the one sent on its end reach the model");
		await waitUntil(() => threadItems().some((item) => item?.kind === "assistant" && String(item?.text ?? "").includes(HELLO_ANSWER)), "the hello answer is saved", 15_000);
		await fileSettled("the last saves have settled");

		received.forEach((message, index) => console.log(`  model call ${index + 1} after the restart got: ${JSON.stringify(message.length > 400 ? `${message.slice(0, 200)} … ${message.slice(-200)}` : message)}`));
		const note = expectedNote(savedWords);
		const carries = (message: string | undefined) => String(message ?? "").includes(NOTE_OPEN);
		expect(String(received[0] ?? "").endsWith(`${note}${HELLO}`), "the first message after the restart does not reach the model with the note in front holding exactly the saved words");
		expect(String(received[1] ?? "").endsWith(`${note}${HELLO}`), "the message that went back to the box lost its note when it was sent again after a restart");
		expect(String(received[2] ?? "").endsWith(THANKS) && !carries(received[2]), "a message sent the moment the noted message's answer ended carries a note again");
		expect(received.every((message) => message.split(NOTE_OPEN).length <= 2), "a message carries the note more than once");

		const items = threadItems();
		console.log(`  thread file at the end:\n    ${items.slice(-6).map(itemLine).join("\n    ")}`);
		const helloItems = items.filter((item) => item?.kind === "user" && String(item?.text ?? "").includes(HELLO));
		expect(helloItems.length === 1 && helloItems[0].text === HELLO, `the saved conversation holds the message as ${JSON.stringify(helloItems.map((item) => item.text))}, not the person's words once`);
		expect(!JSON.stringify(items).includes(NOTE_OPEN), "the saved conversation holds the note");
		const pageText = await page.locator(".messages").innerText();
		expect(!pageText.includes(NOTE_OPEN) && !pageText.includes("exxperts stopped while you were writing"), "the page shows the note");
		const helloBubbles = await page.locator(".messages .bubble-row").filter({ hasText: HELLO }).count();
		expect(helloBubbles === 1, `the page shows the message's bubble ${helloBubbles} times, not once`);
		assert(failures.length === 0, `the next message after a quit mid-answer:\n  ${failures.join("\n  ")}`);
		console.log("  ok  after a quit mid-answer and a restart, the first message reaches the model with the note holding exactly the saved words, keeps it when it goes back to the box, and the next message carries none; the bubble and the saved conversation keep the person's words");
	} finally {
		await browser.close();
	}
	console.log("quit-answer-note smoke: ok");
} catch (error) {
	console.error(serverOutput.join("").slice(-6000));
	throw error;
} finally {
	try { (endpoint as any).closeAllConnections?.(); } catch {}
	try { endpoint.close(); } catch {}
	await stopSmokeServer(server);
	fs.rmSync(tempRoot, { recursive: true, force: true });
}
