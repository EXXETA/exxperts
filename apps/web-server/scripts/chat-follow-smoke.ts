// Following an answer as it is written, in the browser against a real spawned
// server and one synthetic Anthropic endpoint whose answer the smoke releases
// part by part, so each scroll happens at a known point of the answer:
//
// - after Send the message glides to the top and the view stays still while
//   the answer grows below it, with the ↓ pill; scrolling down to the end
//   attaches it;
// - scrolling back down to within 24 px of the end follows again, without
//   having to hit the last pixel, and so does dragging the scroll bar there;
// - a wheel up that reaches the top stops following, and the tail of a
//   gesture up (a move down within 300 ms of it) does not follow again;
// - a wheel up on a chat that cannot scroll up yet keeps following, so the
//   answer never grows out of sight;
// - the moment the model is done, Send and Remember work while the answer's
//   last words are still appearing; Send first puts the rest on screen, then
//   glides the new message to the top;
// - each new block fades in while the answer is written; a finished answer,
//   a reconnect's replay and reduced motion show no fade;
// - the row under the box lines up: the meter, Remember's two halves, the
//   model and the command mode share one height, top and text baseline;
// - a reconnect's replay paints in one go: the answer is never shorter on
//   screen than it was before the drop.
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
import { authedFetch, SMOKE_AUTH_TOKEN, SMOKE_SERVER_AUTH_ENV, SMOKE_SERVER_SPAWN_TREE_OPTIONS, smokeHomeEnv, stopSmokeServer, freePort } from "./smoke-server-process.js";
import { waitForTurnSettled } from "./smoke-turn-settle.js";

function assert(condition: unknown, message: string): asserts condition {
	if (!condition) throw new Error(message);
}

{
	const p = typeof chromium?.executablePath === "function" ? chromium.executablePath() : "";
	if (!p || !fs.existsSync(p)) {
		console.log("chat follow smoke skipped (Chromium not installed)");
		process.exit(0);
	}
}

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const webServerDir = path.resolve(scriptDir, "..");
const repoRoot = path.resolve(webServerDir, "..", "..");
const port = await freePort();
const baseUrl = `http://127.0.0.1:${port}`;

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "exxperts-chat-follow-"));
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
const line = (n: number) => `Line ${n}: the answer keeps growing, so the view has to follow it down the page.\n\n`;

function sse(res: http.ServerResponse, event: string, payload: unknown): void {
	res.write(`event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`);
}

// The open gated answer: the smoke sends its parts with pump() and ends it with finish().
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
	const ROOMS = ["Stay Room", "Catch Room", "Reopen Room", "Done Room", "Fade Room", "Calm Room", "Drop Room", "Long Room"] as const;
	const rooms = Object.fromEntries(ROOMS.map((displayName) => [displayName, agents.createPersistentAgentFromScaffoldInput({ displayName, userName: "Synthetic User", preferredUserAddress: "Synthetic User" }).agent.agentId]));
	server = spawn("npx", ["tsx", "src/index.ts"], {
		shell: process.platform === "win32",
		...SMOKE_SERVER_SPAWN_TREE_OPTIONS,
		cwd: webServerDir,
		env: smokeHomeEnv(tempHome, { PORT: String(port), ...SMOKE_SERVER_AUTH_ENV, EXXETA_HOME: repoRoot, EXXPERTS_CODING_AGENT_DIR: agentDir, EXXETA_PERSISTENT_AGENTS_ROOT: agentsRoot }) as NodeJS.ProcessEnv,
	});
	server.stdout.on("data", (chunk) => serverOutput.push(String(chunk)));
	server.stderr.on("data", (chunk) => serverOutput.push(String(chunk)));
	await waitUntil(() => fetch(`${baseUrl}/healthz`).then((r) => r.ok).catch(() => false), "server ready", 60_000);
	const approved = await authedFetch(`${baseUrl}/api/persistent-agent-ai-profiles/custom`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ providerId: KEY_PROVIDER, label: "Claude API key", roomModels: [ON_KEY.model], learnModel: ON_KEY.model }) });
	assert(approved.ok, `the key's model is approved, got ${approved.status}`);
	for (const agentId of Object.values(rooms)) {
		const picked = await authedFetch(`${baseUrl}/api/persistent-agents/${agentId}/models`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ conversation: ON_KEY }) });
		assert(picked.ok, `the room picks the key's model, got ${picked.status}`);
	}

	const browser = await chromium.launch();
	try {
		/** A page in one room, with its room connection's ready frames counted and a way to drop that connection. */
		interface RoomPage { page: Page; readies: () => number; drop: () => void }
		// Which room each page is in, so a row waits for that room to settle its turn.
		const roomOf = new Map<Page, string>();
		const enter = async (room: string, options: { reducedMotion?: boolean } = {}): Promise<RoomPage> => {
			const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, reducedMotion: options.reducedMotion ? "reduce" : "no-preference" });
			// Every block put into an answer, with whether it was fading in as it landed.
			// Also the blocks of an answer put in whole, inside an inserted subtree.
			// A string, so the bundler adds no helper names the page does not have.
			await context.addInitScript(`(() => {
				const blocks = [];
				window.__answerBlocks = blocks;
				new MutationObserver((records) => {
					for (const record of records) {
						for (const node of record.addedNodes) {
							if (!(node instanceof Element)) continue;
							const found = record.target instanceof Element && record.target.classList.contains("assistant-markdown") ? [node] : [...(node.matches(".assistant-markdown") ? node.children : node.querySelectorAll(".assistant-markdown > *"))];
							for (const block of found) blocks.push({ block, fades: block.getAnimations().some((a) => a.animationName === "answer-block-in"), at: performance.now() });
						}
					}
				}).observe(document, { childList: true, subtree: true });
			})()`);
			const page = await context.newPage();
			roomOf.set(page, rooms[room]);
			let readies = 0;
			const live: { page: WebSocketRoute; server: WebSocketRoute }[] = [];
			await page.routeWebSocket(/\/ws\?/, (ws) => {
				const upstream = ws.connectToServer();
				const pair = { page: ws, server: upstream };
				live.push(pair);
				ws.onMessage((message) => upstream.send(message));
				upstream.onMessage((message) => {
					if (String(message).includes('"type":"ready"')) readies += 1;
					ws.send(message);
				});
				upstream.onClose((code, reason) => ws.close({ code, reason }));
				ws.onClose(() => upstream.close());
			});
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
				// The network drops: the page sees its socket close, the server sees its own close.
				drop: () => {
					for (const pair of live.splice(0)) {
						void pair.page.close({ code: 4000, reason: "dropped" }).catch(() => {});
						void pair.server.close().catch(() => {});
					}
				},
			};
		};
		const distance = (page: Page) => page.locator(".messages").evaluate((el) => el.scrollHeight - el.scrollTop - el.clientHeight);
		const scrollTop = (page: Page) => page.locator(".messages").evaluate((el) => el.scrollTop);
		const send = async (page: Page, text: string) => {
			const composer = page.locator("textarea").first();
			await composer.fill(text);
			await composer.press("Enter");
			await waitUntil(async () => (await page.locator(".bubble-row.user").filter({ hasText: text }).count()) > 0, `"${text}" is sent`);
			await waitUntil(() => open !== null, "the gated answer has begun");
		};
		/** Sends the next parts of the open answer, without waiting for them to show. */
		const release = (parts: number) => {
			const answer = open!;
			for (let i = 0; i < parts; i++) {
				answer.sent += 1;
				sse(answer.res, "content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: line(answer.sent) } });
			}
			return answer.sent;
		};
		const lineShown = (page: Page, n: number) => page.locator(".messages .assistant-markdown").filter({ hasText: `Line ${n}:` }).count().then((count) => count > 0);
		/** Sends the next parts and waits until the last is on screen and the view has caught up with it. */
		const pump = async (page: Page, parts: number) => {
			const last = release(parts);
			// Long enough for a slow reveal, so a row fails on what it checks, not on the pace.
			await waitUntil(() => lineShown(page, last), `line ${last} is on screen`, 90_000);
			await page.waitForTimeout(250);
		};
		/** Ends the open answer at the model. */
		const modelDone = () => {
			end(open!.res);
			open = null;
		};
		const finish = async (page: Page) => {
			modelDone();
			await waitUntil(async () => (await page.locator(".stop-btn").count()) === 0, "the turn has ended");
			const requestJson = async (pathname: string) => {
				const res = await authedFetch(`${baseUrl}${pathname}`);
				return { status: res.status, body: await res.json().catch(() => null) };
			};
			await waitForTurnSettled(requestJson, roomOf.get(page)!, "the room has settled its turn");
		};
		const wheel = async (page: Page, deltaY: number) => {
			const box = (await page.locator(".messages").boundingBox())!;
			await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
			await page.mouse.wheel(0, deltaY);
		};
		/**
		 * Drags the scroll bar down to `short` px from the end in a few steps. Headless
		 * Chromium hides scroll bars, so the steps are writes the page did not make,
		 * with no wheel, finger or key behind them: what a drag looks like to the page.
		 */
		const dragToNearEnd = async (page: Page, short: number) => {
			for (const share of [0.25, 0.5, 0.75, 1]) {
				await page.locator(".messages").evaluate((el, [part, gap]) => {
					const target = el.scrollHeight - el.clientHeight - gap;
					el.scrollTop += (target - el.scrollTop) * part;
				}, [share, short]);
				// One frame per step, so the page sees each as its own scroll.
				await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => resolve(null))));
			}
		};
		/** Scrolls down to 10 px short of the end, which keeps moving away. */
		const toNearEnd = async (page: Page) => wheel(page, Math.max(1, (await distance(page)) - 10));
		/** The newest user message's top, in px below the view's top. */
		const newestSentOffset = (page: Page) => page.evaluate(() => {
			const box = document.querySelector(".messages")!.getBoundingClientRect();
			const last = [...document.querySelectorAll(".messages .bubble-row.user")].pop();
			return last ? last.getBoundingClientRect().top - box.top : null;
		});
		/** The answer blocks put on screen since `since`, with whether each faded in and the line it shows now (0: none). */
		const blocksSince = (page: Page, since: number) => page.evaluate((t) => ((window as any).__answerBlocks as { block: Element; fades: boolean; at: number }[]).filter((b) => b.at >= t).map((b) => ({ fades: b.fades, at: b.at, line: Number(/^Line (\d+):/.exec(b.block.textContent ?? "")?.[1] ?? 0) })), since);
		const pageNow = (page: Page) => page.evaluate(() => performance.now());

		// A room with history first, so the view has somewhere to stay.
		const stay = await enter("Stay Room");
		await send(stay.page, `Warm-up question ${GATED}`);
		await pump(stay.page, 12);
		await finish(stay.page);

		await row("after Send the view stays still while the answer grows below; the ↓ pill shows; scrolling down to the end attaches", async () => {
			const { page } = stay;
			await send(page, `Stay question ${GATED}`);
			await pump(page, 1);
			await page.waitForTimeout(700);
			const still = await scrollTop(page);
			await pump(page, 40);
			const moved = (await scrollTop(page)) !== still;
			const pill = (await page.getByText("↓ New text").count()) > 0;
			await toNearEnd(page);
			await page.waitForTimeout(400);
			await pump(page, 10);
			const attached = (await distance(page)) <= 2;
			await finish(page);
			if (moved) return "after Send the view followed the answer";
			if (!pill) return "no ↓ pill while the answer ran below the view";
			return attached ? null : "scrolling down to 10 px of the end did not attach";
		});

		// A long chat read from its top: the glide after Send is long, and its last steps are still the page's own.
		const long = await enter("Long Room");
		await send(long.page, `Long warm-up question ${GATED}`);
		await pump(long.page, 60);
		await finish(long.page);
		await row("after Send from the top of a long chat the view stays still once the message has glided up", async () => {
			const { page } = long;
			await wheel(page, -100_000);
			await waitUntil(async () => (await scrollTop(page)) === 0, "the long chat is read from its top");
			await page.waitForTimeout(400);
			await send(page, `Long question ${GATED}`);
			await pump(page, 1);
			await waitUntil(async () => {
				const before = await scrollTop(page);
				await page.waitForTimeout(300);
				return (await scrollTop(page)) === before;
			}, "the glide after Send has landed");
			const offset = await newestSentOffset(page);
			const still = await scrollTop(page);
			// Past the warm-up's 61 lines, so the wait is on this answer's own lines.
			await pump(page, 70);
			const moved = (await scrollTop(page)) !== still;
			const pill = (await page.getByText("↓ New text").count()) > 0;
			const seen = await page.locator(".messages").evaluate((el) => ({ top: el.scrollTop, height: el.scrollHeight, client: el.clientHeight }));
			const sentNow = await newestSentOffset(page);
			await finish(page);
			if (offset === null || offset > 120) return `the sent message did not glide to the top (${offset} px down)`;
			if (moved) return "after the glide the view followed the answer";
			return pill ? null : `no ↓ pill while the answer ran below the view (${JSON.stringify({ still, ...seen, offset, sentNow })})`;
		});

		const caught = await enter("Catch Room");
		await row("scrolling back down to within 24 px of the end follows again", async () => {
			const { page } = caught;
			await send(page, `Catch question ${GATED}`);
			await pump(page, 30);
			await page.waitForTimeout(700);
			await toNearEnd(page);
			await page.waitForTimeout(400);
			await pump(page, 4);
			await wheel(page, -300);
			await page.waitForTimeout(500);
			await pump(page, 4);
			if ((await distance(page)) <= 24) return `the wheel up did not leave the end behind, ${await distance(page)} px`;
			await toNearEnd(page);
			await page.waitForTimeout(400);
			await pump(page, 10);
			return (await distance(page)) <= 2 ? null : `scrolling down to 10 px of the end did not follow again, ${await distance(page)} px from the end`;
		});
		await row("a small wheel up mid-answer stops following and shows \"↓ New text\"", async () => {
			const { page } = caught;
			await wheel(page, -200);
			await page.waitForTimeout(400);
			await pump(page, 6);
			if ((await distance(page)) <= 24) return `a small wheel up kept following, ${await distance(page)} px`;
			return (await page.getByText("↓ New text").count()) > 0 ? null : "no ↓ New text pill";
		});
		await row("a move down within 300 ms of a gesture up does not follow again", async () => {
			const { page } = caught;
			await wheel(page, -150);
			await toNearEnd(page);
			await page.waitForTimeout(400);
			await pump(page, 6);
			return (await distance(page)) > 24 ? null : `the tail of a gesture up followed again, ${await distance(page)} px`;
		});
		await row("dragging the scroll bar to within a few px of the end follows again", async () => {
			const { page } = caught;
			await wheel(page, -300);
			const leftEnd = await waitUntil(async () => (await distance(page)) > 24, "the wheel up left the end", 5_000).then(() => true, () => false);
			await pump(page, 4);
			if (!leftEnd || (await distance(page)) <= 24) return `the wheel up did not leave the end behind, ${await distance(page)} px`;
			await dragToNearEnd(page, 6);
			await pump(page, 10);
			const followed = await waitUntil(async () => (await distance(page)) <= 2 && (await page.getByText("↓ New text").count()) === 0, "the view follows the answer again", 5_000).then(() => true, () => false);
			if (followed) return null;
			return (await distance(page)) > 2 ? `dragging the scroll bar to 6 px of the end did not follow again, ${await distance(page)} px from the end` : "\"↓ New text\" still shows at the end";
		});
		await row("a wheel up that reaches the top of the chat stops following", async () => {
			const { page } = caught;
			await toNearEnd(page);
			await page.waitForTimeout(400);
			await pump(page, 4);
			await wheel(page, -100_000);
			await page.waitForTimeout(400);
			await pump(page, 6);
			const top = await scrollTop(page);
			await finish(page);
			return top <= 2 ? null : `a wheel up to the top was pulled back to the end, scrollTop ${top}`;
		});

		// Opening a room mid-answer follows it: here a wheel up on a chat that cannot scroll yet must not stop that.
		const reopen = await enter("Reopen Room");
		await row("a wheel up on a chat that cannot scroll keeps following", async () => {
			const { page } = reopen;
			await send(page, `Reopen question ${GATED}`);
			await pump(page, 1);
			const before = reopen.readies();
			await page.reload();
			await waitUntil(() => reopen.readies() > before, "the reopened room's connection is ready");
			await waitUntil(() => lineShown(page, 1), "the open answer is back on screen");
			await page.waitForTimeout(500);
			if ((await scrollTop(page)) !== 0) return `the short chat has something above to scroll to, scrollTop ${await scrollTop(page)}`;
			await wheel(page, -120);
			await page.waitForTimeout(400);
			await pump(page, 30);
			const away = await distance(page);
			await finish(page);
			return away <= 2 ? null : `a wheel up on a chat that could not scroll stopped following, ${away} px from the end`;
		});

		const done = await enter("Done Room");
		await row("the moment the model is done, Send and Remember work while the last words appear; Send shows the rest at once and glides the new message to the top", async () => {
			const { page } = done;
			await send(page, `Long question ${GATED}`);
			await pump(page, 1);
			const last = release(70);
			modelDone();
			await waitUntil(async () => (await page.locator(".stop-btn").count()) === 0, "the server's turn has ended", 10_000).catch(() => {});
			if (await lineShown(page, last)) return "the answer's tail was already on screen: the row needs a longer answer";
			const composer = page.locator("textarea").first();
			await composer.fill(`Next question ${GATED}`);
			const sendButton = page.locator('button[title="Send"]').first();
			const rememberButton = page.locator(".checkpoint-split-main").first();
			const sendOn = (await sendButton.count()) > 0 && await sendButton.isEnabled();
			const rememberOn = (await rememberButton.count()) > 0 && await rememberButton.isEnabled();
			if (!sendOn || !rememberOn) return `with the model done and the tail still appearing, Send ${sendOn ? "works" : "is off"} and Remember ${rememberOn ? "works" : "is off"}`;
			await composer.press("Enter");
			await page.waitForTimeout(150);
			if (!(await lineShown(page, last))) return "Send did not put the rest of the answer on screen first";
			await page.waitForTimeout(900);
			const offset = await newestSentOffset(page);
			await waitUntil(() => open !== null, "the next answer has begun");
			await pump(page, 2);
			await finish(page);
			return offset !== null && offset >= -2 && offset < 120 ? null : `Send did not glide the new message to the top, its top is ${offset} px below the view's`;
		});

		const fade = await enter("Fade Room");
		await row("each new block fades in while the answer is written", async () => {
			const { page } = fade;
			await send(page, `Fade question ${GATED}`);
			await pump(page, 1);
			const since = await pageNow(page);
			for (let i = 0; i < 3; i++) await pump(page, 1);
			const blocks = await blocksSince(page, since);
			await finish(page);
			if (blocks.length === 0) return "no new block landed";
			return blocks.every((b) => b.fades) ? null : `${blocks.filter((b) => !b.fades).length} of ${blocks.length} new blocks did not fade in`;
		});
		await row("a finished answer shows no fade", async () => {
			const { page } = fade;
			const before = fade.readies();
			await page.reload();
			await waitUntil(() => fade.readies() > before, "the reopened room's connection is ready");
			await waitUntil(() => lineShown(page, 4), "the finished answer is on screen");
			const blocks = await blocksSince(page, 0);
			if (blocks.length === 0) return "no block of the finished answer was seen";
			return blocks.some((b) => b.fades) ? `${blocks.filter((b) => b.fades).length} blocks of a finished answer faded in` : null;
		});
		await row("the row under the box lines up: the meter, both halves of Remember and the model share one height, top and text baseline", async () => {
			// A string, so the bundler adds no helper names the page does not have.
			const boxes = await fade.page.evaluate(`(() => {
				// The baseline is where a zero-size inline probe beside the label's first words sits.
				const baselineOf = (el) => {
					const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
					let node = walker.nextNode();
					while (node && !node.textContent.trim()) node = walker.nextNode();
					if (!node) return null;
					const wrap = document.createElement("span");
					node.parentNode.insertBefore(wrap, node);
					wrap.appendChild(node);
					const probe = document.createElement("span");
					probe.style.cssText = "display:inline-block;width:0;height:0;vertical-align:baseline";
					wrap.appendChild(probe);
					const y = probe.getBoundingClientRect().bottom;
					wrap.parentNode.insertBefore(node, wrap);
					wrap.remove();
					return y;
				};
				const controls = [
					["the meter", ".composer-context-pill", ".composer-context-pill-label"],
					["Remember", ".checkpoint-split-main", ".checkpoint-split-main"],
					["Remember's arrow", ".checkpoint-split-toggle", null],
					["the model", ".model-pick-trigger", ".model-pick-trigger-name"],
					["the command mode", ".bash-mode-chip", ".bash-mode-chip-label"],
				];
				return controls.map(([name, box, text]) => {
					const el = document.querySelector(".composer-under-row " + box);
					if (!el) return { name, missing: true };
					const r = el.getBoundingClientRect();
					return { name, top: r.top, height: r.height, baseline: text ? baselineOf(document.querySelector(".composer-under-row " + text)) : null };
				});
			})()`) as Array<{ name: string; missing?: true; top: number; height: number; baseline: number | null }>;
			// The command mode shows only in a room with commands on, which this one is not.
			const missing = boxes.filter((b) => b.missing && b.name !== "the command mode").map((b) => b.name);
			if (missing.length) return `the row under the box has no ${missing.join(", ")}`;
			const shown = boxes.filter((b) => !b.missing);
			const spread = (values: number[]) => Math.max(...values) - Math.min(...values);
			const describe = (pick: (b: (typeof shown)[number]) => number | null) => shown.filter((b) => pick(b) !== null).map((b) => `${b.name} ${pick(b)!.toFixed(2)}`).join(", ");
			if (spread(shown.map((b) => b.height)) > 1) return `the controls' heights differ: ${describe((b) => b.height)}`;
			if (spread(shown.map((b) => b.top)) > 1) return `the controls' tops differ: ${describe((b) => b.top)}`;
			const baselines = shown.flatMap((b) => (b.baseline === null ? [] : [b.baseline]));
			return spread(baselines) > 1 ? `the labels' baselines differ: ${describe((b) => b.baseline)}` : null;
		});
		const calm = await enter("Calm Room", { reducedMotion: true });
		await row("with reduced motion no block fades in", async () => {
			const { page } = calm;
			await send(page, `Calm question ${GATED}`);
			await pump(page, 1);
			const since = await pageNow(page);
			for (let i = 0; i < 3; i++) await pump(page, 1);
			const blocks = await blocksSince(page, since);
			await finish(page);
			if (blocks.length === 0) return "no new block landed";
			return blocks.some((b) => b.fades) ? `${blocks.filter((b) => b.fades).length} blocks faded in with reduced motion` : null;
		});

		const drop = await enter("Drop Room");
		await send(drop.page, `Drop question ${GATED}`);
		const onScreenAtDrop = 12;
		await pump(drop.page, onScreenAtDrop);
		// The shortest the answer was on screen from the drop on.
		// A string, so the bundler adds no helper names the page does not have.
		await drop.page.evaluate(`(() => {
			const answerLength = () => [...document.querySelectorAll(".messages .assistant-markdown")].map((el) => el.textContent || "").filter((text) => text.includes("Line 1:")).reduce((most, text) => Math.max(most, text.length), 0);
			window.__answerBefore = answerLength();
			window.__answerShortest = window.__answerBefore;
			new MutationObserver(() => { window.__answerShortest = Math.min(window.__answerShortest, answerLength()); }).observe(document.querySelector(".messages"), { childList: true, subtree: true, characterData: true });
		})()`);
		const dropAt = await pageNow(drop.page);
		const readiesBefore = drop.readies();
		drop.drop();
		// Lines written while the page is away: only the replay brings them, so it
		// puts new blocks on screen even when the page keeps the answer it had.
		const writtenAway = release(2);
		await waitUntil(() => drop.readies() > readiesBefore, "the room reconnects", 30_000);
		await waitUntil(() => lineShown(drop.page, writtenAway), `line ${writtenAway}, written while the page was away, is on screen`, 30_000);
		await drop.page.waitForTimeout(800);
		await row("a reconnect's replay paints in one go: the answer is never shorter on screen than before the drop", async () => {
			const { before, shortest } = await drop.page.evaluate(() => ({ before: (window as any).__answerBefore as number, shortest: (window as any).__answerShortest as number }));
			return shortest >= before ? null : `the answer went from ${before} to ${shortest} characters on screen during the replay`;
		});
		await row("a reconnect's replay shows no fade on what was on screen, and the lines written while away fade in", async () => {
			const blocks = await blocksSince(drop.page, dropAt);
			await pump(drop.page, 3);
			await finish(drop.page);
			const replayed = blocks.filter((b) => b.line >= 1 && b.line <= onScreenAtDrop);
			const away = blocks.filter((b) => b.line > onScreenAtDrop);
			// The page keeps the blocks it showed when the answer's ids match, so a replayed block may never be put on screen again.
			if (replayed.some((b) => b.fades)) return `${replayed.filter((b) => b.fades).length} replayed blocks faded in`;
			if (away.length === 0) return "no line written while away was seen";
			return away.every((b) => b.fades) ? null : `${away.filter((b) => !b.fades).length} of ${away.length} lines written while away showed without their fade-in`;
		});
	} finally {
		await browser.close();
	}
	if (failures.length) throw new Error(`chat-follow smoke: ${failures.length} row(s) failed: ${failures.join("; ")}`);
	console.log("chat-follow smoke: ok");
} catch (error) {
	console.error(serverOutput.join("").slice(-6000));
	throw error;
} finally {
	try { (endpoint as any).closeAllConnections?.(); } catch {}
	try { endpoint.close(); } catch {}
	await stopSmokeServer(server);
	fs.rmSync(tempRoot, { recursive: true, force: true });
}
