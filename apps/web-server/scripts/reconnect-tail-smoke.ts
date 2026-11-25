// A window open while its server is killed mid-answer, in the browser against
// a real spawned server and one synthetic Anthropic endpoint whose answer the
// smoke releases part by part. The new server lands the clean stop's line
// under the killed turn; the window reconnects by itself and keeps every word
// it was given:
//
// - words it had received but was still revealing when it read the line are
//   on screen and saved, with the line once;
// - a part of the answer the page saved before more of it came stays as
//   long as the window showed it, on screen and saved, with the line once,
//   also when the window's first save after the kill fails and it tries again.
//
// Neither says the connection was lost: the line says the answer stopped. And
// a reconnect's save that answers after the person left for another room
// leaves that room's wait alone.
// Every row runs and reports, so a run against an older page shows each one
// that fails.
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import { fileURLToPath } from "node:url";
import { chromium, type Page, type WebSocketRoute } from "playwright";
import { authedFetch, killSmokeServer, SMOKE_AUTH_TOKEN, SMOKE_SERVER_AUTH_ENV, SMOKE_SERVER_SPAWN_TREE_OPTIONS, smokeHomeEnv, stopSmokeServer, freePort } from "./smoke-server-process.js";
import { sendFromBox } from "./smoke-wait.js";
import { STOP_CUT_ANSWER_SENTENCE } from "../src/turn-ended-by.js";

function assert(condition: unknown, message: string): asserts condition {
	if (!condition) throw new Error(message);
}

{
	const p = typeof chromium?.executablePath === "function" ? chromium.executablePath() : "";
	if (!p || !fs.existsSync(p)) {
		console.log("reconnect tail smoke skipped (Chromium not installed)");
		process.exit(0);
	}
}

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const webServerDir = path.resolve(scriptDir, "..");
const repoRoot = path.resolve(webServerDir, "..", "..");
const port = await freePort();
const baseUrl = `http://127.0.0.1:${port}`;

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "exxperts-reconnect-tail-"));
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
const GATED = "[gated]";
const CONNECTION_LOST = "Response interrupted: the connection was lost.";
const line = (n: number) => `Line ${n}: the answer keeps growing until the server is killed.\n\n`;

function sse(res: http.ServerResponse, event: string, payload: unknown): void {
	res.write(`event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`);
}

// The open gated answer: the smoke sends its parts with release(), and the kill cuts it.
let open: { res: http.ServerResponse; sent: number } | null = null;
const endpoint = http.createServer((req, res) => {
	let raw = "";
	req.on("data", (chunk) => { raw += chunk; });
	req.on("end", () => {
		const body = JSON.parse(raw || "{}");
		res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
		sse(res, "message_start", { type: "message_start", message: { id: "msg_smoke", type: "message", role: "assistant", model: body.model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 100, output_tokens: 1 } } });
		sse(res, "content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } });
		const lastUser = JSON.stringify((body.messages ?? []).filter((m: { role?: string }) => m.role === "user").at(-1) ?? "");
		if (lastUser.includes(GATED)) {
			open = { res, sent: 0 };
			return;
		}
		sse(res, "content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "OK." } });
		sse(res, "content_block_stop", { type: "content_block_stop", index: 0 });
		sse(res, "message_delta", { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 4 } });
		sse(res, "message_stop", { type: "message_stop" });
		res.end();
	});
});
const release = (parts: number) => {
	const answer = open!;
	for (let i = 0; i < parts; i++) {
		answer.sent += 1;
		sse(answer.res, "content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: line(answer.sent) } });
	}
	return answer.sent;
};
/** The server died mid-answer: its stream is cut here, and nothing more is sent on it. */
const cutOpenAnswer = () => {
	try { open?.res.destroy(); } catch {}
	open = null;
};

async function waitUntil(predicate: () => Promise<boolean> | boolean, label: string, timeoutMs = 25_000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (await predicate()) return;
		await new Promise((resolve) => setTimeout(resolve, 100));
	}
	throw new Error(`timed out waiting until ${label}`);
}

/** A row's outcome: null when it holds, else what went wrong. */
type RowResult = string | null;
const failures: string[] = [];
async function row(name: string, run: () => Promise<RowResult>): Promise<void> {
	let failed: RowResult;
	try {
		failed = await run();
	} catch (error) {
		failed = error instanceof Error ? error.message : String(error);
	}
	if (failed === null) console.log(`  ok  ${name}`);
	else {
		console.log(`  FAIL  ${name}: ${failed}`);
		failures.push(name);
	}
}

let server: ChildProcessWithoutNullStreams | undefined;
const serverOutput: string[] = [];

try {
	await new Promise<void>((resolve) => endpoint.listen(0, "127.0.0.1", resolve));
	const endpointUrl = `http://127.0.0.1:${(endpoint.address() as AddressInfo).port}`;
	fs.writeFileSync(path.join(agentDir, "models.json"), JSON.stringify({ providers: { [KEY_PROVIDER]: { baseUrl: endpointUrl } } }, null, 2), { mode: 0o600 });
	fs.writeFileSync(path.join(agentDir, "auth.json"), JSON.stringify({ [KEY_PROVIDER]: { type: "api_key", key: "synthetic-anthropic-key" } }, null, 2), { mode: 0o600 });
	fs.writeFileSync(path.join(agentDir, "settings.json"), JSON.stringify({ retry: { baseDelayMs: 1000, provider: { maxRetries: 0 } } }, null, 2), { mode: 0o600 });
	const agents = await import("../src/persistent-agents.js");
	const ROOMS = ["Tail Room", "Copy Room", "Retry Room", "Left Room", "Next Room"] as const;
	const rooms = Object.fromEntries(ROOMS.map((displayName) => [displayName, agents.createPersistentAgentFromScaffoldInput({ displayName, userName: "Synthetic User", preferredUserAddress: "Synthetic User" }).agent.agentId])) as Record<(typeof ROOMS)[number], string>;
	const startServer = async () => {
		const started = spawn("npx", ["tsx", "src/index.ts"], {
			shell: process.platform === "win32",
			...SMOKE_SERVER_SPAWN_TREE_OPTIONS,
			cwd: webServerDir,
			env: smokeHomeEnv(tempHome, { PORT: String(port), ...SMOKE_SERVER_AUTH_ENV, EXXETA_HOME: repoRoot, EXXPERTS_CODING_AGENT_DIR: agentDir, EXXETA_PERSISTENT_AGENTS_ROOT: agentsRoot }) as NodeJS.ProcessEnv,
		});
		started.stdout.on("data", (chunk) => serverOutput.push(String(chunk)));
		started.stderr.on("data", (chunk) => serverOutput.push(String(chunk)));
		server = started;
		await waitUntil(() => fetch(`${baseUrl}/healthz`).then((r) => r.ok).catch(() => false), "server ready", 60_000);
	};
	await startServer();
	const approved = await authedFetch(`${baseUrl}/api/persistent-agent-ai-profiles/custom`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ providerId: KEY_PROVIDER, label: "Claude API key", roomModels: [ON_KEY.model], learnModel: ON_KEY.model }) });
	assert(approved.ok, `the key's model is approved, got ${approved.status}`);
	for (const agentId of Object.values(rooms)) {
		const picked = await authedFetch(`${baseUrl}/api/persistent-agents/${agentId}/models`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ conversation: ON_KEY }) });
		assert(picked.ok, `the room picks the key's model, got ${picked.status}`);
	}


	const browser = await chromium.launch();
	try {
		/** A page in one room. While its frames are held, the answer reveals nothing more of what it received. */
		interface RoomPage {
			page: Page;
			readies: () => number;
			received: (text: string) => boolean;
			/** The conversation as saved, the one the window's connection names. */
			savedItems: () => Promise<any[]>;
			holdFrames: (hold: boolean) => Promise<void>;
			/** While set, the page's saves of the conversation fail, as on a network fault. */
			failThreadSaves: (fail: boolean) => void;
			/** How many of the page's saves failed so. */
			failedSaves: () => number;
			/** The page's next save of the conversation waits until releaseSave(). */
			holdNextSave: () => void;
			savesHeld: () => number;
			releaseSave: () => void;
			/** The network drops; while `down`, every new room connection fails at once. */
			drop: () => void;
			setDown: (down: boolean) => void;
		}
		const enter = async (room: string): Promise<RoomPage> => {
			const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
			// The answer's reveal runs on animation frames: held, they wait, as on a busy screen, until let go.
			await context.addInitScript(() => {
				const realRequest = window.requestAnimationFrame.bind(window);
				const realCancel = window.cancelAnimationFrame.bind(window);
				const held = new Map<number, FrameRequestCallback>();
				let nextHeld = 1_000_000_000;
				let holding = false;
				window.requestAnimationFrame = (callback) => {
					if (!holding) return realRequest(callback);
					nextHeld += 1;
					held.set(nextHeld, callback);
					return nextHeld;
				};
				window.cancelAnimationFrame = (id) => {
					if (!held.delete(id)) realCancel(id);
				};
				(window as any).__holdFrames = (hold: boolean) => {
					holding = hold;
					if (hold) return;
					const waiting = [...held.values()];
					held.clear();
					for (const callback of waiting) realRequest(callback);
				};
			});
			const page = await context.newPage();
			let readies = 0;
			let frames = "";
			let threadSavesFail = false;
			let failedSaves = 0;
			let saveHolds = 0;
			const heldSaves: (() => void)[] = [];
			let down = false;
			const live: { page: WebSocketRoute; server: WebSocketRoute }[] = [];
			let conversationId = "";
			await page.routeWebSocket(/\/ws\?/, (ws) => {
				if (down) {
					void ws.close({ code: 4000, reason: "down" }).catch(() => {});
					return;
				}
				conversationId = new URL(ws.url()).searchParams.get("conversationId") ?? conversationId;
				const upstream = ws.connectToServer();
				live.push({ page: ws, server: upstream });
				ws.onMessage((message) => upstream.send(message));
				upstream.onMessage((message) => {
					const text = String(message);
					if (text.includes('"type":"ready"')) readies += 1;
					frames += text;
					try { ws.send(message); } catch {}
				});
				upstream.onClose((code, reason) => ws.close({ code, reason }));
				ws.onClose(() => upstream.close());
			});
			await page.route(/\/api\/persistent-agents\/[^/]+\/threads\/[^/]+$/, (route) => {
				if (route.request().method() === "PUT" && threadSavesFail) {
					failedSaves += 1;
					return route.abort("failed");
				}
				if (route.request().method() === "PUT" && saveHolds > 0) {
					saveHolds -= 1;
					heldSaves.push(() => void route.fallback().catch(() => {}));
					return;
				}
				return route.fallback();
			});
			await page.goto(`${baseUrl}/auth/session?token=${SMOKE_AUTH_TOKEN}`);
			await page.waitForLoadState("networkidle");
			const dismiss = page.locator(".whats-new-close");
			if (await dismiss.count()) await dismiss.click();
			await page.locator(".persistent-agent-card").filter({ hasText: room }).getByRole("button", { name: /^(Enter|Resume)$/ }).click();
			await page.locator('button[title="Send"]').first().waitFor({ timeout: 15000 });
			await waitUntil(() => readies > 0, "the room's connection is ready");
			return {
				page,
				readies: () => readies,
				received: (text) => frames.includes(text),
				savedItems: async () => {
					if (!conversationId) return [];
					const answer = await authedFetch(`${baseUrl}/api/persistent-agents/${rooms[room as (typeof ROOMS)[number]]}/threads/${conversationId}`);
					return answer.ok ? ((await answer.json())?.thread?.items ?? []) : [];
				},
				holdFrames: (hold) => page.evaluate((value) => (window as any).__holdFrames(value), hold),
				failThreadSaves: (fail) => { threadSavesFail = fail; },
				failedSaves: () => failedSaves,
				holdNextSave: () => { saveHolds += 1; },
				savesHeld: () => heldSaves.length,
				releaseSave: () => { for (const next of heldSaves.splice(0)) next(); },
				drop: () => {
					for (const pair of live.splice(0)) {
						void pair.page.close({ code: 4000, reason: "dropped" }).catch(() => {});
						void pair.server.close().catch(() => {});
					}
				},
				setDown: (value) => { down = value; },
			};
		};
		const send = async (page: Page, text: string) => {
			await page.locator("textarea").first().fill(text);
			await sendFromBox(page);
			await waitUntil(async () => (await page.locator(".bubble-row.user").filter({ hasText: text }).count()) > 0, `"${text}" is sent`);
			await waitUntil(() => open !== null, "the gated answer has begun");
		};
		const answerText = (page: Page) => page.evaluate(() => [...document.querySelectorAll(".messages .assistant-markdown")].map((el) => el.textContent ?? "").filter((text) => text.includes("Line 1:")).pop() ?? "");
		const linesShown = async (page: Page) => (await answerText(page)).split("until the server is killed.").length - 1;
		const shownCount = (page: Page, text: string) => page.getByText(text).count();
		/** How many times the conversation says the stop line; its two sentences are drawn apart. */
		const stopLinesShown = (page: Page) => page.evaluate((sentence) => (document.querySelector(".messages")?.textContent ?? "").replace(/\s+/g, "").split(sentence.replace(/\s+/g, "")).length - 1, STOP_CUT_ANSWER_SENTENCE);
		const savedAnswer = async (room: RoomPage) => (await room.savedItems()).filter((item) => item.kind === "assistant").map((item) => String(item.text ?? "")).join("");
		/** The server is killed mid-answer and a new one starts on the same disk; the window reconnects by itself and its turn ends. `back` runs once the new server answers. */
		const killAndReconnect = async (room: RoomPage, back: () => Promise<void> = async () => undefined) => {
			const before = room.readies();
			await killSmokeServer(server);
			cutOpenAnswer();
			await startServer();
			await back();
			await waitUntil(() => room.readies() > before, "the room reconnects to the new server", 60_000);
			await waitUntil(async () => (await room.page.locator(".stop-btn").count()) === 0, "the window's turn has ended");
		};
		/** What the window shows and what is saved: every line it was given, and the stop line once. */
		const keptWhole = async (room: RoomPage, lines: number): Promise<RowResult> => {
			await waitUntil(async () => (await stopLinesShown(room.page)) > 0, "the stop line shows", 15_000).catch(() => {});
			const stopped = await stopLinesShown(room.page);
			if (stopped !== 1) return `the stop line shows ${stopped} times`;
			if ((await shownCount(room.page, CONNECTION_LOST)) > 0) return "the answer says the connection was lost";
			if ((await linesShown(room.page)) !== lines) return `the window shows ${await linesShown(room.page)} of the ${lines} lines it was given`;
			await waitUntil(async () => (await savedAnswer(room)).includes(`Line ${lines}:`), "the whole answer is saved").catch(() => {});
			const saved = (await savedAnswer(room)).split("until the server is killed.").length - 1;
			return saved === lines ? null : `${saved} of the ${lines} lines are saved`;
		};

		// Nothing of the answer is saved: the page saves half a second after its last change, and the words wait to be revealed.
		const tail = await enter("Tail Room");
		await send(tail.page, `Tail question ${GATED}`);
		await waitUntil(async () => (await tail.savedItems()).some((item) => item.kind === "user"), "the question is saved");
		await tail.page.waitForTimeout(1_000);
		await tail.holdFrames(true);
		const tailSent = release(3);
		await waitUntil(() => tail.received(`Line ${tailSent}:`), "the page has received the answer so far");
		await tail.page.waitForTimeout(300);
		assert((await linesShown(tail.page)) < tailSent, "the received words wait to be revealed");
		await killAndReconnect(tail);
		await tail.holdFrames(false);
		await row("words still being revealed when the window reads the stop line are kept, on screen and saved", () => keptWhole(tail, tailSent));
		await tail.page.context().close();

		// The page saved the first lines; more came, and its save of them failed, so the saved part is the shorter one.
		// With `failFirst`, the window's first save after the kill fails too, and it reconnects again.
		const shorterSaved = async (name: (typeof ROOMS)[number], failFirst: boolean): Promise<RowResult> => {
			const room = await enter(name);
			try {
				await send(room.page, `${name} question ${GATED}`);
				const firstSaved = release(2);
				await waitUntil(async () => (await savedAnswer(room)).includes(`Line ${firstSaved}:`), "the first lines are saved");
				room.failThreadSaves(true);
				const sent = release(3);
				await waitUntil(async () => (await linesShown(room.page)) === sent, "every line is on screen");
				await waitUntil(() => room.failedSaves() > 0, "the page's save of every line failed");
				if (!failFirst) room.failThreadSaves(false);
				await killAndReconnect(room, async () => {
					if (!failFirst) return;
					const failed = room.failedSaves();
					await waitUntil(() => room.failedSaves() > failed, "the window's first save after the kill failed", 60_000);
					room.failThreadSaves(false);
				});
				return await keptWhole(room, sent);
			} finally {
				await room.page.context().close();
			}
		};
		await row("a saved part shorter than the window's answer stays as long as the window showed it, on screen and saved", () => shorterSaved("Copy Room", false));
		await row("so it does when the window's first save after the kill fails and it reconnects again", () => shorterSaved("Retry Room", true));

		// The person leaves a room while its reconnect's save is still out, asks in another room, and that room's
		// connection drops: the late reply from the room they left does not end the wait in the room they are in.
		await row("a late reply to a reconnect's save from a room the person left keeps the next room's answer waiting, with Stop", async () => {
			const room = await enter("Left Room");
			const { page } = room;
			try {
				await send(page, `Left question ${GATED}`);
				const sent = release(2);
				await waitUntil(async () => (await savedAnswer(room)).includes(`Line ${sent}:`), "the answer so far is saved");
				room.holdNextSave();
				await killSmokeServer(server);
				cutOpenAnswer();
				await startServer();
				await waitUntil(() => room.savesHeld() > 0, "the reconnect's save is out", 60_000);
				await page.getByRole("button", { name: "Rooms", exact: true }).first().click();
				const before = room.readies();
				await page.locator(".persistent-agent-card").filter({ hasText: "Next Room" }).getByRole("button", { name: /^Enter$/ }).click();
				await waitUntil(() => room.readies() > before, "the next room's connection is ready");
				await send(page, `Next question ${GATED}`);
				release(1);
				await waitUntil(async () => (await answerText(page)).includes("Line 1:"), "the next room's answer has begun");
				room.setDown(true);
				room.drop();
				// The turn still runs here: Stop shows, kept across each try to reconnect, and nothing says the answer ended.
				// Neither the "Reconnecting…" line nor the answer's drawing is the turn: each try redraws them.
				const turnRuns = async (): Promise<RowResult> => {
					if ((await page.locator(".stop-btn").count()) !== 1) return "Stop is gone from the next room";
					if ((await shownCount(page, CONNECTION_LOST)) > 0 || (await stopLinesShown(page)) > 0) return "the next room's answer says it ended";
					return null;
				};
				await waitUntil(async () => (await page.locator(".turn-status-line").filter({ hasText: "Reconnecting…" }).count()) === 1, "the next room waits, reconnecting");
				const waiting = await turnRuns();
				if (waiting !== null) return `before the late reply: ${waiting}`;
				const replied = page.waitForResponse((answer) => answer.request().method() === "PUT" && answer.url().includes(`/api/persistent-agents/${rooms["Left Room"]}/threads/`));
				room.releaseSave();
				// The whole reply, its body included, has reached the page; then the turn holds while the page acts on it.
				await (await replied).finished();
				const settleEnds = Date.now() + 1_500;
				while (Date.now() < settleEnds) {
					const ended = await turnRuns();
					if (ended !== null) return ended;
					await page.waitForTimeout(100);
				}
				return null;
			} finally {
				room.setDown(false);
				cutOpenAnswer();
				await page.context().close();
			}
		});
	} finally {
		await browser.close();
	}
	if (failures.length) throw new Error(`reconnect-tail smoke: ${failures.length} row(s) failed: ${failures.join("; ")}`);
	console.log("reconnect-tail smoke: ok");
} catch (error) {
	console.error(serverOutput.join("").slice(-6000));
	throw error;
} finally {
	try { (endpoint as any).closeAllConnections?.(); } catch {}
	try { endpoint.close(); } catch {}
	await stopSmokeServer(server);
	fs.rmSync(tempRoot, { recursive: true, force: true });
}
