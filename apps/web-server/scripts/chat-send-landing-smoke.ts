// Where the glide after Send stops, in the browser against a real spawned
// server and one synthetic Anthropic endpoint, at desktop and phone width and
// their screens' pixel densities (a scroll position snaps to device pixels).
// Every send glides the sent message up; when it lands, nothing of what sits
// above the message shows in the messages box (no part of it ends below the
// box's top edge), and the message sits at the same gap below that edge
// whatever was above it:
// - a failure line, after a send that failed;
// - an answer's copy row, after a plain answer;
// - a steps card, after an answer that was only a step.
// A "Queued" bubble never sits above a sent message: it is always last in the
// newest turn (groupIntoTurns), and a queued message the room takes joins the
// running answer's turn, with no glide.
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
import { chromium, type Page } from "playwright";
import { authedFetch, SMOKE_AUTH_TOKEN, SMOKE_SERVER_AUTH_ENV, SMOKE_SERVER_SPAWN_TREE_OPTIONS, smokeHomeEnv, stopSmokeServer, freePort } from "./smoke-server-process.js";
import { waitForTurnSettled } from "./smoke-turn-settle.js";

function assert(condition: unknown, message: string): asserts condition {
	if (!condition) throw new Error(message);
}

{
	const p = typeof chromium?.executablePath === "function" ? chromium.executablePath() : "";
	if (!p || !fs.existsSync(p)) {
		console.log("chat send landing smoke skipped (Chromium not installed)");
		process.exit(0);
	}
}

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const webServerDir = path.resolve(scriptDir, "..");
const repoRoot = path.resolve(webServerDir, "..", "..");
const port = await freePort();
const baseUrl = `http://127.0.0.1:${port}`;

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "exxperts-send-landing-"));
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
// Markers in the message pick the model's answer.
const FAIL = "[fail]";
const STEP = "[step]";
const endpoint = http.createServer((req, res) => {
	let raw = "";
	req.on("data", (chunk) => { raw += chunk; });
	req.on("end", () => {
		const body = JSON.parse(raw || "{}");
		const lastUser = JSON.stringify((body.messages ?? []).filter((m: { role?: string }) => m.role === "user").at(-1) ?? "");
		if (lastUser.includes(FAIL)) {
			res.writeHead(400, { "content-type": "application/json" });
			res.end(JSON.stringify({ type: "error", error: { type: "invalid_request_error", message: "messages.0.content: text content blocks must be non-empty" }, request_id: "req_smoke_landing" }));
			return;
		}
		const send = (payload: { type: string }) => res.write(`event: ${payload.type}\ndata: ${JSON.stringify(payload)}\n\n`);
		res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
		send({ type: "message_start", message: { id: "msg_landing", type: "message", role: "assistant", model: body.model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 100, output_tokens: 1 } } } as { type: string });
		const close = () => {
			send({ type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 30 } } as { type: string });
			send({ type: "message_stop" });
			res.end();
		};
		if (lastUser.includes(STEP)) {
			// A step and nothing after it: the steps card is the last thing in its turn.
			send({ type: "content_block_start", index: 0, content_block: { type: "server_tool_use", id: "srvtoolu_landing", name: "web_search", input: {} } } as { type: string });
			send({ type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: JSON.stringify({ query: "launch checklist" }) } } as { type: string });
			send({ type: "content_block_stop", index: 0 } as { type: string });
			send({ type: "content_block_start", index: 1, content_block: { type: "web_search_tool_result", tool_use_id: "srvtoolu_landing", content: [{ type: "web_search_result", title: "Launch checklist", url: "https://example.com/launch", encrypted_content: "synthetic", page_age: null }] } } as { type: string });
			send({ type: "content_block_stop", index: 1 } as { type: string });
			close();
			return;
		}
		send({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } } as { type: string });
		send({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "A short answer, one line long." } } as { type: string });
		send({ type: "content_block_stop", index: 0 } as { type: string });
		close();
	});
});

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

/** Where the newest sent message landed: its top below the box's top, and how far the lowest part of anything above it reaches into the box. */
interface Landing { gap: number; aboveShows: number | null; lowest: string; scrollTop: number }

let server: ChildProcessWithoutNullStreams | undefined;
const serverOutput: string[] = [];

try {
	await new Promise<void>((resolve) => endpoint.listen(0, "127.0.0.1", resolve));
	const endpointUrl = `http://127.0.0.1:${(endpoint.address() as AddressInfo).port}`;
	fs.writeFileSync(path.join(agentDir, "models.json"), JSON.stringify({ providers: { [KEY_PROVIDER]: { baseUrl: endpointUrl } } }, null, 2), { mode: 0o600 });
	fs.writeFileSync(path.join(agentDir, "auth.json"), JSON.stringify({ [KEY_PROVIDER]: { type: "api_key", key: "synthetic-anthropic-key" } }, null, 2), { mode: 0o600 });
	fs.writeFileSync(path.join(agentDir, "settings.json"), JSON.stringify({ retry: { baseDelayMs: 1000, provider: { maxRetries: 0 } } }, null, 2), { mode: 0o600 });
	const agents = await import("../src/persistent-agents.js");
	const WIDTHS = ["desktop", "phone"] as const;
	const CASES = ["Failed", "Answered", "Stepped"] as const;
	const roomName = (width: string, kind: string) => `${kind} ${width === "desktop" ? "Desk" : "Phone"} Room`;
	const rooms = Object.fromEntries(WIDTHS.flatMap((width) => CASES.map((kind) => roomName(width, kind))).map((displayName) => [displayName, agents.createPersistentAgentFromScaffoldInput({ displayName, userName: "Synthetic User", preferredUserAddress: "Synthetic User" }).agent.agentId]));
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
	const requestJson = async (pathname: string) => {
		const res = await authedFetch(`${baseUrl}${pathname}`);
		return { status: res.status, body: await res.json().catch(() => null) };
	};

	const browser = await chromium.launch();
	try {
		const enter = async (width: (typeof WIDTHS)[number], room: string): Promise<Page> => {
			const context = await browser.newContext(width === "desktop"
				? { viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2 }
				: { viewport: { width: 390, height: 844 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true });
			const page = await context.newPage();
			await page.goto(`${baseUrl}/auth/session?token=${SMOKE_AUTH_TOKEN}`);
			await page.waitForLoadState("networkidle");
			const dismiss = page.locator(".whats-new-close");
			if (await dismiss.count()) await dismiss.click();
			await page.locator(".persistent-agent-card").filter({ hasText: room }).getByRole("button", { name: /^(Enter|Resume)( →)?$/ }).click();
			await page.locator("button.send-btn").first().waitFor({ timeout: 15000 });
			await page.waitForTimeout(500);
			return page;
		};
		const type = async (page: Page, text: string) => {
			await page.locator(".composer-box textarea").first().fill(text);
			await page.locator("button.send-btn").first().click();
		};
		const turnEnded = async (page: Page, room: string) => {
			await waitUntil(async () => (await page.locator(".stop-btn").count()) === 0, "the turn has ended");
			await waitForTurnSettled(requestJson, rooms[room], "the room has settled its turn");
		};
		/** Sends and waits for the answer, its turn settled. */
		const ask = async (page: Page, room: string, text: string) => {
			await type(page, text);
			await waitUntil(async () => (await page.locator(".messages .bubble-row.user:not(.queued)").filter({ hasText: text }).count()) > 0, `"${text}" is sent`);
			await turnEnded(page, room);
		};
		const landed = async (page: Page) => waitUntil(async () => {
			const before = await page.locator(".messages").evaluate((el) => el.scrollTop);
			await page.waitForTimeout(400);
			return (await page.locator(".messages").evaluate((el) => el.scrollTop)) === before;
		}, "the glide after Send has landed");
		// A string, so the bundler adds no helper names the page does not have.
		const landing = (page: Page) => page.evaluate(`(() => {
			const box = document.querySelector(".messages");
			const top = box.getBoundingClientRect().top;
			const sent = [...box.querySelectorAll(".bubble-row.user:not(.queued)")].pop();
			const turn = sent.closest(".transcript-turn") || sent;
			let lowest = -Infinity, what = "";
			for (const el of box.querySelectorAll("*")) {
				if (el.contains(turn) || !(turn.compareDocumentPosition(el) & Node.DOCUMENT_POSITION_PRECEDING)) continue;
				// What can paint: hidden parts, such as a folded card's rows, do not
				// count, and a part is cut at the bottom of each box that clips it.
				if (!el.checkVisibility({ visibilityProperty: true })) continue;
				const r = el.getBoundingClientRect();
				if (r.width === 0 || r.height === 0) continue;
				let bottom = r.bottom;
				for (let up = el.parentElement; up && up !== box; up = up.parentElement) {
					const style = getComputedStyle(up);
					if (style.overflowY !== "visible" || style.overflowX !== "visible") bottom = Math.min(bottom, up.getBoundingClientRect().bottom);
				}
				if (bottom <= r.top) continue;
				if (bottom > lowest) { lowest = bottom; what = el.tagName.toLowerCase() + "." + String(el.className).trim().split(/\\s+/).join("."); }
			}
			return { gap: +(sent.getBoundingClientRect().top - top).toFixed(1), aboveShows: lowest === -Infinity ? null : +(lowest - top).toFixed(1), lowest: what, scrollTop: box.scrollTop };
		})()`) as Promise<Landing>;

		for (const width of WIDTHS) {
			const landings: Partial<Record<(typeof CASES)[number], Landing>> = {};
			const check = (kind: (typeof CASES)[number], above: string, run: () => Promise<Landing>) => row(`${width}: after ${above}, the glide stops with nothing of it in view`, async () => {
				const at = await run();
				landings[kind] = at;
				if (at.aboveShows === null) return "nothing sits above the sent message";
				if (at.gap <= 0) return `the sent message is not below the box's top: ${JSON.stringify(at)}`;
				return at.aboveShows <= 0 ? null : `${at.aboveShows} px of ${at.lowest} shows under the box's top edge: ${JSON.stringify(at)}`;
			});

			await check("Failed", "a failed send", async () => {
				const room = roomName(width, "Failed");
				const page = await enter(width, room);
				await type(page, `Draft the outline for Friday. ${FAIL}`);
				await waitUntil(async () => (await page.locator(".messages .system-line.error").count()) > 0, "the failure line shows");
				await turnEnded(page, room);
				await ask(page, room, "Draft the announcement for Monday.");
				await landed(page);
				const at = await landing(page);
				await page.context().close();
				return at;
			});
			await check("Answered", "an answer", async () => {
				const room = roomName(width, "Answered");
				const page = await enter(width, room);
				await ask(page, room, "What is on the plan for today?");
				await ask(page, room, "And for tomorrow?");
				await landed(page);
				const at = await landing(page);
				await page.context().close();
				return at;
			});
			await check("Stepped", "a steps card", async () => {
				const room = roomName(width, "Stepped");
				const page = await enter(width, room);
				await ask(page, room, `Look up the launch checklist. ${STEP}`);
				const card = page.locator(".messages .transcript-turn").last().locator(".wk-card");
				if ((await card.count()) === 0) throw new Error("the answer shows no steps card");
				await ask(page, room, "What did you find?");
				await landed(page);
				const at = await landing(page);
				await page.context().close();
				return at;
			});
			await row(`${width}: the sent message lands at the same gap below the box's top whatever was above it`, async () => {
				const gaps = Object.values(landings).map((at) => at!.gap);
				if (gaps.length < CASES.length) return "a case above did not land";
				// A scroll position is whole pixels, so the gap may differ by under one.
				return Math.max(...gaps) - Math.min(...gaps) < 1 ? null : `gaps differ: ${JSON.stringify(Object.fromEntries(Object.entries(landings).map(([kind, at]) => [kind, at!.gap])))}`;
			});
		}
	} finally {
		await browser.close();
	}
	if (failures.length) throw new Error(`chat-send-landing smoke: ${failures.length} row(s) failed: ${failures.join("; ")}`);
	console.log("chat-send-landing smoke: ok");
} catch (error) {
	console.error(serverOutput.join("").slice(-6000));
	throw error;
} finally {
	try { (endpoint as any).closeAllConnections?.(); } catch {}
	try { endpoint.close(); } catch {}
	await stopSmokeServer(server);
	fs.rmSync(tempRoot, { recursive: true, force: true });
}
