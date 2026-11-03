// A dropped connection and another window, in the browser against a real
// spawned server and one synthetic Anthropic endpoint whose answer the smoke
// releases part by part. The page's room connection runs through a route the
// smoke can drop, hold down and make repeat frames on:
//
// - at a drop the answer keeps revealing what already arrived, at the reading
//   pace, then pauses; nothing is said in the answer while the room
//   reconnects, and exactly one "Reconnecting…" shows, in the working dot's
//   place; Stop stays (unavailable) and so does the header's spinner;
// - after a short blip the text written while away comes at the reading pace;
// - a slow replay never takes the answer off the screen, nor turns it into
//   an older, shorter saved copy, and one still on its way when the person
//   opens another room leaves that room alone;
// - when reconnecting gives up the answer says the connection was lost, and
//   that line is gone once the full answer arrives, also when it gave up
//   before any text, the answer landed meanwhile or replayed after Reconnect;
// - a replayed frame that comes twice never shows its text twice;
// - an answer the server lost (it died mid-answer and came back) says the
//   connection was lost;
// - a window another took the room from keeps what it showed, offers no Stop,
//   and "Open here" takes the room back.
//
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

function assert(condition: unknown, message: string): asserts condition {
	if (!condition) throw new Error(message);
}

{
	const p = typeof chromium?.executablePath === "function" ? chromium.executablePath() : "";
	if (!p || !fs.existsSync(p)) {
		console.log("chat reconnect smoke skipped (Chromium not installed)");
		process.exit(0);
	}
}

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const webServerDir = path.resolve(scriptDir, "..");
const repoRoot = path.resolve(webServerDir, "..", "..");
const port = await freePort();
const baseUrl = `http://127.0.0.1:${port}`;

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "exxperts-chat-reconnect-"));
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
const line = (n: number) => `Line ${n}: the answer keeps growing while the connection comes and goes.\n\n`;

function sse(res: http.ServerResponse, event: string, payload: unknown): void {
	res.write(`event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`);
}

// The open gated answer: the smoke sends its parts with release() and ends it with modelDone().
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
		end(res);
	});
});
function end(res: http.ServerResponse): void {
	sse(res, "content_block_stop", { type: "content_block_stop", index: 0 });
	sse(res, "message_delta", { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 400 } });
	sse(res, "message_stop", { type: "message_stop" });
	res.end();
}
const release = (parts: number) => {
	const answer = open!;
	for (let i = 0; i < parts; i++) {
		answer.sent += 1;
		sse(answer.res, "content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: line(answer.sent) } });
	}
	return answer.sent;
};
const modelDone = () => {
	end(open!.res);
	open = null;
};
/** Sends these words on the open answer, as the model's next text. */
const sayInOpenAnswer = (text: string) => {
	sse(open!.res, "content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text } });
};
/** Whether the server has closed the open answer's stream itself, as it does when Stop cancels the model's request. */
const openAnswerClosedByServer = () => open === null || open.res.destroyed;
/** The server cancelled the open answer: nothing more is sent on it. */
const forgetOpenAnswer = () => {
	open = null;
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
	const ROOMS = ["Drop Room", "Blip Room", "Slow Room", "Home Room", "Away Room", "Retry Room", "Window Room", "Crash Room", "Late Room", "Later Room", "Cut Room", "Gen Room", "Landed Room", "Paced Room", "Retry Read Room", "Phone Room", "Stop Room", "Think Room", "Think Replay Room", "Older Copy Room"] as const;
	const rooms = Object.fromEntries(ROOMS.map((displayName) => [displayName, agents.createPersistentAgentFromScaffoldInput({ displayName, userName: "Synthetic User", preferredUserAddress: "Synthetic User" }).agent.agentId]));
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
		/** A page in one room, its room connection run through a route the smoke controls. */
		interface RoomPage {
			page: Page;
			readies: () => number;
			/** Whether a frame from the server carried this text. */
			received: (text: string) => boolean;
			/** The network drops; while `down`, every new connection and request fails at once. */
			drop: () => void;
			setDown: (down: boolean) => void;
			/** Every turn frame (one with a seq) is passed on twice. */
			setRepeat: (repeat: boolean) => void;
			/** After a turn_reattach frame, the frames that follow wait this long, as on a slow link (0: none); with `withStart`, that frame waits too. */
			setSlowReplay: (ms: number, withStart?: boolean) => void;
			/** While held, the page's room list request (the rooms' status) waits; letting go answers the held ones. */
			holdRoomList: (hold: boolean) => void;
			/** While held, a new room connection waits before it reaches the server; letting go connects the held ones. */
			holdSockets: (hold: boolean) => void;
			socketsHeld: () => number;
			/** The page's next conversation read waits until releaseThreadRead(). */
			holdNextThreadRead: () => void;
			threadReadsHeld: () => number;
			releaseThreadRead: () => void;
			/** The page's next conversation read fails once, as on a brief network fault. */
			failNextThreadRead: () => void;
			/** While set, the page's saves of the conversation fail, so the saved copy stays as it was. */
			failThreadSaves: (fail: boolean) => void;
			/** Whether a turn_reattach frame reached the page. */
			reattached: () => boolean;
			/** Hands the page this frame from the server, then closes the connection, as the server does when it is displaced. */
			sendAndClose: (frame: unknown) => void;
			/** Hands the page this frame from the server; the connection stays. */
			inject: (frame: unknown) => void;
		}
		const enter = async (room: string): Promise<RoomPage> => {
			const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
			// The page's clock can be moved on, so a reconnect gives up without the smoke waiting minutes.
			await context.addInitScript(() => {
				const real = Date.now.bind(Date);
				let ahead = 0;
				Date.now = () => real() + ahead;
				(window as any).__moveClockOn = (ms: number) => { ahead += ms; };
			});
			const page = await context.newPage();
			let readies = 0;
			let frames = "";
			let down = false;
			let repeat = false;
			let slowReplayMs = 0;
			let slowReplayWithStart = false;
			let reattachedAt = 0;
			let heldLists: (() => void)[] | null = null;
			let socketsOnHold = false;
			const heldSockets: (() => void)[] = [];
			let threadReadHolds = 0;
			let threadReadFailures = 0;
			let threadSavesFail = false;
			const heldThreadReads: (() => void)[] = [];
			const live: { page: WebSocketRoute; server: WebSocketRoute }[] = [];
			await page.route(/\/api\//, (route) => {
				if (down) return route.abort("internetdisconnected");
				if (threadSavesFail && route.request().method() === "PUT" && /^\/api\/persistent-agents\/[^/]+\/threads\/[^/]+$/.test(new URL(route.request().url()).pathname)) return route.abort("failed");
				if (threadReadFailures > 0 && route.request().method() === "GET" && /^\/api\/persistent-agents\/[^/]+\/threads\/[^/]+$/.test(new URL(route.request().url()).pathname)) {
					threadReadFailures -= 1;
					return route.abort("failed");
				}
				if (threadReadHolds > 0 && route.request().method() === "GET" && /^\/api\/persistent-agents\/[^/]+\/threads\/[^/]+$/.test(new URL(route.request().url()).pathname)) {
					threadReadHolds -= 1;
					heldThreadReads.push(() => void route.fallback().catch(() => {}));
					return;
				}
				if (heldLists && route.request().method() === "GET" && new URL(route.request().url()).pathname === "/api/persistent-agents") {
					heldLists.push(() => void route.fallback().catch(() => {}));
					return;
				}
				return route.fallback();
			});
			await page.routeWebSocket(/\/ws\?/, (ws) => {
				if (down) {
					void ws.close({ code: 4000, reason: "down" }).catch(() => {});
					return;
				}
				if (socketsOnHold) {
					heldSockets.push(() => connect(ws));
					return;
				}
				connect(ws);
			});
			const connect = (ws: WebSocketRoute) => {
				const upstream = ws.connectToServer();
				const pair = { page: ws, server: upstream };
				live.push(pair);
				ws.onMessage((message) => upstream.send(message));
				// Frames held for a slow replay, passed on in order once the hold ends.
				let held: (() => void)[] | null = null;
				upstream.onMessage((message) => {
					const text = String(message);
					if (text.includes('"type":"ready"')) readies += 1;
					frames += text;
					const pass = () => {
						try {
							ws.send(message);
							if (repeat && /"seq":\d+/.test(text)) ws.send(message);
						} catch {}
					};
					if (held) {
						held.push(pass);
						return;
					}
					if (!(text.includes('"type":"turn_reattach"') && slowReplayMs > 0 && slowReplayWithStart)) pass();
					if (text.includes('"type":"turn_reattach"') && slowReplayMs > 0) {
						reattachedAt = Date.now();
						const queue: (() => void)[] = slowReplayWithStart ? [pass] : [];
						held = queue;
						setTimeout(() => {
							held = null;
							for (const next of queue) next();
						}, slowReplayMs);
					}
				});
				upstream.onClose((code, reason) => ws.close({ code, reason }));
				ws.onClose(() => upstream.close());
			};
			await page.goto(`${baseUrl}/auth/session?token=${SMOKE_AUTH_TOKEN}`);
			await page.waitForLoadState("networkidle");
			const dismiss = page.locator(".whats-new-close");
			if (await dismiss.count()) await dismiss.click();
			await page.locator(".persistent-agent-card").filter({ hasText: room }).getByRole("button", { name: /^(Enter|Resume)$/ }).click();
			await page.locator('button[title="Send"]').first().waitFor({ timeout: 15000 });
			await waitUntil(() => readies > 0, "the room's connection is ready");
			await page.waitForTimeout(500);
			return {
				page,
				readies: () => readies,
				received: (text) => frames.includes(text),
				drop: () => {
					for (const pair of live.splice(0)) {
						void pair.page.close({ code: 4000, reason: "dropped" }).catch(() => {});
						void pair.server.close().catch(() => {});
					}
				},
				setDown: (value) => { down = value; },
				setRepeat: (value) => { repeat = value; },
				setSlowReplay: (ms, withStart = false) => {
					slowReplayMs = ms;
					slowReplayWithStart = withStart;
				},
				holdSockets: (hold) => {
					socketsOnHold = hold;
					if (!hold) for (const next of heldSockets.splice(0)) next();
				},
				socketsHeld: () => heldSockets.length,
				holdNextThreadRead: () => { threadReadHolds += 1; },
				threadReadsHeld: () => heldThreadReads.length,
				releaseThreadRead: () => { for (const next of heldThreadReads.splice(0)) next(); },
				failNextThreadRead: () => { threadReadFailures += 1; },
				failThreadSaves: (fail) => { threadSavesFail = fail; },
				holdRoomList: (hold) => {
					if (hold) heldLists ??= [];
					else {
						const waiting = heldLists ?? [];
						heldLists = null;
						for (const next of waiting) next();
					}
				},
				reattached: () => reattachedAt > 0,
				inject: (frame) => {
					for (const pair of live) pair.page.send(JSON.stringify(frame));
				},
				sendAndClose: (frame) => {
					for (const pair of live.splice(0)) {
						pair.page.send(JSON.stringify(frame));
						void pair.page.close().catch(() => {});
						void pair.server.close().catch(() => {});
					}
				},
			};
		};
		const send = async (page: Page, text: string) => {
			const composer = page.locator("textarea").first();
			await composer.fill(text);
			await composer.press("Enter");
			await waitUntil(async () => (await page.locator(".bubble-row.user").filter({ hasText: text }).count()) > 0, `"${text}" is sent`);
			await waitUntil(() => open !== null, "the gated answer has begun");
		};
		/** The open answer's text as on screen. */
		const answerText = (page: Page) => page.evaluate(() => [...document.querySelectorAll(".messages .assistant-markdown")].map((el) => el.textContent ?? "").filter((text) => text.includes("Line 1:")).pop() ?? "");
		const lineShown = async (page: Page, n: number) => (await answerText(page)).includes(`Line ${n}:`);
		const shownCount = (page: Page, text: string) => page.getByText(text).count();
		/** Every place on the page that says it is reconnecting, as drawn. A string, so the bundler adds no helper names the page does not have. */
		const reconnectingPlaces = (page: Page) => page.evaluate(`[...document.querySelectorAll("body *")].filter((el) => [...el.childNodes].some((node) => node.nodeType === 3 && /Reconnecting/.test(node.textContent || "")) && el.checkVisibility()).map((el) => (el.className || el.tagName) + ": " + (el.textContent || "").trim())`) as Promise<string[]>;

		const drop = await enter("Drop Room");
		const { page } = drop;
		await send(page, `Drop question ${GATED}`);
		release(1);
		await waitUntil(() => lineShown(page, 1), "the answer has begun on screen");
		const received = release(45);
		await waitUntil(() => drop.received(`Line ${received}:`), "the page has received the answer so far");
		await waitUntil(() => lineShown(page, 3), "the reveal is under way");
		drop.setDown(true);
		drop.drop();
		const atDrop = (await answerText(page)).length;
		const allAtDrop = await lineShown(page, received);
		await page.waitForTimeout(600);
		const soonAfter = (await answerText(page)).length;
		await row("at a drop the answer keeps revealing what already arrived, at the reading pace, then pauses", async () => {
			if (allAtDrop) return "everything received was on screen at once at the drop";
			if (soonAfter <= atDrop) return `the reveal stopped at the drop (${atDrop} then ${soonAfter} characters)`;
			// All of it: its last line's words to the end.
			await waitUntil(async () => (await answerText(page)).split("comes and goes.").length - 1 === received, "what arrived before the drop is all on screen", 30_000);
			const reached = (await answerText(page)).length;
			await page.waitForTimeout(1000);
			const later = (await answerText(page)).length;
			return later === reached ? null : `the answer kept changing after what arrived was shown (${reached} then ${later})`;
		});
		await row("nothing is said in the answer while the room reconnects", async () => {
			const said = await shownCount(page, CONNECTION_LOST);
			return said === 0 ? null : `"${CONNECTION_LOST}" shows while the room reconnects`;
		});
		await row("exactly one \"Reconnecting…\" shows, in the working dot's place", async () => {
			const places = await reconnectingPlaces(page);
			if (places.length !== 1) return `it shows in ${places.length} places: ${JSON.stringify(places)}`;
			return (await page.locator(".turn-status-line").filter({ hasText: "Reconnecting…" }).count()) === 1 ? null : `the one place is not the working dot's: ${places[0]}`;
		});
		await row("while it reconnects Stop stays, unavailable, and so does the header's spinner", async () => {
			const stop = page.locator(".stop-btn");
			if ((await stop.count()) === 0) return "Stop is gone";
			if (await stop.first().isEnabled()) return "Stop can be pressed while offline";
			return (await page.locator(".topbar .left > .spinner").count()) === 1 ? null : "the header's spinner is gone";
		});
		// Reconnecting gives up: the page's clock is moved past the time it keeps trying.
		await page.evaluate(() => (window as any).__moveClockOn(10 * 60_000));
		await row("when reconnecting gives up, the answer says the connection was lost", async () => {
			await page.getByText(CONNECTION_LOST).first().waitFor({ timeout: 20_000 });
			if (!(await lineShown(page, received))) return "what arrived is not all on screen";
			return (await page.locator(".turn-status-line").count()) === 0 ? null : "the reconnecting line stays after giving up";
		});
		// More of the answer is written while the page is away; then the network is back, frames come twice, and the person reconnects.
		const written = release(5);
		drop.setDown(false);
		drop.setRepeat(true);
		const readiesBefore = drop.readies();
		await page.getByRole("button", { name: "Reconnect" }).first().click();
		await waitUntil(() => drop.readies() > readiesBefore, "the room reconnects");
		await row("the line is gone once the full answer arrives", async () => {
			await waitUntil(() => lineShown(page, written), "the full answer so far is on screen");
			await page.waitForTimeout(500);
			if ((await shownCount(page, CONNECTION_LOST)) === 0) return null;
			const where = await page.getByText(CONNECTION_LOST).evaluateAll((els) => els.map((el) => `${el.parentElement?.className}/${el.className}`));
			return `the connection-lost line stays under the full answer, in ${JSON.stringify(where)}`;
		});
		const live = release(3);
		await row("a replayed frame that comes twice never shows its text twice", async () => {
			// Read while the answer is still written: its end replaces the text with the model's whole message.
			await waitUntil(() => lineShown(page, live), "the replay and the live lines are on screen");
			await page.waitForTimeout(500);
			const text = await page.locator(".messages").innerText();
			const twice = Array.from({ length: live }, (_, i) => i + 1).filter((n) => text.split(`Line ${n}:`).length - 1 !== 1);
			return twice.length === 0 ? null : `lines shown other than once: ${twice.join(", ")}`;
		});
		modelDone();
		// Settling waits between rows report through the next row, so a run on an older page reaches every row.
		await waitUntil(async () => (await page.locator(".stop-btn").count()) === 0, "the turn has ended").catch(() => {});

		// A short blip: the room reconnects by itself while the answer goes on at the model.
		const blip = await enter("Blip Room");
		await send(blip.page, `Blip question ${GATED}`);
		const before = release(8);
		await waitUntil(async () => (await answerText(blip.page)).split("comes and goes.").length - 1 === before, "the answer so far is all on screen");
		const shownBefore = (await answerText(blip.page)).length;
		blip.setDown(true);
		blip.drop();
		const away = release(40);
		await blip.page.waitForTimeout(1500);
		const readiesBeforeBlip = blip.readies();
		blip.setDown(false);
		await row("after a short blip the text written while away comes at the reading pace, and the answer never jumps back", async () => {
			await waitUntil(() => blip.readies() > readiesBeforeBlip, "the room reconnects by itself", 30_000);
			await waitUntil(() => lineShown(blip.page, before + 1), "the replay has begun");
			const afterReplay = (await answerText(blip.page)).length;
			if (afterReplay < shownBefore) return `the answer went back from ${shownBefore} to ${afterReplay} characters`;
			if (await lineShown(blip.page, away)) return "the text written while away was drawn at once";
			await waitUntil(() => lineShown(blip.page, away), "the rest comes at the pace", 30_000);
			return (await blip.page.getByText("Response interrupted").count()) === 0 ? null : "the answer is called interrupted";
		});
		await row("after a short blip the paragraphs written while away fade in, and the ones the replay drew at once do not", async () => {
			// Read while the answer is still written: a finished answer fades nothing.
			const blocks = await blip.page.evaluate(() => {
				const answer = [...document.querySelectorAll(".messages .assistant-markdown")].filter((el) => (el.textContent ?? "").includes("Line 1:")).pop();
				return [...(answer?.children ?? [])].map((el) => ({ line: Number(/^Line (\d+):/.exec(el.textContent ?? "")?.[1] ?? 0), fade: getComputedStyle(el).animationName }));
			});
			const drawnFading = blocks.filter((b) => b.line >= 1 && b.line <= before && b.fade !== "none").map((b) => b.line);
			const pacedStill = blocks.filter((b) => b.line > before && b.fade === "none").map((b) => b.line);
			if (blocks.length < away) return `only ${blocks.length} paragraphs on screen`;
			if (drawnFading.length) return `paragraphs the replay drew at once fade in: ${drawnFading.join(", ")}`;
			return pacedStill.length === 0 ? null : `paragraphs written while away show without their fade-in: ${pacedStill.join(", ")}`;
		});
		modelDone();
		await waitUntil(async () => (await blip.page.locator(".stop-btn").count()) === 0, "the blip room's turn has ended").catch(() => {});

		// A slow link: the replay's frames come well over a second after its start.
		const slow = await enter("Slow Room");
		await send(slow.page, `Slow question ${GATED}`);
		const slowBefore = release(8);
		await waitUntil(async () => (await answerText(slow.page)).split("comes and goes.").length - 1 === slowBefore, "the answer so far is all on screen");
		await slow.page.evaluate(`(() => {
			const answerLength = () => [...document.querySelectorAll(".messages .assistant-markdown")].map((el) => el.textContent || "").filter((text) => text.includes("Line 1:")).reduce((most, text) => Math.max(most, text.length), 0);
			window.__answerBefore = answerLength();
			window.__answerShortest = window.__answerBefore;
			new MutationObserver(() => { window.__answerShortest = Math.min(window.__answerShortest, answerLength()); }).observe(document.querySelector(".messages"), { childList: true, subtree: true, characterData: true });
		})()`);
		slow.setDown(true);
		slow.drop();
		const slowAway = release(6);
		await slow.page.waitForTimeout(1500);
		slow.setSlowReplay(2500);
		slow.setDown(false);
		await row("a replay slower than a second never takes the answer off the screen", async () => {
			await waitUntil(() => lineShown(slow.page, slowAway), "the replay and the rest are on screen", 40_000);
			const { before: had, shortest } = await slow.page.evaluate(() => ({ before: (window as any).__answerBefore as number, shortest: (window as any).__answerShortest as number }));
			return shortest >= had ? null : `the answer went from ${had} to ${shortest} characters on screen while the replay was on its way`;
		});
		modelDone();
		await waitUntil(async () => (await slow.page.locator(".stop-btn").count()) === 0, "the slow room's turn has ended").catch(() => {});
		await slow.page.context().close();

		// The saved copy is older than the screen (the page's last saves did not reach the server) when the link drops.
		const older = await enter("Older Copy Room");
		await send(older.page, `Older copy question ${GATED}`);
		const savedPart = release(4);
		await waitUntil(async () => (await answerText(older.page)).split("comes and goes.").length - 1 === savedPart, "the first part is all on screen");
		// The page's save of the first part has reached the server.
		const savedLines = async () => {
			const status = await (await authedFetch(`${baseUrl}/api/persistent-agents/${rooms["Older Copy Room"]}/status`)).json().catch(() => null);
			const threadId = status?.activeThread?.threadId;
			if (!threadId) return 0;
			const thread = await (await authedFetch(`${baseUrl}/api/persistent-agents/${rooms["Older Copy Room"]}/threads/${encodeURIComponent(threadId)}`)).json().catch(() => null);
			return JSON.stringify(thread?.thread?.items ?? []).split("comes and goes.").length - 1;
		};
		await waitUntil(async () => (await savedLines()) >= savedPart, "the saved copy holds the first part");
		older.failThreadSaves(true);
		const olderShown = release(8);
		await waitUntil(async () => (await answerText(older.page)).split("comes and goes.").length - 1 === olderShown, "the rest so far is all on screen");
		await older.page.evaluate(`(() => {
			const answerLength = () => [...document.querySelectorAll(".messages .assistant-markdown")].map((el) => el.textContent || "").filter((text) => text.includes("Line 1:")).reduce((most, text) => Math.max(most, text.length), 0);
			window.__answerBefore = answerLength();
			window.__answerShortest = window.__answerBefore;
			new MutationObserver(() => { window.__answerShortest = Math.min(window.__answerShortest, answerLength()); }).observe(document.querySelector(".messages"), { childList: true, subtree: true, characterData: true });
		})()`);
		older.setDown(true);
		older.drop();
		const olderAway = release(2);
		await older.page.waitForTimeout(1500);
		older.failThreadSaves(false);
		older.setSlowReplay(2500);
		older.setDown(false);
		await row("a reconnect whose saved copy is older than the screen keeps the answer shown until its replay comes", async () => {
			await waitUntil(() => lineShown(older.page, olderAway), "the replay and the rest are on screen", 40_000);
			const { before: had, shortest } = await older.page.evaluate(() => ({ before: (window as any).__answerBefore as number, shortest: (window as any).__answerShortest as number }));
			return shortest >= had ? null : `the answer went from ${had} to ${shortest} characters on screen before its replay came`;
		});
		modelDone();
		await waitUntil(async () => (await older.page.locator(".stop-btn").count()) === 0, "the older copy room's turn has ended").catch(() => {});
		await older.page.context().close();

		// The connection drops again while a replay is on its way: the half that came is never drawn, the next connection's replay is.
		const cut = await enter("Cut Room");
		await send(cut.page, `Cut question ${GATED}`);
		const cutBefore = release(8);
		await waitUntil(async () => (await answerText(cut.page)).split("comes and goes.").length - 1 === cutBefore, "the cut room's answer so far is all on screen");
		await cut.page.evaluate(`(() => {
			const answerLength = () => [...document.querySelectorAll(".messages .assistant-markdown")].map((el) => el.textContent || "").filter((text) => text.includes("Line 1:")).reduce((most, text) => Math.max(most, text.length), 0);
			window.__answerBefore = answerLength();
			window.__answerShortest = window.__answerBefore;
			new MutationObserver(() => { window.__answerShortest = Math.min(window.__answerShortest, answerLength()); }).observe(document.querySelector(".messages"), { childList: true, subtree: true, characterData: true });
		})()`);
		cut.setDown(true);
		cut.drop();
		release(4);
		await cut.page.waitForTimeout(1500);
		cut.setSlowReplay(4000);
		cut.setDown(false);
		await row("a replay cut off by another drop never takes the answer off the screen", async () => {
			await waitUntil(() => cut.reattached(), "the cut room's replay has begun", 30_000);
			cut.setDown(true);
			cut.drop();
			await cut.page.waitForTimeout(1500);
			cut.setSlowReplay(0);
			cut.setDown(false);
			const cutAll = release(2);
			await waitUntil(() => lineShown(cut.page, cutAll), "the next replay and the rest are on screen", 40_000);
			const { before: had, shortest } = await cut.page.evaluate(() => ({ before: (window as any).__answerBefore as number, shortest: (window as any).__answerShortest as number }));
			return shortest >= had ? null : `the answer went from ${had} to ${shortest} characters on screen when the replay was cut off`;
		});
		modelDone();
		await waitUntil(async () => (await cut.page.locator(".stop-btn").count()) === 0, "the cut room's turn has ended").catch(() => {});
		await cut.page.context().close();

		// A replay still on its way when the person goes to another room belongs to the room they left.
		const moving = await enter("Home Room");
		const mp = moving.page;
		await mp.locator("textarea").first().fill("A plain question.");
		await mp.locator("textarea").first().press("Enter");
		await mp.locator(".messages .assistant-markdown").filter({ hasText: "OK." }).first().waitFor({ timeout: 25_000 });
		await waitUntil(async () => (await mp.locator(".stop-btn").count()) === 0, "the plain answer's turn has ended");
		await mp.waitForTimeout(1500);
		const toRooms = async () => {
			const back = mp.getByRole("button", { name: "Back to rooms" });
			if (await back.count()) await back.first().click();
			else await mp.getByText("Home", { exact: true }).first().click();
			await mp.locator(".persistent-agent-card").first().waitFor({ timeout: 15_000 });
		};
		const openCard = async (room: string, button: RegExp) => {
			await mp.locator(".persistent-agent-card").filter({ hasText: room }).getByRole("button", { name: button }).click();
			await mp.locator("textarea").first().waitFor({ timeout: 15_000 });
		};
		await toRooms();
		const readiesBeforeAway = moving.readies();
		await openCard("Away Room", /^Enter$/);
		await waitUntil(() => moving.readies() > readiesBeforeAway, "the away room's connection is ready");
		await mp.waitForTimeout(500);
		await send(mp, `Away question ${GATED}`);
		const awayShown = release(3);
		await waitUntil(() => lineShown(mp, awayShown), "the away room's answer is on screen");
		moving.setDown(true);
		moving.drop();
		release(2);
		await mp.waitForTimeout(1500);
		moving.setSlowReplay(4000);
		moving.setDown(false);
		await row("a replay still on its way when the person opens another room leaves that room's conversation alone", async () => {
			await waitUntil(() => moving.reattached(), "the away room's replay has begun", 30_000);
			await toRooms();
			await openCard("Home Room", /^Resume$/);
			// Past the end of the away room's held replay, so frames it would have brought have had their time.
			await mp.waitForTimeout(6000);
			if ((await mp.locator(".messages .assistant-markdown").filter({ hasText: "OK." }).count()) === 0) return "the other room's answer is gone from the screen";
			const status = await (await authedFetch(`${baseUrl}/api/persistent-agents/${rooms["Home Room"]}/status`)).json();
			const threadId = String(status?.activeThread?.threadId ?? "");
			const thread = await (await authedFetch(`${baseUrl}/api/persistent-agents/${rooms["Home Room"]}/threads/${encodeURIComponent(threadId)}`)).json();
			const items: { kind?: string; text?: string }[] = thread?.thread?.items ?? thread?.items ?? [];
			return items.some((item) => item.kind === "assistant" && item.text === "OK.") ? null : `the other room's saved conversation lost its answer: ${JSON.stringify(items.map((item) => item.kind))}`;
		});
		modelDone();
		await mp.context().close();

		// The turn ends while its replay is still on its way, and the room's status, asked at the reconnect, comes back after that end.
		const late = await enter("Late Room");
		await send(late.page, `Late question ${GATED}`);
		late.setDown(true);
		late.drop();
		await late.page.waitForTimeout(1500);
		late.setSlowReplay(6000);
		late.holdRoomList(true);
		late.setDown(false);
		await row("a turn that ends while its replay is on its way gets no connection-lost line", async () => {
			await waitUntil(() => late.reattached(), "the late room's replay has begun", 30_000);
			const lateShown = release(3);
			modelDone();
			await waitUntil(async () => (await (await authedFetch(`${baseUrl}/api/persistent-agents/${rooms["Late Room"]}/status`)).json())?.activeThread?.inFlight === false, "the server has settled the turn");
			late.holdRoomList(false);
			await waitUntil(() => lineShown(late.page, lateShown), "the whole answer is on screen", 30_000);
			await waitUntil(async () => (await late.page.locator(".stop-btn").count()) === 0, "the late room's turn has ended");
			return (await shownCount(late.page, CONNECTION_LOST)) === 0 ? null : "the finished answer says the connection was lost";
		});
		await late.page.context().close();

		// The same, with the replay's first frame late too: the status comes back before the page knows a replay is coming.
		const later = await enter("Later Room");
		await send(later.page, `Later question ${GATED}`);
		later.setDown(true);
		later.drop();
		await later.page.waitForTimeout(1500);
		later.setSlowReplay(6000, true);
		later.holdRoomList(true);
		later.setDown(false);
		await row("a turn that ends before its replay's first frame arrives gets no connection-lost line", async () => {
			await waitUntil(() => later.reattached(), "the later room's replay has been sent", 30_000);
			const laterShown = release(3);
			modelDone();
			await waitUntil(async () => (await (await authedFetch(`${baseUrl}/api/persistent-agents/${rooms["Later Room"]}/status`)).json())?.activeThread?.inFlight === false, "the server has settled the turn");
			later.holdRoomList(false);
			await waitUntil(() => lineShown(later.page, laterShown), "the whole answer is on screen", 30_000);
			await waitUntil(async () => (await later.page.locator(".stop-btn").count()) === 0, "the later room's turn has ended");
			return (await shownCount(later.page, CONNECTION_LOST)) === 0 ? null : "the finished answer says the connection was lost";
		});
		await later.page.context().close();

		// The turn lands after the reconnect read the conversation and before the new connection binds: no replay comes, the landing is the answer.
		const landed = await enter("Landed Room");
		await send(landed.page, `Landed question ${GATED}`);
		const landedShown = release(2);
		await waitUntil(() => lineShown(landed.page, landedShown), "the landed room's answer is on screen");
		landed.setDown(true);
		landed.drop();
		const landedAll = release(4);
		await landed.page.waitForTimeout(1500);
		landed.holdSockets(true);
		landed.setDown(false);
		await row("a turn that lands while the page reconnects shows its whole answer, finished", async () => {
			await waitUntil(() => landed.socketsHeld() > 0, "the landed room's new connection waits", 30_000);
			modelDone();
			await waitUntil(async () => (await (await authedFetch(`${baseUrl}/api/persistent-agents/${rooms["Landed Room"]}/status`)).json())?.activeThread?.inFlight === false, "the server has settled the turn");
			landed.holdSockets(false);
			await waitUntil(async () => (await landed.page.locator(".stop-btn").count()) === 0, "the landed room's turn has ended", 30_000);
			await landed.page.waitForTimeout(1500);
			if ((await shownCount(landed.page, CONNECTION_LOST)) > 0) return "the landed answer says the connection was lost";
			return (await lineShown(landed.page, landedAll)) ? null : `the answer on screen stops before line ${landedAll}, though the whole answer landed`;
		});
		await landed.page.context().close();

		// The replay's first frame comes late after the turn has ended: what the reader never saw still comes at the reading pace.
		const paced = await enter("Paced Room");
		await send(paced.page, `Paced question ${GATED}`);
		const pacedShown = release(2);
		await waitUntil(() => lineShown(paced.page, pacedShown), "the paced room's answer is on screen");
		paced.setDown(true);
		paced.drop();
		const pacedAll = release(40);
		await paced.page.waitForTimeout(1500);
		paced.setSlowReplay(5000, true);
		// The rooms' status, asked at the reconnect, comes back only after the turn has ended.
		paced.holdRoomList(true);
		paced.setDown(false);
		await row("a replay that comes late after its turn ended still shows the unseen text at the reading pace", async () => {
			await waitUntil(() => paced.reattached(), "the paced room's replay has been sent", 30_000);
			modelDone();
			await waitUntil(async () => (await (await authedFetch(`${baseUrl}/api/persistent-agents/${rooms["Paced Room"]}/status`)).json())?.activeThread?.inFlight === false, "the server has settled the turn");
			paced.holdRoomList(false);
			await waitUntil(() => lineShown(paced.page, pacedShown + 1), "the replay's text has begun on screen", 30_000);
			const allAtOnce = await lineShown(paced.page, pacedAll);
			await waitUntil(() => lineShown(paced.page, pacedAll), "the whole answer is on screen", 60_000);
			if ((await shownCount(paced.page, CONNECTION_LOST)) > 0) return "the finished answer says the connection was lost";
			return allAtOnce ? `the ${pacedAll - pacedShown} unseen lines appeared at once` : null;
		});
		await paced.page.context().close();

		// The one conversation read after a reconnect with no replay fails once: that says nothing about the turn, so it is read again.
		const retryRead = await enter("Retry Read Room");
		await send(retryRead.page, `Retry read question ${GATED}`);
		const retryReadShown = release(2);
		await waitUntil(() => lineShown(retryRead.page, retryReadShown), "the retry read room's answer is on screen");
		retryRead.setDown(true);
		retryRead.drop();
		const retryReadAll = release(4);
		await retryRead.page.waitForTimeout(1500);
		retryRead.holdSockets(true);
		retryRead.setDown(false);
		await row("a failed read after a reconnect is tried again, and the landed answer shows whole", async () => {
			await waitUntil(() => retryRead.socketsHeld() > 0, "the retry read room's new connection waits", 30_000);
			modelDone();
			await waitUntil(async () => (await (await authedFetch(`${baseUrl}/api/persistent-agents/${rooms["Retry Read Room"]}/status`)).json())?.activeThread?.inFlight === false, "the server has settled the turn");
			retryRead.failNextThreadRead();
			retryRead.holdSockets(false);
			await waitUntil(async () => (await lineShown(retryRead.page, retryReadAll)) || (await shownCount(retryRead.page, CONNECTION_LOST)) > 0, "the answer is whole or called lost", 30_000);
			if ((await shownCount(retryRead.page, CONNECTION_LOST)) > 0) return "one failed read made the landed answer say the connection was lost";
			await waitUntil(async () => (await retryRead.page.locator(".stop-btn").count()) === 0, "the retry read room's turn has ended", 30_000);
			return null;
		});
		await retryRead.page.context().close();

		// Reconnecting gives up before any text has come (the answer still thinking): the line stands alone, then the answer comes back whole.
		const givesUpThinking = async (room: string) => {
			const thinking = await enter(room);
			await send(thinking.page, `${room} question ${GATED}`);
			await thinking.page.waitForTimeout(500);
			thinking.setDown(true);
			thinking.drop();
			await thinking.page.evaluate(() => (window as any).__moveClockOn(10 * 60_000));
			await thinking.page.getByText(CONNECTION_LOST).first().waitFor({ timeout: 20_000 });
			return thinking;
		};
		const think = await givesUpThinking("Think Room");
		await row("gave up while it thought, the answer landed meanwhile: after Reconnect the line is gone beside the whole answer", async () => {
			const all = release(3);
			modelDone();
			await waitUntil(async () => (await (await authedFetch(`${baseUrl}/api/persistent-agents/${rooms["Think Room"]}/status`)).json())?.activeThread?.inFlight === false, "the server has settled the turn");
			think.setDown(false);
			await think.page.getByRole("button", { name: "Reconnect" }).first().click();
			await waitUntil(() => lineShown(think.page, all), "the whole answer is on screen", 30_000);
			await think.page.waitForTimeout(800);
			return (await shownCount(think.page, CONNECTION_LOST)) === 0 ? null : "the connection-lost line stays beside the whole answer";
		});
		await think.page.context().close();
		const thinkReplay = await givesUpThinking("Think Replay Room");
		await row("gave up while it thought, the answer still being written: after Reconnect its replay ends whole, and the line is gone", async () => {
			release(2);
			thinkReplay.setDown(false);
			const readiesBefore = thinkReplay.readies();
			await thinkReplay.page.getByRole("button", { name: "Reconnect" }).first().click();
			await waitUntil(() => thinkReplay.readies() > readiesBefore, "the room reconnects");
			const all = release(2);
			modelDone();
			await waitUntil(() => lineShown(thinkReplay.page, all), "the whole answer is on screen", 30_000);
			await waitUntil(async () => (await thinkReplay.page.locator(".stop-btn").count()) === 0, "the turn has ended on the page", 30_000);
			await thinkReplay.page.waitForTimeout(800);
			return (await shownCount(thinkReplay.page, CONNECTION_LOST)) === 0 ? null : "the connection-lost line stays beside the whole answer";
		});
		await thinkReplay.page.context().close();

		// A check begun after one reconnect belongs to that wait: it never ends a later answer's wait.
		const gen = await enter("Gen Room");
		await send(gen.page, `Gen question ${GATED}`);
		const genShown = release(2);
		await waitUntil(() => lineShown(gen.page, genShown), "the gen room's answer is on screen");
		gen.setDown(true);
		gen.drop();
		release(2);
		await gen.page.waitForTimeout(1500);
		gen.holdSockets(true);
		gen.setDown(false);
		await row("a check from an earlier reconnect never cuts off a later answer", async () => {
			await waitUntil(() => gen.socketsHeld() > 0, "the page's new connection waits", 30_000);
			modelDone();
			await waitUntil(async () => (await (await authedFetch(`${baseUrl}/api/persistent-agents/${rooms["Gen Room"]}/status`)).json())?.activeThread?.inFlight === false, "the server has settled the first turn");
			gen.holdNextThreadRead();
			gen.holdSockets(false);
			await waitUntil(() => gen.threadReadsHeld() > 0, "the first reconnect's check is reading the conversation", 30_000);
			gen.setDown(true);
			gen.drop();
			await gen.page.waitForTimeout(1500);
			gen.setDown(false);
			await waitUntil(async () => (await gen.page.locator(".stop-btn").count()) === 0, "the landed answer is in and the room takes a message", 30_000);
			await send(gen.page, `Gen second question ${GATED}`);
			const secondShown = release(1);
			await waitUntil(async () => (await gen.page.getByText(`Line ${secondShown}:`).count()) > 1, "the second answer has begun on screen");
			gen.setDown(true);
			gen.drop();
			await gen.page.waitForTimeout(1500);
			gen.releaseThreadRead();
			await gen.page.waitForTimeout(2000);
			const lost = await shownCount(gen.page, CONNECTION_LOST);
			const stop = await gen.page.locator(".stop-btn").count();
			if (lost > 0) return "the later answer says the connection was lost";
			return stop > 0 ? null : "the later answer's turn was ended while its connection was still coming back";
		});
		gen.setDown(false);
		modelDone();
		await waitUntil(async () => (await gen.page.locator(".stop-btn").count()) === 0, "the gen room's turn has ended").catch(() => {});
		await gen.page.context().close();

		// Stop pressed in another window while the runtime waited to try again: the turn ends on a cut-short retry end, which names Stop.
		const retry = await enter("Retry Room");
		await send(retry.page, `Retry question ${GATED}`);
		const retryShown = release(2);
		await waitUntil(() => lineShown(retry.page, retryShown), "the retry room's answer is on screen");
		retry.inject({ type: "event", event: { type: "auto_retry_end", success: false, attempt: 1, endedBy: "stop" }, seq: 100_000 });
		await row("a turn Stop ended during a retry wait, seen from another window, says \"You stopped this answer.\"", async () => {
			await retry.page.locator(".answer-stop-line").filter({ hasText: "You stopped this answer." }).first().waitFor({ timeout: 10_000 }).catch(() => {});
			return (await retry.page.locator(".answer-stop-line").filter({ hasText: "You stopped this answer." }).count()) > 0 ? null : "the answer ends with no Stop line";
		});
		modelDone();
		await retry.page.context().close();

		// On a phone the composer's footer stays one row while the room reconnects: the context ring shows only its percentage, as on every width.
		const phone = await enter("Phone Room");
		await send(phone.page, `Phone first question ${GATED}`);
		release(1);
		modelDone();
		await waitUntil(async () => (await phone.page.locator(".stop-btn").count()) === 0, "the phone room's first turn has ended");
		await send(phone.page, `Phone question ${GATED}`);
		const phoneShown = release(2);
		await waitUntil(() => lineShown(phone.page, phoneShown), "the phone room's answer is on screen");
		const pillText = () => phone.page.locator(".composer-context-pill-label").first().evaluate((el) => (el as HTMLElement).innerText.trim());
		phone.setDown(true);
		phone.drop();
		await row("the context ring shows only its percentage while the room reconnects, on a desktop and on a phone", async () => {
			await waitUntil(async () => (await reconnectingPlaces(phone.page)).length > 0, "the phone room is reconnecting", 15_000);
			const desktop = await pillText();
			if (!/^\d+%$/.test(desktop)) return `on a desktop the reconnecting pill reads "${desktop}"`;
			await phone.page.setViewportSize({ width: 390, height: 844 });
			await phone.page.waitForTimeout(300);
			const onPhone = await pillText();
			return /^\d+%$/.test(onPhone) ? null : `on a phone the reconnecting pill reads "${onPhone}", so the footer breaks into two rows`;
		});
		const pillZone = () => phone.page.locator(".composer-context-pill").first().evaluate((el) => el.className);
		await row("while the room reconnects the context pill's dot is the offline red, as on main, and it is back once the room is", async () => {
			const down = await pillZone();
			phone.setDown(false);
			modelDone();
			await waitUntil(async () => (await phone.page.locator(".stop-btn").count()) === 0, "the phone room's turn has ended", 40_000);
			// The room is back once its new connection is ready, which can come after the turn has ended: wait for that, not for Stop to go.
			const back = await waitUntil(async () => !/\boffline\b/.test(await pillZone()), "the phone room's pill is back", 30_000).then(() => true, () => false);
			if (!/\boffline\b/.test(down)) return `while reconnecting the pill is "${down}", so its dot says the room is fine`;
			return back ? null : `once the room is back the pill is still "${await pillZone()}"`;
		});
		phone.setDown(false);
		await phone.page.context().close();

		// Stop pressed here: the line is the answer's own, under its text and above its copy button, as a saved stopped answer shows it.
		const stopped = await enter("Stop Room");
		await send(stopped.page, `Stop question ${GATED}`);
		// The answer quotes the stop line in its own words: that is not the line, and the line still comes.
		sayInOpenAnswer("The page says \"You stopped this answer.\" when you press Stop.\n\n");
		const stoppedShown = release(3);
		await waitUntil(() => lineShown(stopped.page, stoppedShown), "the stop room's answer is on screen");
		await stopped.page.locator(".stop-btn").first().click();
		// Stop cancels the model's request on the server: its stream closes there, and nothing more is sent on it.
		await waitUntil(() => openAnswerClosedByServer(), "the server has cancelled the model's answer", 15_000);
		forgetOpenAnswer();
		await row("after Stop the stop line sits in the answer, under its text and above its copy button", async () => {
			const shown = await stopped.page.locator(".answer-stop-line").filter({ hasText: "You stopped this answer." }).first().waitFor({ timeout: 10_000 }).then(() => true, () => false);
			if (!shown) return "the stopped answer shows no stop line";
			const where = await stopped.page.evaluate(`(() => {
				const line = [...document.querySelectorAll(".answer-stop-line")].find((el) => (el.textContent || "").includes("You stopped this answer."));
				const row = line && line.closest(".bubble-row");
				const answer = row && [...row.querySelectorAll(".assistant-markdown")].find((el) => (el.textContent || "").includes("Line 1:"));
				const copy = row && row.querySelector(".message-actions.assistant button");
				if (!answer) return "on a row of its own, apart from the answer";
				if (!copy) return "in an answer with no copy button";
				if (answer.getBoundingClientRect().bottom > line.getBoundingClientRect().top) return "above the end of the answer's text";
				if (line.getBoundingClientRect().bottom > copy.getBoundingClientRect().top) return "under the answer's copy button";
				return "";
			})()`) as string;
			return where ? `the stop line sits ${where}` : null;
		});
		await stopped.page.context().close();

		// Another window takes the room mid-answer: the server tells this one with the frame it sends then.
		const first = await enter("Window Room");
		await send(first.page, `Window question ${GATED}`);
		release(2);
		await waitUntil(() => lineShown(first.page, 2), "the answer is on screen in the first window");
		first.sendAndClose({ type: "error", code: "room_displaced", message: "This room is now open in another window." });
		await row("a window another took the room from keeps what it showed, offers no Stop, and says where the room is", async () => {
			await first.page.getByText("This room is now open in another window.").first().waitFor({ timeout: 15_000 });
			if (!(await lineShown(first.page, 2))) return "the answer it showed is gone";
			if ((await shownCount(first.page, CONNECTION_LOST)) > 0 || (await first.page.getByText("Response interrupted").count()) > 0) return "the answer is called interrupted";
			if ((await first.page.locator(".stop-btn").count()) > 0) return "Stop shows in the window that lost the room";
			const places = await reconnectingPlaces(first.page);
			return places.length === 0 ? null : `it says it is reconnecting: ${JSON.stringify(places)}`;
		});
		await row("Open here takes the room back", async () => {
			const before = first.readies();
			await first.page.getByRole("button", { name: "Open here" }).click();
			await waitUntil(() => first.readies() > before, "the first window's room connection is ready again");
			if ((await first.page.getByText("This room is now open in another window.").count()) > 0) return "the line stays after Open here";
			const back = release(1);
			await waitUntil(() => lineShown(first.page, back), "the answer goes on in the window that took the room back");
			return (await first.page.locator(".stop-btn").count()) === 1 ? null : "no Stop in the window that took the room back";
		});
		modelDone();
		await waitUntil(async () => (await first.page.locator(".stop-btn").count()) === 0, "the window room's turn has ended").catch(() => {});
		await first.page.context().close();

		// The server dies mid-answer (no stop runs, as in a crash) and comes back: the turn died with it.
		const crash = await enter("Crash Room");
		await send(crash.page, `Crash question ${GATED}`);
		const crashed = release(3);
		await waitUntil(async () => (await answerText(crash.page)).split("comes and goes.").length - 1 === crashed, "the answer so far is all on screen");
		await killSmokeServer(server);
		cutOpenAnswer();
		await crash.page.waitForTimeout(1500);
		const readiesBeforeCrash = crash.readies();
		await startServer();
		await row("an answer the server lost while the page reconnected says the connection was lost", async () => {
			await waitUntil(() => crash.readies() > readiesBeforeCrash, "the room reconnects to the restarted server", 60_000);
			await crash.page.getByText(CONNECTION_LOST).first().waitFor({ timeout: 15_000 }).catch(() => {});
			if ((await shownCount(crash.page, CONNECTION_LOST)) === 0) return "the half-written answer ends with no line, so it looks finished";
			if (!(await lineShown(crash.page, crashed))) return "the answer it had is gone";
			return (await crash.page.locator(".turn-status-line").count()) === 0 && (await crash.page.locator(".stop-btn").count()) === 0 ? null : "the room still waits on the lost turn";
		});
	} finally {
		await browser.close();
	}
	if (failures.length) throw new Error(`chat-reconnect smoke: ${failures.length} row(s) failed: ${failures.join("; ")}`);
	console.log("chat-reconnect smoke: ok");
} catch (error) {
	console.error(serverOutput.join("").slice(-6000));
	throw error;
} finally {
	try { (endpoint as any).closeAllConnections?.(); } catch {}
	try { endpoint.close(); } catch {}
	await stopSmokeServer(server);
	fs.rmSync(tempRoot, { recursive: true, force: true });
}
