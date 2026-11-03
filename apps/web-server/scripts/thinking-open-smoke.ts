// The model's thinking and steps while it works, in the browser against a real
// spawned server and one synthetic Anthropic endpoint:
//
// - while it thinks, only "Thinking" and its timer show: none of the thought's words;
// - a click on it (or Enter or Space) opens the whole thought, as Markdown, and
//   it grows there, kept at its newest line until the person scrolls up in it;
// - opened, it stays open when the thinking ends and reads "Thought for N s";
// - the same for thinking inside a work card, after a step, and the card stays
//   open over the open thought when the answer comes;
// - an open thought keeps the passage the person read when it becomes a card's
//   row, and its place when a second thinking block joins it;
// - the page never hides a thought the person opened: not the row cap, not the
//   long turn's fold; and a folded turn the person folded over it stays
//   folded after the next message; a box that fits its words for a moment keeps
//   where the person read;
// - leaving and resuming the room draws it from the saved conversation, so the
//   card keeps its steps and shows no thinking, as after a reload;
// - a NUL in the thinking is a character of the thought, not a break;
// - a block with no words (redacted) is the label alone, never a button;
// - text the model wrote before a step or before thinking is drawn above it,
//   while the thinking runs and after the turn;
// - a step the model is still writing shows as its row at once;
// - the provider's own web search is a step between the words before it and
//   the answer, while it runs, when done and after a reload; one the provider's
//   failure cuts stops with its turn, and before any text its message goes back
//   to the box with nothing left above;
// - the room shortening the conversation says so under the conversation;
// - none of it is saved: no thinking, no step still being written, no step's
//   end time, and no new file in the data folder.
//
// Run: npm run smokes -- thinking-open   (or tsx this file)
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import { fileURLToPath } from "node:url";
import { chromium, type Page } from "playwright";
import { authedFetch, SMOKE_AUTH_TOKEN, SMOKE_SERVER_AUTH_ENV, SMOKE_SERVER_SPAWN_TREE_OPTIONS, smokeHomeEnv, stopSmokeServer, freePort } from "./smoke-server-process.js";

function assert(condition: unknown, message: string): asserts condition {
	if (!condition) throw new Error(message);
}

{
	const p = typeof chromium?.executablePath === "function" ? chromium.executablePath() : "";
	if (!p || !fs.existsSync(p)) {
		console.log("thinking open smoke skipped (Chromium not installed)");
		process.exit(0);
	}
}

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const webServerDir = path.resolve(scriptDir, "..");
const repoRoot = path.resolve(webServerDir, "..", "..");
const port = await freePort();
const baseUrl = `http://127.0.0.1:${port}`;

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "exxperts-thinking-open-"));
const tempHome = path.join(tempRoot, "home");
const agentsRoot = path.join(tempHome, ".exxperts", "app", "personalized-agents");
const agentDir = path.join(tempHome, ".exxperts", "agent");
for (const dir of [agentsRoot, agentDir]) fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
process.env.HOME = tempHome;
process.env.USERPROFILE = tempHome;
process.env.EXXPERTS_CODING_AGENT_DIR = agentDir;
process.env.EXXETA_PERSISTENT_AGENTS_ROOT = agentsRoot;

const KEY_PROVIDER = "anthropic-api-key";
const ON_KEY = { provider: KEY_PROVIDER, model: "claude-sonnet-5-5" };
// Each piece of the thought: a bold heading with no full stop, as some providers send it, then a sentence.
const PIECE_WORD = "Weighing";
const SEARCH_LEAD = "Let me search.";
const SEARCH_ANSWER = "Node.js 24 is the active LTS line.";
const SHORTENING = "Shortening the conversation so far…";
const piece = (n: number) => `**${PIECE_WORD} option ${n}**\n\nThe refill rate against the bucket size, case ${n}.\n\n`;

function sse(res: http.ServerResponse, event: string, payload: unknown): void {
	if (!res.destroyed) res.write(`event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`);
}

function userText(message: any): string {
	const content = message?.content;
	if (typeof content === "string") return content;
	return Array.isArray(content) ? content.map((part: any) => (typeof part?.text === "string" ? part.text : "")).join("\n") : "";
}

// Holds the scenes let go: the thought grows until `thought` is let go (a
// second block until `thought2`), then the answer waits until `answer` is let go.
type Hold = { promise: Promise<void>; release: () => void };
const hold = (): Hold => {
	let release = () => {};
	const promise = new Promise<void>((resolve) => { release = resolve; });
	return { promise, release };
};
let thought = hold();
let thought2 = hold();
let answer = hold();
// A fallback that never keeps the process alive once the scenes are done.
const timeout = (ms: number) => new Promise<void>((resolve) => { setTimeout(resolve, ms).unref(); });
// open: requests still answering; steps: how many steps the newest request's turn had run; calls: requests so far.
const endpointState = { open: 0, steps: 0, calls: 0 };

// The newest user message decides: "think" thinks out loud ("twice": two
// blocks in a row; "then a step": then runs `sleep 1`), "quietly" sends a
// redacted block, "a step, then" first runs `sleep 1` and thinks after it;
// anything else answers at once when `answer` is let go.
const endpoint = http.createServer((req, res) => {
	let raw = "";
	req.on("data", (chunk) => { raw += chunk; });
	req.on("end", async () => {
		const body = JSON.parse(raw || "{}");
		const messages: any[] = body.messages ?? [];
		const lastUser = [...messages].reverse().find((message) => message.role === "user" && userText(message).trim());
		const asked = userText(lastUser);
		const last = messages.at(-1);
		const afterStep = Array.isArray(last?.content) && last.content.some((part: any) => part?.type === "tool_result");
		// How many steps this turn has run so far.
		const steps = messages.slice(messages.indexOf(lastUser) + 1).filter((message) => Array.isArray(message.content) && message.content.some((part: any) => part?.type === "tool_result")).length;
		endpointState.open += 1;
		endpointState.calls += 1;
		endpointState.steps = steps;
		res.on("close", () => { endpointState.open -= 1; });
		res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
		sse(res, "message_start", { type: "message_start", message: { id: `msg_think_${Date.now()}`, type: "message", role: "assistant", model: body.model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 100, output_tokens: 1 } } });
		const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
		const end = (reason: string) => {
			sse(res, "message_delta", { type: "message_delta", delta: { stop_reason: reason, stop_sequence: null }, usage: { output_tokens: 40 } });
			sse(res, "message_stop", { type: "message_stop" });
			res.end();
		};
		const words = (index: number) => {
			sse(res, "content_block_start", { type: "content_block_start", index, content_block: { type: "text", text: "" } });
			sse(res, "content_block_delta", { type: "content_block_delta", index, delta: { type: "text_delta", text: "Here is the answer." } });
			sse(res, "content_block_stop", { type: "content_block_stop", index });
		};
		const toolUse = (index: number, command = "sleep 1") => {
			sse(res, "content_block_start", { type: "content_block_start", index, content_block: { type: "tool_use", id: `toolu_think_${Date.now()}_${index}`, name: "bash", input: {} } });
			sse(res, "content_block_delta", { type: "content_block_delta", index, delta: { type: "input_json_delta", partial_json: JSON.stringify({ command }) } });
			sse(res, "content_block_stop", { type: "content_block_stop", index });
		};
		const lead = (index: number, text: string) => {
			sse(res, "content_block_start", { type: "content_block_start", index, content_block: { type: "text", text: "" } });
			sse(res, "content_block_delta", { type: "content_block_delta", index, delta: { type: "text_delta", text } });
			sse(res, "content_block_stop", { type: "content_block_stop", index });
		};
		const thinkOnce = async (index: number, from = 1, count = 300) => {
			sse(res, "content_block_start", { type: "content_block_start", index, content_block: { type: "thinking", thinking: "", signature: "" } });
			let released = false;
			void thought.promise.then(() => { released = true; });
			for (let n = from; n < from + count && !released && !res.destroyed; n++) {
				sse(res, "content_block_delta", { type: "content_block_delta", index, delta: { type: "thinking_delta", thinking: piece(n) } });
				await sleep(150);
			}
			sse(res, "content_block_delta", { type: "content_block_delta", index, delta: { type: "signature_delta", signature: "synthetic" } });
			sse(res, "content_block_stop", { type: "content_block_stop", index });
		};
		// "one paragraph": a thought that is a single paragraph, growing until let go.
		// "with a diagram": a few notes and a closed diagram fence, then nothing more until let go.
		if (/\b(one paragraph|with a diagram)\b/.test(asked)) {
			sse(res, "content_block_start", { type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "", signature: "" } });
			let released = false;
			void thought.promise.then(() => { released = true; });
			const diagram = /\bwith a diagram\b/.test(asked);
			for (let n = 1; n <= (diagram ? 12 : 400) && !released && !res.destroyed; n++) {
				sse(res, "content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: diagram ? piece(n) : `${PIECE_WORD} option ${n} against the bucket size and its refill rate. ` } });
				await sleep(diagram ? 40 : 120);
			}
			if (diagram) sse(res, "content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "```mermaid\ngraph TD\n  A[Request] --> B[Public bucket]\n  B --> C[Admin bucket]\n  C --> D[Refill]\n  D --> E[Allow]\n  E --> F[Count]\n  F --> G[Log]\n  G --> H[Done]\n```\n\n" } });
			await Promise.race([thought.promise, timeout(30_000)]);
			sse(res, "content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "signature_delta", signature: "synthetic" } });
			sse(res, "content_block_stop", { type: "content_block_stop", index: 0 });
			await Promise.race([answer.promise, timeout(30_000)]);
			words(1);
			end("end_turn");
			return;
		}
		// "seven steps": thinks, then seven steps in one go, then answers.
		if (/\bseven steps\b/.test(asked) && steps === 0) {
			await thinkOnce(0);
			for (let n = 1; n <= 7; n++) toolUse(n, "true");
			end("tool_use");
			return;
		}
		// "two stretches": a note and a step, then a note, thinking and a step, then the answer: two cards in one turn.
		if (/\btwo stretches\b/.test(asked) && steps < 2) {
			lead(0, steps === 0 ? "Looking first." : "Next part.");
			if (steps === 1) await thinkOnce(1);
			toolUse(steps === 0 ? 1 : 2);
			end("tool_use");
			return;
		}
		// "then fail": a short thought, then the provider fails before any text;
		// "search, then fail": the provider's own search starts, then the provider fails before it ends ("a word first": after a lead).
		if (/\bthen fail\b/.test(asked)) {
			if (/\bsearch, then fail\b/.test(asked)) {
				const at = /\ba word first\b/.test(asked) ? 1 : 0;
				if (at) lead(0, SEARCH_LEAD);
				sse(res, "content_block_start", { type: "content_block_start", index: at, content_block: { type: "server_tool_use", id: `srvtoolu_fail_${endpointState.calls}`, name: "web_search", input: {} } });
				sse(res, "content_block_delta", { type: "content_block_delta", index: at, delta: { type: "input_json_delta", partial_json: JSON.stringify({ query: "node lts" }) } });
				sse(res, "content_block_stop", { type: "content_block_stop", index: at });
				await sleep(300);
			} else await thinkOnce(0, 1, 6);
			sse(res, "error", { type: "error", error: { type: "overloaded_error", message: "Overloaded" } });
			res.end();
			return;
		}
	// "write a step slowly": the call's input arrives in two parts, the second when `thought` is let go.
		if (/\bwrite a step slowly\b/.test(asked) && !afterStep) {
			sse(res, "content_block_start", { type: "content_block_start", index: 0, content_block: { type: "tool_use", id: `toolu_slow_${Date.now()}`, name: "bash", input: {} } });
			sse(res, "content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: '{"command": "echo slow' } });
			await Promise.race([thought.promise, timeout(30_000)]);
			sse(res, "content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: '"}' } });
			sse(res, "content_block_stop", { type: "content_block_stop", index: 0 });
			end("tool_use");
			return;
		}
		// "search the web": the provider's own search inside one message, between a lead and the answer, until `thought` is let go;
		// "think and search the web" thinks first, until `thought` is let go.
		if (/\bsearch the web\b/.test(asked)) {
			const at = /\bthink\b/.test(asked) ? 1 : 0;
			if (at) await thinkOnce(0);
			lead(at, SEARCH_LEAD);
			sse(res, "content_block_start", { type: "content_block_start", index: at + 1, content_block: { type: "server_tool_use", id: `srvtoolu_${endpointState.calls}`, name: "web_search", input: {} } });
			sse(res, "content_block_delta", { type: "content_block_delta", index: at + 1, delta: { type: "input_json_delta", partial_json: JSON.stringify({ query: "node lts" }) } });
			sse(res, "content_block_stop", { type: "content_block_stop", index: at + 1 });
			await Promise.race([thought.promise, timeout(30_000)]);
			sse(res, "content_block_start", { type: "content_block_start", index: at + 2, content_block: { type: "web_search_tool_result", tool_use_id: `srvtoolu_${endpointState.calls}`, content: [{ type: "web_search_result", title: "Node.js releases", url: "https://nodejs.org/en/about/previous-releases", encrypted_content: "synthetic", page_age: null }] } });
			sse(res, "content_block_stop", { type: "content_block_stop", index: at + 2 });
			lead(at + 3, ` ${SEARCH_ANSWER}`);
			end("end_turn");
			return;
		}
		if (/\ba step, then\b/.test(asked) && !afterStep) {
			sse(res, "content_block_start", { type: "content_block_start", index: 0, content_block: { type: "tool_use", id: `toolu_think_${Date.now()}`, name: "bash", input: {} } });
			sse(res, "content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: JSON.stringify({ command: "sleep 1" }) } });
			sse(res, "content_block_stop", { type: "content_block_stop", index: 0 });
			end("tool_use");
			return;
		}
		if (/\bquietly\b/.test(asked)) {
			sse(res, "content_block_start", { type: "content_block_start", index: 0, content_block: { type: "redacted_thinking", data: "opaque-synthetic" } });
			await Promise.race([thought.promise, timeout(30_000)]);
			sse(res, "content_block_stop", { type: "content_block_stop", index: 0 });
		} else if (/\bthink\b/.test(asked) && !afterStep && !/\b(seven steps|two stretches)\b/.test(asked) || /\ba step, then\b/.test(asked)) {
			const think = async (index: number, until: Hold, from: number) => {
				sse(res, "content_block_start", { type: "content_block_start", index, content_block: { type: "thinking", thinking: "", signature: "" } });
				let released = false;
				void until.promise.then(() => { released = true; });
				for (let n = from; n <= from + 300 && !released && !res.destroyed; n++) {
					// "with a nul": a NUL inside the thought's words, which must not split it.
					const nul = /\bwith a nul\b/.test(asked) && n === from ? "Before the mark\u0000after the mark. " : "";
					sse(res, "content_block_delta", { type: "content_block_delta", index, delta: { type: "thinking_delta", thinking: nul + piece(n) } });
					await sleep(150);
				}
				// "an open fence": the first block ends inside a diagram fence it never closes.
				if (index === 0 && /\ban open fence\b/.test(asked)) sse(res, "content_block_delta", { type: "content_block_delta", index, delta: { type: "thinking_delta", thinking: "```mermaid\ngraph TD\n  A[Request] --> B[Bucket]\n" } });
				sse(res, "content_block_delta", { type: "content_block_delta", index, delta: { type: "signature_delta", signature: "synthetic" } });
				sse(res, "content_block_stop", { type: "content_block_stop", index });
			};
			await think(0, thought, 1);
			// A pause between the blocks, so the page draws the first one ended before the second joins it.
			if (/\btwice\b/.test(asked)) await sleep(800).then(() => think(1, thought2, 1000));
			if (/\bthen a step\b/.test(asked)) {
				sse(res, "content_block_start", { type: "content_block_start", index: 1, content_block: { type: "tool_use", id: `toolu_think_${Date.now()}`, name: "bash", input: {} } });
				sse(res, "content_block_delta", { type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: JSON.stringify({ command: "sleep 1" }) } });
				sse(res, "content_block_stop", { type: "content_block_stop", index: 1 });
				end("tool_use");
				return;
			}
		}
		if (res.destroyed) return;
		await Promise.race([answer.promise, timeout(30_000)]);
		words(/\btwice\b/.test(asked) ? 2 : 1);
		end("end_turn");
	});
});

async function waitUntil(predicate: () => Promise<boolean> | boolean, label: string, timeoutMs = 20_000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (await predicate()) return;
		await new Promise((resolve) => setTimeout(resolve, 100));
	}
	throw new Error(`timed out waiting until ${label}`);
}
const squash = (text: string) => text.replace(/\s+/g, " ").trim();

let server: ChildProcessWithoutNullStreams | undefined;
const serverOutput: string[] = [];
const failures: string[] = [];
const expect = (condition: unknown, message: string) => {
	if (!condition) failures.push(message);
	console.log(`${condition ? "  ok  " : "FAIL  "}${message}`);
};

try {
	await new Promise<void>((resolve) => endpoint.listen(0, "127.0.0.1", resolve));
	const endpointUrl = `http://127.0.0.1:${(endpoint.address() as AddressInfo).port}`;
	fs.writeFileSync(path.join(agentDir, "models.json"), JSON.stringify({ providers: { [KEY_PROVIDER]: { baseUrl: endpointUrl } } }, null, 2), { mode: 0o600 });
	fs.writeFileSync(path.join(agentDir, "auth.json"), JSON.stringify({ [KEY_PROVIDER]: { type: "api_key", key: "synthetic-anthropic-key" } }, null, 2), { mode: 0o600 });
	fs.writeFileSync(path.join(agentDir, "settings.json"), JSON.stringify({ retry: { enabled: false, baseDelayMs: 1000, provider: { maxRetries: 0 } } }, null, 2), { mode: 0o600 });
	const workspaceRoot = path.join(tempRoot, "workspace");
	fs.mkdirSync(workspaceRoot, { recursive: true, mode: 0o700 });
	const agents = await import("../src/persistent-agents.js");
	const roomId = agents.createPersistentAgentFromScaffoldInput({ displayName: "Thinking Room", userName: "Synthetic User", preferredUserAddress: "Synthetic User" }).agent.agentId;
	server = spawn("npx", ["tsx", "src/index.ts"], {
		shell: process.platform === "win32",
		...SMOKE_SERVER_SPAWN_TREE_OPTIONS,
		cwd: webServerDir,
		env: smokeHomeEnv(tempHome, { PORT: String(port), ...SMOKE_SERVER_AUTH_ENV, EXXETA_HOME: repoRoot, EXXPERTS_CODING_AGENT_DIR: agentDir, EXXETA_PERSISTENT_AGENTS_ROOT: agentsRoot }) as NodeJS.ProcessEnv,
	});
	server.stdout.on("data", (chunk) => serverOutput.push(String(chunk)));
	server.stderr.on("data", (chunk) => serverOutput.push(String(chunk)));
	await waitUntil(() => fetch(`${baseUrl}/healthz`).then((r) => r.ok).catch(() => false), "server ready", 60_000);
	const put = (pathname: string, body: unknown) => authedFetch(`${baseUrl}${pathname}`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
	assert((await put("/api/persistent-agent-ai-profiles/custom", { providerId: KEY_PROVIDER, label: "Claude API key", roomModels: [ON_KEY.model], learnModel: ON_KEY.model })).ok, "the key's model is approved");
	assert((await put(`/api/persistent-agents/${roomId}/models`, { conversation: ON_KEY })).ok, "the room picks the key's model");
	assert((await put(`/api/persistent-agents/${roomId}/workspace-default`, { root: workspaceRoot, displayLabel: "Thinking Workspace", workspaceAccessMode: "localFiles", bashEnabled: true })).ok, "the room's folder is set");

	const browser = await chromium.launch();
	try {
		const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
		// Page functions are sent as source; the loader names inner functions with __name, which the page defines.
		await context.addInitScript("globalThis.__name = (fn) => fn;");
		// The page's newest socket, so a scene can hand it two frames in one task, as a busy page takes frames that arrived together.
		await context.addInitScript("{ const Native = WebSocket; globalThis.WebSocket = class extends Native { constructor(...args) { super(...args); globalThis.__roomSocket = this; } }; }");
		const page = await context.newPage();
		// The room's socket, passed through, to know when its connection is ready and to hand the page a frame of its own.
		let readies = 0;
		let toPage = (_frame: unknown) => {};
		// While set, a turn's end and every frame after it are held until the message it hands back, then handed to the
		// page in one task, in order, as a busy page takes frames that arrived together; later frames wait for that.
		const together = { on: false, held: null as string[] | null, pending: null as string[] | null };
		await page.routeWebSocket(/\/ws\?/, (ws) => {
			const upstream = ws.connectToServer();
			toPage = (frame) => ws.send(JSON.stringify(frame));
			ws.onMessage((message) => upstream.send(message));
			upstream.onMessage((message) => {
				const text = String(message);
				if (text.includes('"type":"ready"')) readies += 1;
				if (together.pending) {
					together.pending.push(text);
					return;
				}
				if (together.held) {
					together.held.push(text);
					if (!text.includes('"type":"prompt_returned"')) return;
					const frames = together.held;
					const after: string[] = [];
					together.held = null;
					together.pending = after;
					void page.evaluate((both) => {
						const socket = (globalThis as any).__roomSocket as WebSocket;
						for (const data of both) socket.dispatchEvent(new MessageEvent("message", { data }));
					}, frames).finally(() => {
						together.pending = null;
						for (const frame of after) ws.send(frame);
					});
					return;
				}
				if (together.on && text.includes('"type":"agent_end"')) {
					together.held = [text];
					return;
				}
				ws.send(message);
			});
			upstream.onClose((code, reason) => ws.close({ code, reason }));
			ws.onClose(() => upstream.close());
		});
		await page.goto(`${baseUrl}/auth/session?token=${SMOKE_AUTH_TOKEN}`);
		await page.waitForLoadState("networkidle");
		const enterRoom = async (on: Page) => {
			const before = readies;
			const dismiss = on.locator(".whats-new-close");
			if (await dismiss.count()) await dismiss.click();
			await on.locator(".persistent-agent-card").filter({ hasText: "Thinking Room" }).getByRole("button", { name: /^(Enter|Resume)$/ }).click();
			await on.locator(".composer-box textarea").waitFor({ timeout: 15_000 });
			await waitUntil(() => readies > before, "the room's connection is ready");
		};
		await enterRoom(page);
		const composer = page.locator(".composer-box textarea");
		const idle = async () => (await page.locator(".composer-box .stop-btn").count()) === 0 && (await composer.getAttribute("placeholder"))?.startsWith("Ask ") === true;
		const ask = async (text: string) => {
			thought = hold();
			thought2 = hold();
			answer = hold();
			await composer.fill(text);
			await composer.press("Enter");
			await waitUntil(async () => !(await idle()), `"${text}" is being answered`);
		};
		const answered = async () => {
			thought.release();
			thought2.release();
			answer.release();
			await waitUntil(async () => endpointState.open === 0 && (await idle()), "the room is idle", 30_000);
		};
		const textOf = async (selector: string) => squash(await page.locator(selector).last().innerText().catch(() => ""));
		// One question's turn: its bubble and all that answers it, so a scene never reads an earlier scene's rows.
		const turnOf = (question: string) => page.locator(".transcript-turn").filter({ has: page.locator(".bubble.user", { hasText: question }) }).last();
		// The open box's scroll: how far it is from its end, and how much it holds.
		const scrollOf = (selector: string) => page.locator(selector).last().evaluate((box) => ({ fromEnd: Math.round(box.scrollHeight - box.scrollTop - box.clientHeight), top: Math.round(box.scrollTop), overflows: box.scrollHeight > box.clientHeight + 8 }));
		// Words a person can see: each element that holds words is coloured, or draws them with a gradient clipped to the text.
		const seen = (selector: string) => page.locator(selector).last().evaluate((root) => {
			const holders = [root, ...root.querySelectorAll("*")].filter((el) => [...el.childNodes].some((node) => node.nodeType === Node.TEXT_NODE && node.textContent?.trim()));
			return holders.length > 0 && holders.every((el) => {
				const style = getComputedStyle(el);
				const clear = style.color === "rgba(0, 0, 0, 0)" || style.color === "transparent";
				return !clear || (style.backgroundImage !== "none" && /text/.test(style.backgroundClip || (style as any).webkitBackgroundClip || ""));
			});
		});
		// The block at the top of a scroll box, and how far into it the box is, as a share of it.
		const passageOf = (selector: string) => page.locator(selector).last().evaluate((box) => {
			let el: Element = box;
			while (el.children.length === 1) el = el.children[0];
			const top = box.getBoundingClientRect().top;
			for (const block of [...el.children] as HTMLElement[]) {
				const rect = block.getBoundingClientRect();
				if (rect.bottom > top + 1) return { text: (block.textContent ?? "").trim().slice(0, 60), into: Math.round(((top - rect.top) / rect.height) * 100) / 100 };
			}
			return { text: "", into: 0 };
		});
		// Allow the card's ask until `until` holds.
		const allowAll = async (until: () => Promise<boolean>, label: string) => {
			const allow = page.locator(".wk-ask .wk-btn.primary").last();
			await waitUntil(async () => {
				if (await until()) return true;
				if (await allow.count()) await allow.click().catch(() => {});
				return false;
			}, label, 30_000);
		};
		const grows = async (selector: string, label: string) => {
			const before = (await textOf(selector)).length;
			await waitUntil(async () => (await textOf(selector)).length > before + 20, label, 5000);
		};

		// The page drawn anew: the room it was in comes back, or is entered again from home.
		const reload = async () => {
			const before = readies;
			await page.reload();
			const card = page.locator(".persistent-agent-card").filter({ hasText: "Thinking Room" });
			await waitUntil(async () => (await composer.count()) > 0 || (await card.count()) > 0, "the page is back", 15_000);
			if (!(await composer.count())) await enterRoom(page);
			else await waitUntil(() => readies > before, "the room's connection is ready again");
		};
		// A folded card draws no rows: the turn's last card is opened to read them.
		const openCard = async (turn: ReturnType<Page["locator"]>) => {
			const card = turn.locator(".wk-card").last();
			if ((await card.getAttribute("data-open")) !== "1") await card.locator("button.wk-head").click();
		};

		const only = process.env.SMOKE_SCENES ? new Set(process.env.SMOKE_SCENES.split(",")) : null;
		const scene = async (name: string, run: () => Promise<void>) => {
			if (only && !only.has(name)) return;
			try {
				await run();
			} catch (error) {
				expect(false, `scene ${name}: ${(error as Error).message.split("\n")[0]}`);
				if (process.env.SMOKE_SHOTS) await page.screenshot({ path: path.join(process.env.SMOKE_SHOTS, `thinking-open-${name}.png`) }).catch(() => {});
			}
			await answered().catch(() => {});
		};

		// The thinking line, with nothing beside it.
		const thinkingLine = async (row: { live: string; head: string; open: string; done: string }) => {
			const look = "thinking line";
			await ask("Please think about the bucket.");
			const live = page.locator(row.live).last();
			await live.waitFor({ timeout: 10_000 });
			// A while of thinking, its words arriving all along: none of them may show.
			await page.waitForTimeout(1200);
			const shown = await textOf(row.live);
			expect(shown.includes("Thinking") && !shown.includes(PIECE_WORD) && !shown.includes("**"), `${look}: while it thinks only "Thinking" and its timer show (got ${JSON.stringify(shown.slice(0, 80))})`);
			const head = page.locator(row.head).last();
			expect(await seen(row.head), `${look}: the live label can be seen`);
			await head.click();
			await page.locator(row.open).last().waitFor({ timeout: 3000 });
			const opened = await textOf(row.open);
			expect(opened.includes(`${PIECE_WORD} option 1`) && !opened.includes("**"), `${look}: a click while it thinks opens the whole thought, as Markdown (got ${JSON.stringify(opened.slice(0, 80))})`);
			await grows(row.open, "the open thought grows");
			expect(true, `${look}: the open thought grows while it thinks`);
			await waitUntil(async () => (await scrollOf(row.open)).overflows, "the thought fills its box", 15_000);
			await grows(row.open, "the thought grows past its box");
			const pinned = await scrollOf(row.open);
			expect(pinned.fromEnd <= 8, `${look}: the open thought keeps its newest line in view (${pinned.fromEnd} px from the end)`);
			await page.locator(row.open).last().evaluate((box) => { box.scrollTop = 0; box.dispatchEvent(new Event("scroll")); });
			await grows(row.open, "the thought grows while scrolled up");
			const up = await scrollOf(row.open);
			expect(up.top <= 8, `${look}: scrolled up, the person stays where they read (scrollTop ${up.top})`);
			thought.release();
			await waitUntil(async () => (await textOf(row.done)).includes("Thought for"), "the thinking ends", 10_000);
			expect((await page.locator(row.open).count()) > 0 && (await textOf(row.open)).includes(PIECE_WORD), `${look}: open stays open when it reads "Thought for N s"`);
			await answered();
			// Opened again after it ended: at its very top, the first line clear of the box's fading edge.
			const doneHead = page.locator(row.done).last();
			await doneHead.click();
			await waitUntil(async () => (await page.locator(row.open).count()) === 0, "the thought closes", 3000);
			await doneHead.click();
			await page.locator(row.open).last().waitFor({ timeout: 3000 });
			await page.waitForTimeout(300);
			const reopened = await scrollOf(row.open);
			expect(reopened.overflows && reopened.top === 0, `${look}: a finished thought opens at its very top (scrollTop ${reopened.top})`);
		};

		await scene("line", () => thinkingLine({ live: '.wk-thought[data-live="1"]', head: '.wk-thought[data-live="1"] button.wk-head', open: ".wk-thought .wk-full", done: ".wk-thought .wk-head" }));

		// Scrolled up in an open live thought, the box fits its words for a moment (a wider window): the person still reads where they were.
		await scene("fits", async () => {
			const question = "Please think it through, then fit.";
			const turn = turnOf(question);
			await ask(question);
			const head = turn.locator('.wk-thought[data-live="1"] button.wk-head').last();
			await head.waitFor({ timeout: 10_000 });
			await head.click();
			const box = ".wk-thought .wk-full";
			await waitUntil(async () => (await scrollOf(box)).overflows, "the thought fills its box", 15_000);
			// Halfway up, so the box's clamp when it fits moves it. Its scroll event goes at once, as a wheel's many do,
			// so a growth landing before the browser's own event cannot pin the box first.
			await page.locator(box).last().evaluate((el) => { el.scrollTop = Math.floor((el.scrollHeight - el.clientHeight) / 2); el.dispatchEvent(new Event("scroll")); });
			await waitUntil(async () => { const at = await scrollOf(box); return at.top > 8 && at.fromEnd > 8; }, "the person scrolled halfway up", 3000);
			// The box grows to fit everything (the browser's own scroll to 0 follows), then takes its height back.
			await page.locator(box).last().evaluate((el) => { (el as HTMLElement).style.maxHeight = "none"; });
			await waitUntil(async () => !(await scrollOf(box)).overflows, "the box fits its words", 3000);
			await page.locator(box).last().evaluate((el) => { (el as HTMLElement).style.maxHeight = ""; });
			await grows(box, "the thought grows on");
			await grows(box, "the thought grows on again");
			const at = await scrollOf(box);
			expect(at.fromEnd > 8, `a box that fitted for a moment keeps the person where they read, not at the newest line (scrollTop ${at.top}, ${at.fromEnd} px from the end)`);
			await answered();
		});

		// A thought of one long paragraph, scrolled halfway up while it grows: the person stays where they read.
		await scene("paragraph", async () => {
			await ask("Please think in one paragraph.");
			const head = page.locator('.wk-thought[data-live="1"] button.wk-head').last();
			await head.waitFor({ timeout: 10_000 });
			await head.click();
			await waitUntil(async () => (await scrollOf(".wk-thought .wk-full")).overflows && (await page.locator(".wk-thought .wk-full").last().evaluate((box) => box.scrollHeight > box.clientHeight * 2)), "the paragraph fills its box twice", 30_000);
			const set = await page.locator(".wk-thought .wk-full").last().evaluate((box) => { box.scrollTop = Math.round((box.scrollHeight - box.clientHeight) / 2); box.dispatchEvent(new Event("scroll")); return box.scrollTop; });
			// Grows by a whole box more: a share of the growing paragraph would carry the person down with it.
			const tall = await page.locator(".wk-thought .wk-full").last().evaluate((box) => box.scrollHeight + box.clientHeight);
			await waitUntil(() => page.locator(".wk-thought .wk-full").last().evaluate((box, tall) => box.scrollHeight >= tall, tall), "the paragraph grows by a box while scrolled halfway", 30_000);
			const after = await scrollOf(".wk-thought .wk-full");
			expect(Math.abs(after.top - set) <= 8, `one paragraph, scrolled halfway while it grows by a box: the person stays where they read (set ${set}, now ${after.top})`);
			await answered();
		});

		// A diagram drawn after its words, at the end of an open live thought: the box stays at its newest line.
		await scene("diagram", async () => {
			await ask("Please think with a diagram.");
			const head = page.locator('.wk-thought[data-live="1"] button.wk-head').last();
			await head.waitFor({ timeout: 10_000 });
			await head.click();
			await waitUntil(async () => (await page.locator(".wk-thought .wk-full svg").count()) > 0, "the diagram is drawn", 20_000);
			await waitUntil(async () => (await scrollOf(".wk-thought .wk-full")).fromEnd <= 8, "the box is at its newest line", 3000).catch(() => {});
			const end = await scrollOf(".wk-thought .wk-full");
			expect(end.overflows && end.fromEnd <= 8, `a diagram drawn after its words: the open live thought stays at its newest line (${end.fromEnd} px from the end)`);
			await answered();
		});

		// Enter and Space on the head while it thinks.
		await scene("keys", async () => {
			await ask("Please think, keys only.");
			const head = page.locator('.wk-thought[data-live="1"] button.wk-head').last();
			await head.waitFor({ timeout: 10_000 });
			await head.focus();
			await page.keyboard.press("Enter");
			await waitUntil(async () => (await head.getAttribute("aria-expanded")) === "true", "Enter opens it", 3000);
			await page.keyboard.press("Space");
			await waitUntil(async () => (await head.getAttribute("aria-expanded")) === "false", "Space closes it", 3000);
			expect((await page.locator('.wk-thought[data-live="1"] .wk-full').count()) === 0, "Enter opens the live thought and Space closes it");
		});

		// Thinking after a step: a row of the work card.
		await scene("card", async () => {
			await ask("Please run a step, then think about it.");
			const allow = page.locator(".wk-ask .wk-btn.primary").last();
			const rowHead = page.locator('.wk-card .wk-row[data-s="running"] button.wk-open').last();
			await waitUntil(async () => (await allow.count()) > 0 || (await rowHead.count()) > 0, "the step asks or the thinking starts", 15_000);
			if (await allow.count()) await allow.click();
			await rowHead.waitFor({ timeout: 15_000 });
			// A while of thinking, its words arriving all along: none of them may show.
			await page.waitForTimeout(1200);
			expect(await seen('.wk-card .wk-row[data-s="running"] button.wk-open'), "work card: the live row's \"Thinking\" can be seen");
			const card = await textOf(".wk-card");
			expect(card.includes("Thinking") && !card.includes(PIECE_WORD), `work card: the thinking row shows "Thinking" and none of its words (got ${JSON.stringify(card.slice(0, 120))})`);
			await rowHead.click();
			await page.locator(".wk-card .wk-out-thought").last().waitFor({ timeout: 3000 });
			await grows(".wk-card .wk-out-thought", "the row's open thought grows");
			expect(true, "work card: a click on the live row opens the thought and it grows");
			thought.release();
			await waitUntil(async () => (await textOf(".wk-card .wk-row .wk-open")).startsWith("Thought for"), "the row's thinking ends", 10_000);
			expect((await textOf(".wk-card .wk-out-thought")).includes(PIECE_WORD), "work card: the open row stays open when it reads \"Thought for N s\"");
			answer.release();
			await waitUntil(async () => endpointState.open === 0 && (await idle()) && (await textOf(".messages")).includes("Here is the answer."), "the answer is written", 15_000);
			const shown = await page.locator(".wk-card").last().getAttribute("data-open");
			expect(shown === "1" && (await page.locator(".wk-card .wk-out-thought").last().isVisible()), `work card: the answer does not fold the card over the open thought (card open: ${shown})`);
			// Away and back: the room is drawn anew from the saved conversation, which keeps no thinking, as after a reload.
			await page.getByText("Home", { exact: true }).first().click();
			await page.locator(".persistent-agent-card").filter({ hasText: "Thinking Room" }).waitFor({ timeout: 10_000 });
			await enterRoom(page);
			await page.locator(".wk-card").last().waitFor({ timeout: 10_000 });
			const back = turnOf("Please run a step, then think about it.");
			await waitUntil(async () => squash(await back.innerText().catch(() => "")).includes("Here is the answer."), "the answer is back", 10_000);
			await openCard(back);
			const rows = squash(await back.locator(".wk-card").last().innerText());
			expect(rows.includes("sleep 1") && !/Thought|Thinking/.test(rows) && (await back.locator(".wk-out-thought, .wk-thought").count()) === 0, `work card: after leaving and resuming the room, the card keeps its step and shows no thinking, as after a reload (got ${JSON.stringify(rows.slice(0, 160))})`);
		});

		// Seven steps after an open thought in one stretch: the row cap folds earlier rows, never the open thought.
		await scene("cap", async () => {
			const question = "Please think, then run seven steps.";
			const turn = turnOf(question);
			await ask(question);
			const head = page.locator('.wk-thought[data-live="1"] button.wk-head').last();
			await head.waitFor({ timeout: 10_000 });
			await head.click();
			thought.release();
			await allowAll(async () => (await page.locator(".wk-card .wk-row").count()) >= 7 && (await page.locator(".wk-ask").count()) === 0 && endpointState.open > 0, "the seven steps ran");
			const capButton = turn.locator(".wk-card .wk-more");
			await waitUntil(async () => (await capButton.count()) > 0, "the cap folds the earlier rows", 3000).catch(() => {});
			const more = squash(await capButton.last().innerText().catch(() => ""));
			expect(more.length > 0 && (await turn.locator(".wk-card .wk-out-thought").last().isVisible().catch(() => false)), `the row cap leaves this turn's open thought on screen (fold: ${JSON.stringify(more)})`);
		});


		// An open thought, scrolled up, whose stretch turns into a work card when a step follows: the box keeps where the person read.
		await scene("regroup", async () => {
			await ask("Please think, then a step.");
			const head = page.locator('.wk-thought[data-live="1"] button.wk-head').last();
			await head.waitFor({ timeout: 10_000 });
			await head.click();
			// Long enough that block 12 can reach the top of either box.
			await waitUntil(() => page.locator(".wk-thought .wk-full").last().evaluate((box) => box.children.length >= 40), "the thought is long", 20_000);
			// Halfway into a block far down the thought: a pixel offset carried over to the card's narrower box would land elsewhere.
			await page.locator(".wk-thought .wk-full").last().evaluate((box) => {
				let el: Element = box;
				while (el.children.length === 1) el = el.children[0];
				const block = el.children[12] as HTMLElement;
				box.scrollTop = block.getBoundingClientRect().top - box.getBoundingClientRect().top + box.scrollTop + block.offsetHeight / 2;
				box.dispatchEvent(new Event("scroll"));
			});
			const before = await passageOf(".wk-thought .wk-full");
			thought.release();
			const row = page.locator(".wk-card .wk-out-thought").last();
			await row.waitFor({ timeout: 10_000 });
			const same = (at: Awaited<ReturnType<typeof passageOf>>) => at.text === before.text && Math.abs(at.into - before.into) < 0.2;
			await waitUntil(async () => same(await passageOf(".wk-card .wk-out-thought")), "the row shows the passage", 3000).catch(() => {});
			const after = await passageOf(".wk-card .wk-out-thought");
			expect(same(after), `an open thought that becomes a card's row keeps the passage the person read (${JSON.stringify(before)} then ${JSON.stringify(after)})`);
			const allow = page.locator(".wk-ask .wk-btn.primary").last();
			if (await allow.count()) await allow.click();
		});

		// A NUL in a provider's thinking is a character of the thought, not a break between two.
		await scene("nul", async () => {
			const question = "Please think with a nul.";
			const turn = turnOf(question);
			await ask(question);
			const head = turn.locator('.wk-thought[data-live="1"] button.wk-head').last();
			await head.waitFor({ timeout: 10_000 });
			await head.click();
			const full = turn.locator(".wk-thought .wk-full").last();
			await waitUntil(async () => squash(await full.innerText().catch(() => "")).includes("after the mark"), "the words after the mark show", 10_000);
			expect((await full.locator("hr.thought-break").count()) === 0, `a NUL in the thinking keeps one thought (${await full.locator("hr.thought-break").count()} breaks)`);
			await answered();
		});

		// Scrolled up in an open thought, a second thinking block joins it: it does not pull the person back to the end.
		await scene("joined", async () => {
			await ask("Please think twice.");
			const head = page.locator('.wk-thought[data-live="1"] button.wk-head').last();
			await head.waitFor({ timeout: 10_000 });
			await head.click();
			await waitUntil(async () => (await scrollOf(".wk-thought .wk-full")).overflows, "the thought fills its box", 15_000);
			await page.locator(".wk-thought .wk-full").last().evaluate((box) => { box.scrollTop = 0; box.dispatchEvent(new Event("scroll")); });
			thought.release();
			await waitUntil(async () => (await textOf(".wk-thought .wk-full")).includes(`${PIECE_WORD} option 1001`), "the second block joins the row", 10_000);
			await grows(".wk-thought .wk-full", "the joined thought grows");
			const at = await scrollOf(".wk-thought .wk-full");
			expect(at.top <= 8, `a second thinking block leaves the person where they read (scrollTop ${at.top})`);
		});

		// Two thinking blocks in a row, the first ending inside a diagram fence it never closes: the second's words still show.
		await scene("fence", async () => {
			await ask("Please think twice, with an open fence.");
			const head = page.locator('.wk-thought[data-live="1"] button.wk-head').last();
			await head.waitFor({ timeout: 10_000 });
			await head.click();
			thought.release();
			await waitUntil(() => endpointState.open > 0 && page.locator(".wk-thought .thought-break").count().then((count) => count > 0), "the second block joins the row", 10_000).catch(() => {});
			await waitUntil(async () => (await textOf(".wk-thought .wk-full")).includes(`${PIECE_WORD} option 1001`), "the second block's words show", 5000).catch(() => {});
			expect((await textOf(".wk-thought .wk-full")).includes(`${PIECE_WORD} option 1001`), `a fence the first block left open does not hide the second block's words (got …${JSON.stringify((await textOf(".wk-thought .wk-full")).slice(-80))})`);
		});

		// A block with no words: the label alone, live and done.
		await scene("wordless", async () => {
			await ask("Please answer quietly.");
			const live = page.locator('.wk-thought[data-live="1"]').last();
			await live.waitFor({ timeout: 10_000 });
			// Past a second: an empty block that ends sooner is dropped, not shown.
			await page.waitForTimeout(1500);
			expect((await live.locator("button").count()) === 0 && (await textOf('.wk-thought[data-live="1"]')).startsWith("Thinking"), "no words, while it thinks: the label alone, not a button");
			thought.release();
			await waitUntil(async () => (await textOf(".wk-thought .wk-head")).startsWith("Thought for"), "the quiet block ends", 10_000);
			expect((await page.locator(".wk-thought").last().locator("button").count()) === 0, "no words, done: the label alone, not a button");
		});

		// Text the model wrote before a step, or before thinking, is drawn above it: "Looking first." above the first step,
		// "Next part." under it and above the second stretch's thinking and step. Checked while that thinking runs and at the end.
		const leadsInOrder = async (steps: string, rows: string) => {
			const look = "two stretches";
			const question = "Please work in two stretches, in order.";
			const order = () => page.evaluate(({ steps, rows, question }) => {
				const all = [...document.querySelectorAll(".messages *")];
				const asked = all.indexOf([...document.querySelectorAll(".bubble.user")].filter((el) => el.textContent?.includes(question)).pop() as Element);
				const leaf = (text: string) => all.findIndex((el, index) => index > asked && el.children.length === 0 && (el.textContent ?? "").includes(text));
				const mine = (selector: string) => [...document.querySelectorAll(selector)].map((el) => all.indexOf(el)).filter((index) => index > asked);
				const thoughts = [...document.querySelectorAll(rows)].filter((el) => /^[✓…]?\s*(Thought|Thinking)/.test((el.textContent ?? "").trim())).map((el) => all.indexOf(el)).filter((index) => index > asked);
				return { first: leaf("Looking first."), second: leaf("Next part."), steps: mine(steps), thought: thoughts.pop() ?? -1 };
			}, { steps, rows, question });
			const inOrder = (o: Awaited<ReturnType<typeof order>>) => o.first >= 0 && o.steps.length > 0 && o.first < o.steps[0] && o.second > o.steps[0] && o.second < o.thought && (o.steps.length < 2 || o.second < o.steps[1]);
			await ask(question);
			await allowAll(async () => (await page.locator(".wk-ask .wk-btn.primary").count()) === 0 && (await textOf(".messages")).includes("Next part.") && endpointState.open > 0, "the second stretch thinks");
			await waitUntil(async () => inOrder(await order()), "each note sits above its step and thinking", 3000).catch(() => {});
			const live = await order();
			expect(inOrder(live), `${look}, while the second stretch thinks: each note above its own step and thinking (${JSON.stringify(live)})`);
			thought.release();
			await allowAll(async () => endpointState.open > 0 && endpointState.steps === 2, "the second step ran");
			answer.release();
			await waitUntil(async () => endpointState.open === 0 && (await idle()) && (await textOf(".messages")).includes("Here is the answer."), "the answer is written", 20_000);
			// A long turn folds into one card: opened, it shows the turn as it ran.
			const fold = page.locator('.wk-turn > button.wk-head[aria-expanded="false"]').last();
			if (await fold.count()) await fold.click();
			const done = await order();
			expect(inOrder(done) && done.steps.length === 2, `${look}, done: each note above its own step and thinking (${JSON.stringify(done)})`);
		};
		// Two cards in one turn fold into one card when it ends, but not over an open thought.
		await scene("long", async () => {
			const question = "Please work in two stretches.";
			const turn = turnOf(question);
			await ask(question);
			const head = page.locator('.wk-thought[data-live="1"] button.wk-head').last();
			await allowAll(async () => (await head.count()) > 0, "the second stretch thinks");
			await head.click();
			thought.release();
			await allowAll(async () => endpointState.open > 0 && endpointState.steps === 2, "the second step ran");
			answer.release();
			await waitUntil(async () => endpointState.open === 0 && (await idle()) && (await textOf(".messages")).includes("Here is the answer."), "the answer is written", 15_000);
			expect(await turn.locator(".wk-out-thought").last().isVisible().catch(() => false), `the long turn's fold leaves this turn's open thought on screen (folded turns: ${await turn.locator(".wk-turn").count()})`);
		});

		// A finished turn folded into one card, opened, a thought opened in it, then folded by the person: the next message leaves it folded.
		await scene("worked-folded", async () => {
			const question = "Please work in two stretches, then fold.";
			const turn = turnOf(question);
			await ask(question);
			// The second stretch's thought has words to open before it is let go.
			await allowAll(async () => (await turn.locator('.wk-thought[data-live="1"] button.wk-head').count()) > 0, "the second stretch thinks");
			thought.release();
			await allowAll(async () => endpointState.open > 0 && endpointState.steps === 2, "the second step ran");
			answer.release();
			await waitUntil(async () => endpointState.open === 0 && (await idle()) && (await turn.locator(".wk-turn").count()) === 1, "the turn folds into one card", 15_000);
			const worked = turn.locator(".wk-turn > button.wk-head");
			// Opened, the turn's head keeps its mark's place, so its time lines up with its cards' times under it.
			const timesLineUp = async () => {
				await worked.click();
				const rights = await turn.locator(".wk-card .wk-head .wk-time").evaluateAll((times) => times.map((time) => Math.round(time.getBoundingClientRect().right)));
				await worked.click();
				return rights.length >= 2 && rights.every((right) => Math.abs(right - rights[0]) <= 1) ? "" : JSON.stringify(rights);
			};
			const misaligned = await timesLineUp();
			expect(misaligned === "", `an opened turn's time lines up with its cards' times (right edges ${misaligned})`);
			const head = squash((await worked.textContent()) ?? "");
			expect(!/Worked/.test(squash(await turn.innerText())) && /^Ran 2 commands\s*\d/.test(head) && (await worked.locator(".wk-ok").count()) === 1 && (await worked.locator(".wk-stack").count()) === 1, `a folded turn is the card a folded stretch is: its steps' icon, what they did, the time and the check, no Worked for (head ${JSON.stringify(head)})`);
			await worked.click();
			const card = turn.locator(".wk-turnwork .wk-card").filter({ has: page.locator(".wk-row button.wk-open", { hasText: /^Thought/ }) }).last();
			await card.locator("button.wk-head").click();
			// Opened, a card's rows carry their own marks, so its head gives up the mark's place and its time lines up with the rows' times.
			const rowRights = await card.locator(".wk-head .wk-time, .wk-row .wk-meta").evaluateAll((times) => times.map((time) => Math.round(time.getBoundingClientRect().right)));
			expect(rowRights.length >= 2 && rowRights.every((right) => Math.abs(right - rowRights[0]) <= 1), `an opened card's time lines up with its rows' times (right edges ${JSON.stringify(rowRights)})`);
			await card.locator(".wk-row button.wk-open").filter({ hasText: /^Thought/ }).last().click();
			await card.locator(".wk-out-thought").last().waitFor({ timeout: 3000 });
			await worked.click();
			await ask("Keep it short.");
			await answered();
			const folded = await worked.getAttribute("aria-expanded").catch(() => null);
			expect(folded === "false" && !(await turn.locator(".wk-out-thought").last().isVisible().catch(() => false)), `a folded turn the person folded over an open thought stays folded after the next message (aria-expanded ${folded}, folded turns ${await turn.locator(".wk-turn").count()})`);
		});
		// The folded turn is a card too: the steps are the stretches' own cards.
		await scene("order", () => leadsInOrder(".wk-card:not(.wk-turn)", ".wk-thought, .wk-card .wk-row"));

		// A step the model is still writing: its row shows at once, before the call is whole, then runs.
		await scene("writing", async () => {
			const question = "Please write a step slowly.";
			const turn = turnOf(question);
			await ask(question);
			const writing = turn.locator('.wk-card .wk-row[data-s="writing"]');
			await writing.first().waitFor({ timeout: 10_000 });
			const words = squash((await writing.first().locator(".wk-tx").textContent()) ?? "");
			expect(words.startsWith("Command"), `a step being written shows its row at once, reading "Command" (got ${JSON.stringify(words)})`);
			thought.release();
			await allowAll(async () => (await writing.count()) === 0 && endpointState.open > 0 && endpointState.steps === 1, "the written step ran");
			answer.release();
			await waitUntil(async () => endpointState.open === 0 && (await idle()) && squash(await turn.innerText()).includes("Here is the answer."), "the answer is written", 15_000);
			// Run, it is a card of one step that worked: opened, it shows the command it ran, with no row repeating the head.
			await openCard(turn);
			const ran = squash((await turn.locator(".wk-solo .wk-command").textContent().catch(() => null)) ?? "");
			expect((await writing.count()) === 0 && (await turn.locator(".wk-card .wk-row").count()) === 0 && ran === "echo slow", `the written step, once run, opens to the command it ran (command ${JSON.stringify(ran)}, turn ${JSON.stringify(squash(await turn.innerText()).slice(0, 200))})`);
			// No row carries its mark, so its head keeps the check while open.
			expect((await turn.locator(".wk-card .wk-head .wk-ok").count()) === 1, `an opened card of one step keeps its check on its head (checks ${await turn.locator(".wk-card .wk-head .wk-ok").count()})`);
		});

		// The provider's own search: a step between the words before it and the answer, also after a reload.
		await scene("search", async () => {
			const question = "Please search the web for the node release.";
			const turn = turnOf(question);
			const row = turn.locator(".wk-row").filter({ hasText: /the web/ });
			const words = async () => squash((await row.last().locator(".wk-tx").textContent()) ?? "");
			// Where the lead, the search's row and the answer sit in the turn, in document order.
			const order = () => turn.evaluate((el, texts) => {
				const all = [...el.querySelectorAll("*")];
				const leaf = (text: string) => all.findIndex((node) => node.children.length === 0 && (node.textContent ?? "").includes(text));
				const step = all.findIndex((node) => (node.classList.contains("wk-row") || node.classList.contains("wk-head")) && /the web/.test(node.textContent ?? ""));
				return { lead: leaf(texts.lead), step, answer: leaf(texts.answer) };
			}, { lead: SEARCH_LEAD, answer: SEARCH_ANSWER });
			await ask(question);
			await row.first().waitFor({ timeout: 10_000 });
			const live = await words();
			expect(/^Searching the web for “?node lts/.test(live) && (await row.last().getAttribute("data-s")) === "running", `while the provider searches, its row reads what it searches for (got ${JSON.stringify(live)})`);
			const liveAt = await order();
			expect(liveAt.lead >= 0 && liveAt.step > liveAt.lead, `while it searches, the search sits under the words before it (${JSON.stringify(liveAt)})`);
			thought.release();
			await waitUntil(async () => endpointState.open === 0 && (await idle()) && squash(await turn.innerText()).includes(SEARCH_ANSWER), "the answer is written", 15_000);
			// Done, the card of its one search says what it searched for, and with no pages kept it has nothing to open.
			const done = async (when: string) => {
				const card = turn.locator(".wk-card").last();
				const said = squash((await card.locator(".wk-head").textContent()) ?? "");
				expect(/^Searched the web for “?node lts/.test(said) && (await card.locator("button").count()) === 0 && (await card.getAttribute("data-open")) === "0", `${when}, the search's card reads what it searched for and does not open (got ${JSON.stringify(said)})`);
				const at = await order();
				expect(at.lead >= 0 && at.step > at.lead && at.answer > at.step, `${when}, the search sits between the words before it and the answer (${JSON.stringify(at)})`);
			};
			await done("done");
			await reload();
			await waitUntil(async () => squash(await turn.innerText().catch(() => "")).includes(SEARCH_ANSWER), "the answer is back", 10_000);
			await done("after a reload");
		});

		// A message whose turn thought, or began the provider's search, and then failed before any text goes back to the box, its bubble gone, with one line.
		await scene("handed-back", async () => {
			for (const [question, did] of [["Please think, then fail.", "thought"], ["Please search, then fail.", "began the provider's search"]]) {
				await ask(question);
				await waitUntil(async () => endpointState.open === 0 && (await idle()) && (await composer.inputValue()) === question, "the message is back in the box", 20_000).catch(() => {});
				const bubbles = await page.locator(".bubble.user").filter({ hasText: question }).count();
				expect((await composer.inputValue()) === question && bubbles === 0, `a message whose turn ${did}, then failed before any text, is back in the box and its bubble is gone (box ${JSON.stringify(await composer.inputValue())}, bubbles ${bubbles})`);
				await composer.fill("");
			}
		});

		// The same, with the turn's end and the handed-back message reaching the page together: no search row is left behind.
		await scene("handed-back-together", async () => {
			const question = "Please search, then fail, all at once.";
			const searchRows = () => page.locator(".wk-row").filter({ hasText: /the web/ }).count();
			const before = await searchRows();
			together.on = true;
			try {
				await ask(question);
				await waitUntil(async () => endpointState.open === 0 && (await idle()) && (await composer.inputValue()) === question, "the message is back in the box", 20_000).catch(() => {});
			} finally {
				together.on = false;
			}
			const bubbles = await page.locator(".bubble.user").filter({ hasText: question }).count();
			const left = (await searchRows()) - before;
			expect((await composer.inputValue()) === question && bubbles === 0 && left === 0, `a message handed back in the same moment its turn ends goes back to the box with nothing of its turn left above (box ${JSON.stringify(await composer.inputValue())}, bubbles ${bubbles}, search rows left ${left})`);
			await composer.fill("");
		});

		// The provider fails while its own search runs, after the words before it: the search's row stops with its turn.
		await scene("search-fails", async () => {
			const question = "Please say a word first, search, then fail.";
			const turn = turnOf(question);
			await ask(question);
			await waitUntil(async () => endpointState.open === 0 && (await idle()), "the turn has ended", 20_000).catch(() => {});
			await openCard(turn);
			const state = await turn.locator(".wk-row").filter({ hasText: /the web/ }).last().getAttribute("data-s").catch(() => null);
			const running = await turn.locator('.wk-row[data-s="running"]').count();
			expect(state === "stopped" && running === 0, `a search the provider's failure cut stops with its turn (state ${state}, running rows ${running}, turn ${JSON.stringify(squash(await turn.innerText()).slice(0, 200))})`);
		});

		// A turn the server ends with an error while the model thinks: the row stops being live and reads how long it thought.
		await scene("ended-thinking", async () => {
			const question = "Please think until it breaks.";
			const turn = turnOf(question);
			await ask(question);
			await turn.locator('.wk-thought[data-live="1"]').waitFor({ timeout: 10_000 });
			toPage({ type: "error", message: "The turn failed on the server." });
			await waitUntil(async () => (await turn.locator('.wk-thought[data-live="1"]').count()) === 0, "the thinking row ends", 3000).catch(() => {});
			const head = squash(await turn.locator(".wk-thought .wk-head").last().innerText().catch(() => ""));
			expect((await turn.locator('.wk-thought[data-live="1"]').count()) === 0 && head.startsWith("Thought"), `a turn that ends with an error while the model thinks ends its thinking row (got ${JSON.stringify(head)})`);
		});

		// The room shortening the conversation: the line under the conversation says so until its end.
		await scene("shortening", async () => {
			const line = page.locator(".messages").getByText(SHORTENING);
			expect((await line.count()) === 0, "no shortening line before the room shortens");
			toPage({ type: "event", event: { type: "compaction_start" } });
			await waitUntil(async () => (await line.count()) > 0, "the shortening line shows", 5000).catch(() => {});
			expect(await line.first().isVisible().catch(() => false), `while the room shortens the conversation, the page says "${SHORTENING}"`);
			toPage({ type: "event", event: { type: "compaction_end" } });
			await waitUntil(async () => (await line.count()) === 0, "the shortening line goes", 5000).catch(() => {});
			expect((await line.count()) === 0, "the shortening line goes when the room is done shortening");
		});

		// Nothing of the thinking is saved: not in the conversation, and no new file in the data folder against a plain turn.
		await scene("saved", async () => {
			const dataDir = path.join(tempHome, ".exxperts");
			const files = () => (fs.readdirSync(dataDir, { recursive: true, withFileTypes: true }) as fs.Dirent[]).filter((entry) => entry.isFile()).map((entry) => path.relative(dataDir, path.join(entry.parentPath, entry.name))).sort();
			const thread = async () => {
				const status = (await (await authedFetch(`${baseUrl}/api/persistent-agents/${roomId}/status`)).json()) as { runtime?: { activeThreadId?: string } };
				return ((await (await authedFetch(`${baseUrl}/api/persistent-agents/${roomId}/threads/${status.runtime?.activeThreadId ?? ""}`)).json()) as { thread?: { items?: any[] } }).thread ?? {};
			};
			const savedWith = async (text: string) => JSON.stringify(await thread()).includes(text);
			await ask("Hello, plain question.");
			await answered();
			await waitUntil(() => savedWith("Hello, plain question."), "the plain turn is saved", 10_000);
			const plain = files();
			// A turn that thinks and searches, against the plain one.
			const question = "Please think and search the web, then save.";
			await ask(question);
			await page.locator('.wk-thought[data-live="1"] button.wk-head').last().click();
			await grows(".wk-thought .wk-full", "the open thought grows");
			await answered();
			await waitUntil(async () => (await savedWith(question)) && JSON.stringify((await thread()).items?.at(-1) ?? {}).includes(SEARCH_ANSWER), "the thinking turn is saved", 10_000);
			const items = (await thread()).items ?? [];
			const kept = JSON.stringify(items);
			const searched = items.filter((item) => item?.kind === "tool" && item.name === "web_search");
			expect(searched.length > 0 && !items.some((item) => item?.kind === "thinking") && !kept.includes(PIECE_WORD), `after a turn that thought and searched, the saved conversation holds its search step and no thinking and none of its words (${searched.length} searches)`);
			expect(!items.some((item) => item?.kind === "tool" && (item.status === "writing" || "endedAt" in item)), "the saved conversation holds no step still being written and no step's end time");
			const added = files().filter((name) => !plain.includes(name));
			expect(added.length === 0, `a turn that thinks and searches adds no file to the data folder that a plain turn does not (${JSON.stringify(added)})`);
		});
	} finally {
		await browser.close();
	}
} catch (error) {
	failures.push((error as Error).stack ?? String(error));
	console.error(error);
} finally {
	if (server) await stopSmokeServer(server);
	endpoint.close();
	fs.rmSync(tempRoot, { recursive: true, force: true });
}

if (failures.length) {
	console.error(`thinking open smoke failed:\n- ${failures.join("\n- ")}`);
	if (process.env.SMOKE_SERVER_LOG) console.error(serverOutput.join("").slice(-4000));
	process.exit(1);
}
console.log("thinking open smoke passed");
