// The server's graceful stop with the page open and an answer still
// streaming, in the browser against a real spawned server, its real stop
// (SIGTERM) and one synthetic Anthropic endpoint on a Claude API key: the
// desktop app's quit mid-answer. After the restart and a reload, the cut
// answer keeps the message and its partial and ends with the server's
// sentence, once, and nothing calls it a lost connection: not the page, not
// the room's thread file.
//
// It also prints which write landed last: each change of the thread file
// during the stop, and each of the page's saves against the close, so a red
// run says whose write won.
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
		console.log("server stop page open smoke skipped (Chromium not installed)");
		process.exit(0);
	}
}
// On Windows a stop is a forced kill, so no careful stop runs.
if (process.platform === "win32") {
	console.log("server stop page open smoke skipped (no graceful stop on Windows)");
	process.exit(0);
}

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const webServerDir = path.resolve(scriptDir, "..");
const repoRoot = path.resolve(webServerDir, "..", "..");
const port = await freePort();
const baseUrl = `http://127.0.0.1:${port}`;

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "exxperts-stop-page-open-"));
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
const CONNECTION_LOST = "the connection was lost";
const MESSAGE = "A long answer, please.";
// Far longer than the stop's wait: the stop cuts it. Each part comes faster than the page's reveal shows it,
// so the reveal is still running at the close, as with a long answer in the app.
const PARTS = 120;
const PART_MS = 150;
// Longer than the page's debounced save (500 ms after its items change, persistConversation in App.tsx), so a quiet
// spell this long means no save is still waiting to go out.
const SAVES_QUIET_MS = 1500;
const part = (index: number) => `Part ${index + 1} of the long answer, cut by the stop. `;
const FIRST_WORDS = "Part 1 of the long answer";

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
		sse(res, "content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } });
		// The room-state copy rides after the person's message; only the person's message asks for the long answer.
		const textOf = (content: unknown) => (typeof content === "string" ? content : Array.isArray(content) ? content.map((block: any) => (typeof block?.text === "string" ? block.text : "")).join("") : "");
		const asked = (body.messages ?? []).some((message: any) => message?.role === "user" && !textOf(message?.content).startsWith(ROOM_STATE_HEADING) && textOf(message?.content).includes(MESSAGE));
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

// One line per thread item, short enough to log: its kind, its id and the end of its text.
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
		// Times are milliseconds from the SIGTERM; the close is when the server closed the room's socket.
		let stopAt = 0;
		const since = () => Date.now() - stopAt;
		const socket = { readies: 0, noticeAt: undefined as number | undefined, agentEnd: undefined as undefined | { at: number; stoppedByServer: boolean; endedBy?: string }, closeAt: undefined as number | undefined, streamed: "" };
		await page.routeWebSocket(/\/ws\?/, (ws) => {
			const upstream = ws.connectToServer();
			ws.onMessage((message) => upstream.send(message));
			upstream.onMessage((message) => {
				const text = String(message);
				if (text.includes('"type":"ready"')) socket.readies += 1;
				// The answer as it streamed until its end: the words the stop must keep, whoever writes the file.
				if (!socket.agentEnd && text.includes('"text_delta"')) {
					const update = JSON.parse(text)?.event?.assistantMessageEvent;
					if (update?.type === "text_delta" && typeof update.delta === "string") socket.streamed += update.delta;
				}
				if (stopAt && text.includes('"type":"server_stopping"')) socket.noticeAt = since();
				if (stopAt && text.includes('"type":"agent_end"')) {
					const event = JSON.parse(text)?.event ?? {};
					socket.agentEnd = { at: since(), stoppedByServer: event.stoppedByServer === true, ...(typeof event.endedBy === "string" ? { endedBy: event.endedBy } : {}) };
				}
				ws.send(message);
			});
			upstream.onClose((code, reason) => {
				if (stopAt && socket.closeAt === undefined) socket.closeAt = since();
				ws.close({ code, reason });
			});
			ws.onClose(() => upstream.close());
		});
		// The page's saves of the thread, from the SIGTERM on: when each was sent and how it ended.
		const saves: Array<{ sentAt: number; endedAt?: number; outcome?: string; lostLine: boolean; sentence: boolean }> = [];
		const saveOf = new Map<object, (typeof saves)[number]>();
		const isSave = (request: { method(): string; url(): string }) => request.method() === "PUT" && /\/api\/persistent-agents\/[^/]+\/threads\//.test(request.url());
		page.on("request", (request) => {
			if (!stopAt || !isSave(request)) return;
			const body = request.postData() ?? "";
			const save = { sentAt: since(), lostLine: body.includes(CONNECTION_LOST), sentence: body.includes(STOP_CUT_ANSWER_SENTENCE) };
			saves.push(save);
			saveOf.set(request, save);
		});
		page.on("requestfinished", async (request) => {
			const save = saveOf.get(request);
			if (!save) return;
			save.endedAt = since();
			save.outcome = String((await request.response())?.status() ?? "no answer");
		});
		page.on("requestfailed", (request) => {
			const save = saveOf.get(request);
			if (!save) return;
			save.endedAt = since();
			save.outcome = request.failure()?.errorText ?? "failed";
		});
		const open = async () => {
			await page.goto(`${baseUrl}/auth/session?token=${SMOKE_AUTH_TOKEN}`);
			await page.waitForLoadState("networkidle");
			const dismiss = page.locator(".whats-new-close");
			if (await dismiss.count()) await dismiss.click();
			const readies = socket.readies;
			await page.locator(".persistent-agent-card").filter({ hasText: "Quit Room" }).getByRole("button", { name: /^(Enter|Resume)$/ }).click();
			await page.locator('button[title="Send"]').first().waitFor({ timeout: 15000 });
			await waitUntil(() => socket.readies > readies, "the room's connection is ready");
		};
		await open();
		const composer = page.locator("textarea").first();
		await composer.fill(MESSAGE);
		await composer.press("Enter");
		await page.getByText(FIRST_WORDS).first().waitFor({ timeout: 20000 });
		await waitUntil(() => deltasSent >= 6, "the answer streams");
		const status = await (await authedFetch(`${baseUrl}/api/persistent-agents/${agentId}/status`)).json();
		const threadId = String(status?.activeThread?.threadId ?? "");
		assert(threadId, "the room has an open conversation");
		// The file as written, not through the reader, which drops repeated items.
		const threadFile = createPersistentAgentInstance(agentId).runtimeThreadPath(threadId);
		const threadItems = (): any[] => {
			try { return JSON.parse(fs.readFileSync(threadFile, "utf8"))?.items ?? []; } catch { return []; }
		};

		// Every change of the thread file from the SIGTERM on, read off the disk.
		const writes: Array<{ at: number; items: any[] }> = [];
		let lastSeen = JSON.stringify(threadItems());
		const sampler = setInterval(() => {
			const items = threadItems();
			const seen = JSON.stringify(items);
			if (seen === lastSeen) return;
			lastSeen = seen;
			writes.push({ at: since(), items });
		}, 20);

		// The quit: SIGTERM, then the process's end.
		stopAt = Date.now();
		await stopSmokeServer(server);
		const exitAt = since();
		const outputAtStop = serverOutput.join("");
		// The page's saves after the close have nowhere to go now; the last one's failure is what the page saw.
		await waitUntil(() => saves.every((save) => save.endedAt !== undefined), "the page's saves have ended", 10_000);
		clearInterval(sampler);
		const afterStop = threadItems();

		// The restart on the same home, and a reload.
		await startServer();
		const savesBeforeReload = saves.length;
		await open();
		await page.getByText(FIRST_WORDS).first().waitFor({ timeout: 15000 });
		// The line shows in either writer's form: the last line of the answer's text, or the server's own failure line,
		// whose two sentences the page shows as two paragraphs. Each item on screen that shows it counts once.
		const sentenceOnPage = {
			count: () => page.evaluate((sentence) => {
				const rows = [...document.querySelectorAll(".messages .bubble-row, .messages .system-line")];
				const showing = rows.filter((row) => (row as HTMLElement).innerText.replace(/\s+/g, " ").includes(sentence));
				return showing.filter((row) => !showing.some((other) => other !== row && other.contains(row))).length;
			}, STOP_CUT_ANSWER_SENTENCE),
		};
		await waitUntil(async () => (await sentenceOnPage.count()) > 0 || (await page.getByText(CONNECTION_LOST).count()) > 0, "the reopened room shows the cut answer's line", 10_000).catch(() => {});
		const lastSaveMove = () => Math.max(0, ...saves.map((save) => save.endedAt ?? save.sentAt));
		await waitUntil(() => saves.every((save) => save.endedAt !== undefined) && since() - lastSaveMove() >= SAVES_QUIET_MS, "the reopened page's saves have settled", 15_000);
		const afterRestart = threadItems();

		console.log(`  stop: notice at ${socket.noticeAt ?? "-"} ms, agent_end at ${socket.agentEnd?.at ?? "-"} ms (stoppedByServer ${socket.agentEnd?.stoppedByServer ?? "-"}, endedBy ${socket.agentEnd?.endedBy ?? "-"}), close at ${socket.closeAt ?? "-"} ms, exit at ${exitAt} ms`);
		console.log(`  stop's end line: ${outputAtStop.match(/server stop: ended[^\n"]*/)?.[0] ?? "none"}`);
		for (const write of writes) console.log(`  thread file written at ${write.at} ms:\n    ${write.items.slice(-3).map(itemLine).join("\n    ")}`);
		saves.forEach((save, index) => console.log(`  page save ${index + 1}${index >= savesBeforeReload ? " (after the reload)" : ""}: sent at ${save.sentAt} ms, ended at ${save.endedAt ?? "-"} ms (${save.outcome ?? "no end"}), carries the lost-connection line ${save.lostLine}, the server's sentence ${save.sentence}`));
		console.log(`  thread file after the stop:\n    ${afterStop.slice(-3).map(itemLine).join("\n    ")}`);
		console.log(`  thread file after the restart and reload:\n    ${afterRestart.slice(-3).map(itemLine).join("\n    ")}`);

		const messages = afterRestart.filter((item) => item?.kind === "user" && String(item?.text ?? "").includes(MESSAGE));
		const partials = afterRestart.filter((item) => item?.kind === "assistant" && String(item?.text ?? "").includes(FIRST_WORDS));
		const sentences = afterRestart.filter((item) => String(item?.text ?? "").includes(STOP_CUT_ANSWER_SENTENCE));
		expect(socket.agentEnd?.stoppedByServer === true, "the stop did not cut the answer: its agent_end carries no stoppedByServer");
		expect(messages.length === 1, `the thread file holds the message ${messages.length} times, not once`);
		expect(partials.length === 1, `the thread file holds the cut answer's partial ${partials.length} times, not once`);
		expect(sentences.length === 1, `the thread file holds the server's sentence ${sentences.length} times, not once`);
		// The line ends the cut answer in either writer's form: the server's landing writes it as its own item,
		// the page as the last line of the answer's text, as it marks every cut answer.
		const last = afterRestart.at(-1);
		const endsWithSentence = (last?.kind === "system" && last?.text === STOP_CUT_ANSWER_SENTENCE) || (last?.kind === "assistant" && String(last?.text ?? "").trimEnd().endsWith(`_${STOP_CUT_ANSWER_SENTENCE}_`));
		expect(endsWithSentence, `the cut answer's line in the thread file is not the server's sentence: ${itemLine(last)}`);
		// Whichever write lands last, the partial keeps every word that streamed before the stop ended the answer: the
		// file after the stop (what a window that died with the app reopens) and the file after the restart and reload.
		const streamed = socket.streamed.trim();
		expect(streamed.includes(FIRST_WORDS), "the answer's words before its end were not seen on the room's connection");
		const keepsStreamed = (items: any[]) => items.some((item) => item?.kind === "assistant" && String(item?.text ?? "").includes(streamed));
		expect(keepsStreamed(afterStop), "the thread file after the stop lost words of the answer that streamed before the stop");
		expect(keepsStreamed(afterRestart), `the partial after the restart lost words of the answer that streamed before the stop: ${partials.map(itemLine).join(", ") || "none"}`);
		expect(!JSON.stringify(afterRestart).includes(CONNECTION_LOST), "the thread file calls the cut answer a lost connection");
		expect((await sentenceOnPage.count()) === 1, `the reopened room shows the server's sentence ${await sentenceOnPage.count()} times, not once`);
		expect((await page.getByText(CONNECTION_LOST).count()) === 0, "the reopened room calls the cut answer a lost connection");
		assert(failures.length === 0, `the cut answer with the page open:\n  ${failures.join("\n  ")}`);
		console.log("  ok  an answer the stop cuts with the page open ends with the server's sentence, once, after a restart and a reload; nothing calls it a lost connection; the message and the partial are kept");
	} finally {
		await browser.close();
	}
	console.log("server-stop-page-open smoke: ok");
} catch (error) {
	console.error(serverOutput.join("").slice(-6000));
	throw error;
} finally {
	try { (endpoint as any).closeAllConnections?.(); } catch {}
	try { endpoint.close(); } catch {}
	await stopSmokeServer(server);
	fs.rmSync(tempRoot, { recursive: true, force: true });
}
