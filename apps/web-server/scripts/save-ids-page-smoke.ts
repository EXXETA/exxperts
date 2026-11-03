// The page and the server name a turn's items alike (thread-items-by-id.ts):
// the page sends its message with an id, keeps the ids the server gives the
// answer's parts and steps, names in its saves what it took out on purpose,
// and after a reconnect shows the saved copy with what only this window
// holds. In the browser, against a real spawned server and one synthetic
// Anthropic endpoint whose answer the smoke releases part by part; the
// page's connection and requests run through routes the smoke can drop,
// fail, hold and answer itself:
//
// - after a reload during an answer, a quick next message and leaving show
//   that message once, with no old partial answer;
// - after a reconnect, the landed answer shows with a question card only
//   this window held, also when the saved copy is longer than the page's;
// - a message handed back to the box stays out of the conversation through
//   a reload (a save that left before the hand-back arriving after it) and
//   through a reconnect before the next save, for each way it is handed
//   back, and the next save names it;
// - a reload during a files-only answer shows its message once, with its
//   file chips;
// - Stop as the answer's message ends notes that answer, and an older save
//   without the note keeps it;
// - the words after a hidden memory lookup inside the answer show once after
//   a reload;
// - an answer the provider cut and the runtime asked again, both split by a
//   thinking block, shows the retry whole and the cut attempt nowhere after
//   a reload, also when the retry ends while the page is away and a save
//   before still held the cut attempt, when the reconnect's save waits until
//   the retry has landed, and when the retry, away, writes under the cut
//   attempt's ids again; no save ever names an answer part as removed;
// - after a reconnect, another window's question card and failure line stay,
//   a question it asked again shows one card, an unsaved transfer keeps its
//   card and its place in the queue, a queue another window used stays
//   used, and a reconnect whose save answers after the person opened
//   another room changes nothing there.
//
// Every row runs and reports, so a run against an older page shows each one
// that fails. ONLY=18,31 runs those groups alone (18, 30, 30b, 31, 32, 37,
// 39, 34, 43, lookup, retry, retryaway, retryhold, retryreuse, window, again,
// transfer, used, switch).
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import { fileURLToPath } from "node:url";
import { chromium, type Page, type Route, type WebSocketRoute } from "playwright";
import { authedFetch, SMOKE_AUTH_TOKEN, SMOKE_SERVER_AUTH_ENV, SMOKE_SERVER_SPAWN_TREE_OPTIONS, smokeHomeEnv, stopSmokeServer, freePort } from "./smoke-server-process.js";
import { PendingRemovals } from "../../web-ui/src/room-thread-items.js";
import { persistentRoomSettingsNotAppliedFrame } from "../src/persistent-room-workspace-policy.js";

function assert(condition: unknown, message: string): asserts condition {
	if (!condition) throw new Error(message);
}

/** A row's outcome: null when it holds, else what went wrong. */
type RowResult = string | null;
const failures: string[] = [];
const ONLY = (process.env.ONLY ?? "").split(",").filter(Boolean);
const wanted = (group: string) => ONLY.length === 0 || ONLY.includes(group);
async function row(name: string, run: () => Promise<RowResult> | RowResult): Promise<void> {
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

// The removal list on its own: a save that left before a hand-back clears only what it named.
await row("a save that started before a hand-back and answers after it clears nothing of it", () => {
	const pending = new PendingRemovals();
	const before = pending.forSave("room", "c1");
	pending.add("room", "c1", ["q1"]);
	pending.clear("room", "c1", before);
	if (JSON.stringify(pending.all("room", "c1")) !== JSON.stringify(["q1"])) return `left ${JSON.stringify(pending.all("room", "c1"))}`;
	const named = pending.forSave("room", "c1");
	pending.add("room", "c1", ["q2"]);
	pending.clear("room", "c1", named);
	return JSON.stringify(pending.all("room", "c1")) === JSON.stringify(["q2"]) ? null : `left ${JSON.stringify(pending.all("room", "c1"))}`;
});
await row("one save names at most 200 removals, the oldest first; the rest wait for the next", () => {
	const pending = new PendingRemovals();
	pending.add("room", "c1", Array.from({ length: 250 }, (_, i) => `q${i}`));
	const named = pending.forSave("room", "c1");
	if (named.length !== 200 || named[0] !== "q0" || named[199] !== "q199") return `named ${named.length}, from ${named[0]} to ${named.at(-1)}`;
	pending.clear("room", "c1", named);
	const left = pending.all("room", "c1");
	if (left.length !== 50 || left[0] !== "q200") return `left ${left.length} from ${left[0]}`;
	return pending.all("room", "c2").length === 0 ? null : "another conversation got the removals";
});

{
	const p = typeof chromium?.executablePath === "function" ? chromium.executablePath() : "";
	if (!p || !fs.existsSync(p)) {
		console.log("save ids page smoke: browser rows skipped (Chromium not installed)");
		process.exit(failures.length ? 1 : 0);
	}
}

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const webServerDir = path.resolve(scriptDir, "..");
const repoRoot = path.resolve(webServerDir, "..", "..");
const port = await freePort();
const baseUrl = `http://127.0.0.1:${port}`;

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "exxperts-save-ids-page-"));
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
/** A message carrying this waits for the smoke to write its answer. */
const GATED = "[gated]";
/** A file with this in its name makes a files-only message wait the same way. */
const GATED_FILE = "gated-report.txt";
const STOPPED_LINE = "You stopped this answer.";
const AFTER_STEP = "After the step, the answer goes on to its end.";
const AFTER_LOOKUP = "After the lookup, the same message goes on.";
/** A message carrying this is cut by the provider once, after a thinking block, and asked again. */
const SPLIT_RETRY = "[split-retry]";
/** The same cut, but the retry waits for the smoke like a gated answer, one text block. */
const SPLIT_RETRY_AWAY = "[split-retry-away]";
const CUT_PART = "A partial the provider cut.";
const RETRIED_FIRST = "The retry's first words.";
const RETRIED_AFTER = "The retry's words after its thinking.";
const line = (n: number) => `Line ${n}: the answer keeps growing while the page saves it.\n\n`;

function sse(res: http.ServerResponse, event: string, payload: unknown): void {
	res.write(`event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`);
}
function startMessage(res: http.ServerResponse, model: string): void {
	sse(res, "message_start", { type: "message_start", message: { id: "msg_smoke", type: "message", role: "assistant", model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 100, output_tokens: 1 } } });
	sse(res, "content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } });
}
function end(res: http.ServerResponse): void {
	sse(res, "content_block_stop", { type: "content_block_stop", index: 0 });
	sse(res, "message_delta", { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 400 } });
	sse(res, "message_stop", { type: "message_stop" });
	res.end();
}

/** Text, a thinking block, then text: the shape both the cut attempt and its retry take. */
function splitByThinking(res: http.ServerResponse, before: string, after: string): void {
	sse(res, "content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: before } });
	sse(res, "content_block_stop", { type: "content_block_stop", index: 0 });
	sse(res, "content_block_start", { type: "content_block_start", index: 1, content_block: { type: "thinking", thinking: "" } });
	sse(res, "content_block_delta", { type: "content_block_delta", index: 1, delta: { type: "thinking_delta", thinking: "Weighing the answer." } });
	sse(res, "content_block_delta", { type: "content_block_delta", index: 1, delta: { type: "signature_delta", signature: "smoke-signature" } });
	sse(res, "content_block_stop", { type: "content_block_stop", index: 1 });
	sse(res, "content_block_start", { type: "content_block_start", index: 2, content_block: { type: "text", text: "" } });
	sse(res, "content_block_delta", { type: "content_block_delta", index: 2, delta: { type: "text_delta", text: after } });
}
let splitRetryAttempts = 0;
/** Attempts per question carrying SPLIT_RETRY_AWAY: each room's question is cut once. */
const splitRetryAwayAttempts = new Map<string, number>();

// The open gated answer: the smoke sends its parts with release() and ends it with modelDone() or modelStep().
let open: { res: http.ServerResponse; sent: number; model: string } | null = null;
const endpoint = http.createServer((req, res) => {
	let raw = "";
	req.on("data", (chunk) => { raw += chunk; });
	req.on("end", () => {
		const body = JSON.parse(raw || "{}");
		const model = String(body.model ?? "");
		res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
		const messages: any[] = Array.isArray(body.messages) ? body.messages : [];
		const last = messages.at(-1);
		startMessage(res, model);
		// The step's result is back: the answer goes on below it.
		if (Array.isArray(last?.content) && last.content.some((part: any) => part?.type === "tool_result")) {
			sse(res, "content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: AFTER_STEP } });
			end(res);
			return;
		}
		const lastUser = JSON.stringify(messages.filter((m) => m?.role === "user").at(-1) ?? "");
		if (lastUser.includes(SPLIT_RETRY_AWAY)) {
			const attempt = (splitRetryAwayAttempts.get(lastUser) ?? 0) + 1;
			splitRetryAwayAttempts.set(lastUser, attempt);
			if (attempt === 1) {
				splitByThinking(res, "The cut attempt's first words. ", CUT_PART);
				sse(res, "error", { type: "error", error: { type: "overloaded_error", message: "Overloaded" } });
				res.end();
				return;
			}
			open = { res, sent: 0, model };
			return;
		}
		if (lastUser.includes(SPLIT_RETRY)) {
			splitRetryAttempts += 1;
			if (splitRetryAttempts === 1) {
				splitByThinking(res, "The cut attempt's first words. ", CUT_PART);
				sse(res, "error", { type: "error", error: { type: "overloaded_error", message: "Overloaded" } });
				res.end();
				return;
			}
			splitByThinking(res, RETRIED_FIRST, RETRIED_AFTER);
			sse(res, "content_block_stop", { type: "content_block_stop", index: 2 });
			sse(res, "message_delta", { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 400 } });
			sse(res, "message_stop", { type: "message_stop" });
			res.end();
			return;
		}
		if (lastUser.includes(GATED) || lastUser.includes(GATED_FILE)) {
			open = { res, sent: 0, model };
			return;
		}
		sse(res, "content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "OK." } });
		end(res);
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
const modelDone = () => {
	end(open!.res);
	open = null;
};
/** The open answer thinks, then writes `after` in a text block of its own, and ends. */
const modelThinkThenDone = (after: string) => {
	const { res } = open!;
	open = null;
	sse(res, "content_block_stop", { type: "content_block_stop", index: 0 });
	sse(res, "content_block_start", { type: "content_block_start", index: 1, content_block: { type: "thinking", thinking: "" } });
	sse(res, "content_block_delta", { type: "content_block_delta", index: 1, delta: { type: "thinking_delta", thinking: "Weighing the rest." } });
	sse(res, "content_block_delta", { type: "content_block_delta", index: 1, delta: { type: "signature_delta", signature: "smoke-signature" } });
	sse(res, "content_block_stop", { type: "content_block_stop", index: 1 });
	sse(res, "content_block_start", { type: "content_block_start", index: 2, content_block: { type: "text", text: "" } });
	sse(res, "content_block_delta", { type: "content_block_delta", index: 2, delta: { type: "text_delta", text: after } });
	sse(res, "content_block_stop", { type: "content_block_stop", index: 2 });
	sse(res, "message_delta", { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 400 } });
	sse(res, "message_stop", { type: "message_stop" });
	res.end();
};
/** The open answer calls a step (a file the room does not hold) after its text; the answer goes on once the step's result is back. */
const modelStep = () => {
	const { res } = open!;
	open = null;
	sse(res, "content_block_stop", { type: "content_block_stop", index: 0 });
	sse(res, "content_block_start", { type: "content_block_start", index: 1, content_block: { type: "tool_use", id: "toolu_smoke_step", name: "read_file", input: {} } });
	sse(res, "content_block_delta", { type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: JSON.stringify({ name: "not-in-this-room.txt" }) } });
	sse(res, "content_block_stop", { type: "content_block_stop", index: 1 });
	sse(res, "message_delta", { type: "message_delta", delta: { stop_reason: "tool_use", stop_sequence: null }, usage: { output_tokens: 40 } });
	sse(res, "message_stop", { type: "message_stop" });
	res.end();
};

/** The open answer looks in memory between two text blocks of one message, a call the room shows only as its activity line. */
const modelHiddenLookup = () => {
	const { res } = open!;
	open = null;
	sse(res, "content_block_stop", { type: "content_block_stop", index: 0 });
	sse(res, "content_block_start", { type: "content_block_start", index: 1, content_block: { type: "tool_use", id: "toolu_smoke_lookup", name: "memory_search", input: {} } });
	sse(res, "content_block_delta", { type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: JSON.stringify({ query: "the smoke" }) } });
	sse(res, "content_block_stop", { type: "content_block_stop", index: 1 });
	sse(res, "content_block_start", { type: "content_block_start", index: 2, content_block: { type: "text", text: "" } });
	sse(res, "content_block_delta", { type: "content_block_delta", index: 2, delta: { type: "text_delta", text: AFTER_LOOKUP } });
	sse(res, "content_block_stop", { type: "content_block_stop", index: 2 });
	sse(res, "message_delta", { type: "message_delta", delta: { stop_reason: "tool_use", stop_sequence: null }, usage: { output_tokens: 40 } });
	sse(res, "message_stop", { type: "message_stop" });
	res.end();
};

async function waitUntil(predicate: () => Promise<boolean> | boolean, label: string, timeoutMs = 25_000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (await predicate()) return;
		await new Promise((resolve) => setTimeout(resolve, 100));
	}
	throw new Error(`timed out waiting until ${label}`);
}
/** Waits, and says whether it happened, for a state an older page may never reach. */
const reached = (predicate: () => Promise<boolean> | boolean, timeoutMs: number) => waitUntil(predicate, "", timeoutMs).then(() => true, () => false);

type Item = { kind?: string; id?: string; text?: string; requestId?: string; title?: string; attachments?: unknown[]; landed?: boolean; stoppedAt?: number };

let server: ChildProcessWithoutNullStreams | undefined;
const serverOutput: string[] = [];

try {
	await new Promise<void>((resolve) => endpoint.listen(0, "127.0.0.1", resolve));
	const endpointUrl = `http://127.0.0.1:${(endpoint.address() as AddressInfo).port}`;
	// The runtime asks a cut answer again at once, and the provider's client never does it itself.
	fs.writeFileSync(path.join(agentDir, "settings.json"), JSON.stringify({ retry: { baseDelayMs: 50, provider: { maxRetries: 0 } } }, null, 2), { mode: 0o600 });
	fs.writeFileSync(path.join(agentDir, "models.json"), JSON.stringify({ providers: { [KEY_PROVIDER]: { baseUrl: endpointUrl } } }, null, 2), { mode: 0o600 });
	fs.writeFileSync(path.join(agentDir, "auth.json"), JSON.stringify({ [KEY_PROVIDER]: { type: "api_key", key: "synthetic-anthropic-key" } }, null, 2), { mode: 0o600 });
	fs.writeFileSync(path.join(agentDir, "settings.json"), JSON.stringify({ retry: { baseDelayMs: 1000, provider: { maxRetries: 0 } } }, null, 2), { mode: 0o600 });
	const agents = await import("../src/persistent-agents.js");
	const ROOMS = ["Reload Room", "Card Room", "Longer Room", "Reload Back Room", "Drop Back Room", "Running Room", "Settings Room", "Moved Room", "Files Room", "Stop End Room", "Other Window Room", "Asked Again Room", "Transfer Room", "Used Room", "Asked Room", "Switch Room", "Other Room", "Lookup Room", "Retry Room", "Retry Away Room", "Retry Hold Room", "Retry Reuse Room"] as const;
	const rooms = Object.fromEntries(ROOMS.map((displayName) => [displayName, agents.createPersistentAgentFromScaffoldInput({ displayName, userName: "Synthetic User", preferredUserAddress: "Synthetic User" }).agent.agentId])) as Record<(typeof ROOMS)[number], string>;
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

	/** The room's open conversation as stored: its id, model, items and queue. */
	const stored = async (room: (typeof ROOMS)[number]) => {
		const status = await (await authedFetch(`${baseUrl}/api/persistent-agents/${rooms[room]}/status`)).json();
		const threadId = String(status?.activeThread?.threadId ?? "");
		const body = await (await authedFetch(`${baseUrl}/api/persistent-agents/${rooms[room]}/threads/${encodeURIComponent(threadId)}`)).json();
		const thread = body?.thread ?? {};
		return { threadId, model: thread.model, items: (thread.items ?? []) as Item[], pendingHandoffs: (thread.pendingHandoffs ?? []) as string[], inFlight: status?.activeThread?.inFlight === true };
	};
	/** A save of the room's conversation from somewhere else: another window, or a request of this one arriving late. */
	const saveFromElsewhere = async (room: (typeof ROOMS)[number], body: Record<string, unknown>) => {
		const { threadId } = await stored(room);
		const res = await authedFetch(`${baseUrl}/api/persistent-agents/${rooms[room]}/threads/${encodeURIComponent(threadId)}`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
		assert(res.ok, `the save from elsewhere is taken, got ${res.status}`);
	};
	const settled = (room: (typeof ROOMS)[number]) => waitUntil(async () => !(await stored(room)).inFlight, `${room}'s turn has settled`, 30_000);

	const browser = await chromium.launch();
	try {
		/** A page in one room; its connection and its conversation saves run through routes the smoke controls. */
		interface RoomPage {
			page: Page;
			readies: () => number;
			/** The room of each ready frame's socket, in order. */
			readyRooms: () => string[];
			/** The bodies of the conversation saves that reached the server, oldest first. */
			saves: () => any[];
			/** While set, a save is captured and fails, as when it never reaches the server; with a predicate, only the saves it picks. */
			failSaves: (pick: ((body: any) => boolean) | null) => void;
			/** The saves that failed so, oldest first. */
			failedSaves: () => any[];
			/** The next save waits; releaseSave() sends it on. */
			holdNextSave: () => void;
			releaseSave: () => void;
			savesHeld: () => number;
			/** The network drops; while `down`, every new connection and request fails at once. */
			drop: () => void;
			setDown: (down: boolean) => void;
			/** The next message with these words never reaches the server: the smoke answers it with inject(). */
			swallowPrompt: (text: string) => void;
			/** The prompt frames the page sent, as sent. */
			prompts: () => any[];
			/** Hands the page this frame from the server; the connection stays. */
			inject: (frame: unknown) => void;
			/** While set, the turn's end frame and every frame after it wait; letting go passes them on. */
			holdTurnEnd: (hold: boolean) => void;
			/** The page's requests go straight to the server from here: a request held by a route dies with a page that unloads, which a browser's own keepalive request does not. */
			stopRouting: () => Promise<void>;
		}
		const enter = async (room: (typeof ROOMS)[number]): Promise<RoomPage> => {
			const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
			const page = await context.newPage();
			let readies = 0;
			const readyRooms: string[] = [];
			let down = false;
			const saves: any[] = [];
			const failed: any[] = [];
			let failPick: ((body: any) => boolean) | null = null;
			let holding = false;
			const held: (() => void)[] = [];
			const swallowed = new Set<string>();
			const prompts: any[] = [];
			let holdEnd = false;
			const heldEnds: (() => void)[] = [];
			const live: { page: WebSocketRoute; server: WebSocketRoute }[] = [];
			const isSave = (route: Route) => route.request().method() === "PUT" && /^\/api\/persistent-agents\/[^/]+\/threads\/[^/]+$/.test(new URL(route.request().url()).pathname);
			await page.route(/\/api\//, (route) => {
				if (down) return route.abort("internetdisconnected");
				if (!isSave(route)) return route.fallback();
				let body: any = null;
				try { body = JSON.parse(route.request().postData() ?? "null"); } catch {}
				if (failPick && failPick(body)) {
					failed.push(body);
					return route.abort("failed");
				}
				const pass = () => {
					saves.push(body);
					void route.fallback().catch(() => {});
				};
				if (holding) {
					holding = false;
					held.push(pass);
				} else pass();
			});
			await page.routeWebSocket(/\/ws\?/, (ws) => {
				if (down) {
					void ws.close({ code: 4000, reason: "down" }).catch(() => {});
					return;
				}
				const upstream = ws.connectToServer();
				const pair = { page: ws, server: upstream };
				live.push(pair);
				ws.onMessage((message) => {
					const text = String(message);
					let frame: any = null;
					try { frame = JSON.parse(text); } catch {}
					if (frame?.type === "prompt") {
						prompts.push(frame);
						const words = String(frame?.shown?.text ?? frame.text ?? "");
						if ([...swallowed].some((swallow) => words.includes(swallow))) return;
					}
					upstream.send(message);
				});
				upstream.onMessage((message) => {
					const text = String(message);
					if (text.includes('"type":"ready"')) {
						readies += 1;
						readyRooms.push(new URL(ws.url()).searchParams.get("persistentAgentId") ?? "");
					}
					const pass = () => { try { ws.send(message); } catch {} };
					// From the turn's end on, every frame waits, so they still reach the page in their order.
					if (holdEnd && (heldEnds.length > 0 || text.includes('"type":"agent_end"'))) heldEnds.push(pass);
					else pass();
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
				readyRooms: () => [...readyRooms],
				saves: () => saves,
				failSaves: (pick) => { failPick = pick; },
				failedSaves: () => failed,
				holdNextSave: () => { holding = true; },
				releaseSave: () => { for (const next of held.splice(0)) next(); },
				savesHeld: () => held.length,
				drop: () => {
					for (const pair of live.splice(0)) {
						void pair.page.close({ code: 4000, reason: "dropped" }).catch(() => {});
						void pair.server.close().catch(() => {});
					}
				},
				setDown: (value) => { down = value; },
				swallowPrompt: (text) => { swallowed.add(text); },
				prompts: () => prompts,
				inject: (frame) => {
					for (const pair of live) pair.page.send(JSON.stringify(frame));
				},
				holdTurnEnd: (hold) => {
					holdEnd = hold;
					if (!hold) for (const next of heldEnds.splice(0)) next();
				},
				stopRouting: () => page.unroute(/\/api\//),
			};
		};
		const type = async (page: Page, text: string) => {
			const composer = page.locator("textarea").first();
			await composer.fill(text);
			await composer.press("Enter");
			await waitUntil(async () => (await page.locator(".bubble-row.user").filter({ hasText: text }).count()) > 0, `"${text}" is sent`);
		};
		const sendGated = async (page: Page, text: string) => {
			await type(page, text);
			await waitUntil(() => open !== null, "the gated answer has begun");
		};
		const sendPlain = async (page: Page, text: string) => {
			await type(page, text);
			await waitUntil(async () => (await page.locator(".stop-btn").count()) === 0 && (await page.locator(".messages .assistant-markdown").filter({ hasText: "OK." }).count()) > 0, `"${text}" is answered`);
		};
		const answers = (page: Page) => page.evaluate(() => [...document.querySelectorAll(".messages .assistant-markdown")].map((el) => el.textContent ?? ""));
		const lineShown = async (page: Page, n: number) => (await answers(page)).some((text) => text.includes(`Line ${n}:`));
		const bubbles = (page: Page, text: string) => page.locator(".bubble-row.user").filter({ hasText: text }).count();
		const turnOver = (page: Page) => waitUntil(async () => (await page.locator(".stop-btn").count()) === 0, "the turn has ended on the page", 30_000);
		/** The page's connection drops and comes back after `downMs`; resolves once the new connection is ready. */
		const reconnect = async (room: RoomPage, downMs = 1500, whileDown?: () => Promise<void>) => {
			const before = room.readies();
			room.setDown(true);
			room.drop();
			await room.page.waitForTimeout(downMs);
			if (whileDown) await whileDown();
			room.setDown(false);
			await waitUntil(() => room.readies() > before, "the room has reconnected", 40_000);
			await room.page.waitForTimeout(1200);
		};
		const askCard = (room: RoomPage, requestId: string, title: string) => room.inject({ type: "ui_request", id: requestId, kind: "confirm", title, message: "The smoke asks." });
		const cardsTitled = (page: Page, title: string) => page.locator(".messages").getByText(title, { exact: true }).count();
		const toRooms = async (page: Page) => {
			const back = page.getByRole("button", { name: "Back to rooms" });
			if (await back.count()) await back.first().click();
			else await page.getByText("Home", { exact: true }).first().click();
			await page.locator(".persistent-agent-card").first().waitFor({ timeout: 15_000 });
		};
		const userItems = (items: Item[], text: string) => items.filter((item) => item.kind === "user" && String(item.text ?? "").includes(text));

		// Case 18: a reload during an answer, a quick next message, then leaving.
		if (wanted("18")) {
			const reload = await enter("Reload Room");
			const { page } = reload;
			await sendGated(page, `First question ${GATED}`);
			release(2);
			await waitUntil(() => lineShown(page, 2), "the answer has begun on screen");
			await page.waitForTimeout(800);
			const before = reload.readies();
			await page.reload();
			await waitUntil(() => reload.readies() > before, "the reloaded room's connection is ready");
			await waitUntil(() => lineShown(page, 2), "the open answer is back on screen");
			release(2);
			modelDone();
			await turnOver(page);
			await waitUntil(() => lineShown(page, 4), "the whole first answer is on screen");
			await type(page, `Next question ${GATED}`);
			await waitUntil(() => open !== null, "the next answer has begun");
			await toRooms(page);
			release(1);
			modelDone();
			await settled("Reload Room");
			// The next message's answer has landed after it.
			await reached(async () => {
				const saved = (await stored("Reload Room")).items;
				const next = saved.findIndex((item) => item.kind === "user" && String(item.text ?? "").includes("Next question"));
				return next >= 0 && saved.slice(next + 1).some((item) => item.kind === "assistant");
			}, 10_000);
			const { items } = await stored("Reload Room");
			await row("case 18: after a reload, a quick next message and leaving, the saved conversation holds that message once and no old partial answer", () => {
				const next = userItems(items, "Next question").length;
				if (next !== 1) return `the next message is saved ${next} times`;
				// The next answer starts with its own "Line 1:", after the next message.
				const firstTurn = items.slice(0, items.findIndex((item) => item.kind === "user" && String(item.text ?? "").includes("Next question")));
				const firsts = firstTurn.filter((item) => item.kind === "assistant" && String(item.text ?? "").includes("Line 1:"));
				if (firsts.length !== 1) return `the first answer is saved ${firsts.length} times: ${JSON.stringify(items.map((item) => [item.kind, String(item.text ?? "").length]))}`;
				return String(firsts[0]!.text).includes("Line 4:") ? null : "the saved first answer is a partial one";
			});
			await page.locator(".persistent-agent-card").filter({ hasText: "Reload Room" }).getByRole("button", { name: /^(Enter|Resume)$/ }).click();
			await page.locator('button[title="Send"]').first().waitFor({ timeout: 15000 });
			await page.waitForTimeout(1000);
			await row("case 18: opened again, the room shows that message once and the first answer whole, once", async () => {
				const next = await bubbles(page, "Next question");
				if (next !== 1) return `the next message shows ${next} times`;
				const shown = await answers(page);
				const firsts = shown.slice(0, -1).filter((text) => text.includes("Line 1:"));
				return firsts.length === 1 && firsts[0]!.includes("Line 4:") && !shown.at(-1)!.includes("Line 2:") ? null : `the answers show as ${JSON.stringify(shown.map((text) => text.length))}`;
			});
			await page.context().close();
		}

		// Case 30: a question card shown and not yet saved, the answer landed, then a reconnect.
		if (wanted("30")) {
			const card = await enter("Card Room");
			const { page } = card;
			card.failSaves(() => true);
			await sendGated(page, `Card question ${GATED}`);
			release(2);
			await waitUntil(() => lineShown(page, 2), "the answer has begun on screen");
			askCard(card, "req_card_room", "Run the smoke's command?");
			await waitUntil(async () => (await cardsTitled(page, "Run the smoke's command?")) > 0, "the card shows");
			release(1);
			modelDone();
			await turnOver(page);
			await settled("Card Room");
			// The server lands the answer at the turn's end when the page sent ids; an older page's turn lands only at the close.
			await reached(async () => (await stored("Card Room")).items.some((item) => item.kind === "assistant" && String(item.text ?? "").includes("Line 3:")), 5000);
			card.failSaves(null);
			await reconnect(card);
			await row("case 30: after the reconnect the landed answer shows once, with the card only this window held", async () => {
				const shown = (await answers(page)).filter((text) => text.includes("Line 1:"));
				if (shown.length !== 1 || !shown[0]!.includes("Line 3:")) return `the answer shows as ${JSON.stringify(shown.map((text) => text.length))}`;
				return (await cardsTitled(page, "Run the smoke's command?")) === 1 ? null : `the card shows ${await cardsTitled(page, "Run the smoke's command?")} times`;
			});
			await row("case 30: the reconnect saved the card with the landed answer", async () => {
				const ok = await reached(async () => {
					const { items } = await stored("Card Room");
					return items.some((item) => item.kind === "approval" && item.requestId === "req_card_room") && items.filter((item) => item.kind === "assistant" && String(item.text ?? "").includes("Line 3:")).length === 1;
				}, 8000);
				return ok ? null : `saved: ${JSON.stringify((await stored("Card Room")).items.map((item) => item.kind))}`;
			});
			await page.context().close();
		}

		// Case 30, the second form: the turn writes a step and more text while the page is away, so the saved copy is longer than the page's list.
		if (wanted("30b")) {
			const longer = await enter("Longer Room");
			const { page } = longer;
			longer.failSaves(() => true);
			await sendGated(page, `Longer question ${GATED}`);
			release(2);
			await waitUntil(() => lineShown(page, 2), "the answer has begun on screen");
			askCard(longer, "req_longer_room", "Open the smoke's file?");
			await waitUntil(async () => (await cardsTitled(page, "Open the smoke's file?")) > 0, "the card shows");
			await reconnect(longer, 0, async () => {
				modelStep();
				await settled("Longer Room");
				await reached(async () => (await stored("Longer Room")).items.some((item) => String(item.text ?? "").includes(AFTER_STEP)), 8000);
				longer.failSaves(null);
			});
			await row("case 30, a longer saved copy: after the reconnect the whole landed answer shows, step and all, with the card this window held", async () => {
				await reached(async () => (await answers(page)).some((text) => text.includes(AFTER_STEP)), 8000);
				const shown = await answers(page);
				if (shown.filter((text) => text.includes("Line 1:")).length !== 1) return `the answer's first part shows ${shown.filter((text) => text.includes("Line 1:")).length} times`;
				if (shown.filter((text) => text.includes(AFTER_STEP)).length !== 1) return `the text after the step shows ${shown.filter((text) => text.includes(AFTER_STEP)).length} times`;
				return (await cardsTitled(page, "Open the smoke's file?")) === 1 ? null : `the card shows ${await cardsTitled(page, "Open the smoke's file?")} times`;
			});
			await page.context().close();
		}

		// Case 31: a message handed back to the box, a reload within 500 ms, and a save that left before the hand-back arriving after it.
		if (wanted("31")) {
			const back = await enter("Reload Back Room");
			const { page } = back;
			await sendPlain(page, "A first plain question.");
			await page.waitForTimeout(800);
			const QUESTION = "Handed back before the reload.";
			back.swallowPrompt(QUESTION);
			back.failSaves((body) => JSON.stringify(body?.items ?? []).includes(QUESTION));
			await type(page, QUESTION);
			await waitUntil(() => back.failedSaves().length > 0, "a save holding the message has left");
			const late = back.failedSaves().at(-1);
			back.failSaves(null);
			const settings = persistentRoomSettingsNotAppliedFrame(new Error("smoke"), false, false);
			back.inject({ type: "error", ...settings });
			await waitUntil(async () => (await bubbles(page, QUESTION)) === 0, "the message is back in the box");
			await back.stopRouting();
			const before = back.readies();
			await page.reload();
			await waitUntil(() => back.readies() > before, "the reloaded room's connection is ready");
			await page.waitForTimeout(800);
			await saveFromElsewhere("Reload Back Room", late);
			await row("case 31: after a hand-back and a reload, a save that left before it brings the message back neither to the file nor to the room", async () => {
				const saved = userItems((await stored("Reload Back Room")).items, QUESTION).length;
				if (saved) return "the late save brought the message back into the saved conversation";
				const reloads = back.readies();
				await page.reload();
				await waitUntil(() => back.readies() > reloads, "the room's connection is ready again");
				await page.waitForTimeout(800);
				return (await bubbles(page, QUESTION)) === 0 ? null : "the message shows in the room again";
			});
			await page.context().close();
		}

		// Cases 32 and 37: a hand-back, then the connection drops and comes back before the next save.
		const handBackThenReconnect = async (room: (typeof ROOMS)[number], question: string, refusal: (room: RoomPage) => void) => {
			const back = await enter(room);
			const { page } = back;
			await sendPlain(page, "A first plain question.");
			back.swallowPrompt(question);
			await type(page, question);
			await waitUntil(async () => userItems((await stored(room)).items, question).length > 0, "the message is saved");
			// The hand-back's own save never gets out before the connection drops.
			back.failSaves(() => true);
			refusal(back);
			await waitUntil(async () => (await bubbles(page, question)) === 0, "the message has left the room");
			// Another window writes meanwhile, so the saved copy, which still holds the message, is longer than this tab's
			// thread even with the lines this tab added on its own (the refusal's note, the connection line).
			await reconnect(back, 1500, async () => {
				const file = await stored(room);
				const notes = [1, 2, 3].map((n) => ({ kind: "system", id: `other_note_${room.length}_${n}`, text: `Note ${n} the other window wrote.` }));
				await saveFromElsewhere(room, { state: "active", origin: "unknown", model: file.model, items: [...file.items, ...notes] });
				back.failSaves(null);
			});
			const onScreen = await bubbles(page, question);
			await page.waitForTimeout(1000);
			const file = (await stored(room)).items;
			const inFile = userItems(file, question).length;
			const notesKept = file.filter((item: any) => String(item?.id ?? "").startsWith(`other_note_${room.length}_`)).length;
			await page.context().close();
			if (onScreen) return "the message shows in the room again";
			if (inFile) return "the message is back in the saved conversation";
			return notesKept === 3 ? null : `the saved conversation keeps ${notesKept} of the other window's 3 notes`;
		};
		if (wanted("32")) await row("case 32: a message the server handed back stays out of the room and the file through a reconnect before the save, and the other window's notes stay", () => handBackThenReconnect("Drop Back Room", "Handed back by the server.", (back) => back.inject({ type: "prompt_returned", text: "Handed back by the server.", id: "step_back_smoke", failure: "other", model: ON_KEY })));
		if (wanted("37")) await row("case 37: a message the running answer turned back stays out of the room and the file through a reconnect before the save, and the other window's notes stay", () => handBackThenReconnect("Running Room", "Sent while another answer ran.", (back) => back.inject({ type: "error", code: "turn_running", message: "The room is still answering." })));
		if (wanted("37")) await row("case 37: a message refused before its turn began stays out of the room and the file through a reconnect before the save, and the other window's notes stay", () => handBackThenReconnect("Settings Room", "Refused before it began.", (back) => back.inject({ type: "error", ...persistentRoomSettingsNotAppliedFrame(new Error("smoke"), false, false) })));

		// Case 39: the conversation moved on, so the message goes back into the box: the next save names it.
		if (wanted("39")) {
			const moved = await enter("Moved Room");
			const { page } = moved;
			await sendPlain(page, "A first plain question.");
			const QUESTION = "Sent after the conversation moved on.";
			moved.swallowPrompt(QUESTION);
			await type(page, QUESTION);
			await waitUntil(() => moved.saves().some((body) => userItems(body?.items ?? [], QUESTION).length > 0), "a save holds the message");
			const questionId = userItems(moved.saves().find((body) => userItems(body?.items ?? [], QUESTION).length > 0).items, QUESTION)[0]!.id;
			const savesBefore = moved.saves().length;
			moved.inject({ type: "error", code: "conversation_moved", message: "This conversation moved on in another window." });
			await row("case 39: after a conversation_moved refusal the next save names the message as removed", async () => {
				const named = await reached(() => moved.saves().slice(savesBefore).some((body) => Array.isArray(body?.removed) && body.removed.includes(questionId)), 5000);
				return named ? null : `the saves after it: ${JSON.stringify(moved.saves().slice(savesBefore).map((body) => body?.removed ?? null))}`;
			});
			await page.context().close();
		}

		// Case 34: a reload during a files-only answer whose message was not saved yet.
		if (wanted("34")) {
			const files = await enter("Files Room");
			const { page } = files;
			const filePath = path.join(tempRoot, GATED_FILE);
			fs.writeFileSync(filePath, "A report the smoke attaches.\n");
			await page.locator('input[type="file"]').first().setInputFiles(filePath);
			await waitUntil(async () => (await page.locator('button[title="Send"]').first().isEnabled()) && (await page.getByText(GATED_FILE).count()) > 0, "the file is ready in the box");
			// Only saves that hold the message fail: the reloaded page's own save of the fetched copy must pass, or it never connects.
			files.failSaves((body) => (body?.items ?? []).some((item: any) => item?.kind === "user" && JSON.stringify(item).includes(GATED_FILE)));
			await page.locator('button[title="Send"]').first().click();
			await waitUntil(() => open !== null, "the files-only answer has begun");
			release(2);
			await waitUntil(() => lineShown(page, 2), "the answer has begun on screen");
			// Its message is still unsaved when the page reloads: only the replay can bring it back.
			const before = files.readies();
			await page.reload();
			await waitUntil(() => files.readies() > before, "the reloaded room's connection is ready");
			await waitUntil(() => lineShown(page, 2), "the open answer is back on screen");
			await row("case 34: after a reload during a files-only answer, its message shows once, with its file chip", async () => {
				const withChip = await page.locator(".bubble-row.user").filter({ has: page.locator(".user-attachment-chip", { hasText: GATED_FILE }) }).count();
				if (withChip !== 1) return `the message with its chip shows ${withChip} times`;
				const asWords = await page.locator(".bubble-row.user").filter({ hasText: "FILE ATTACHED" }).count();
				return asWords === 0 ? null : "the file's note shows as the message's words";
			});
			files.failSaves(null);
			modelDone();
			await turnOver(page);
			await page.context().close();
		}

		// Case 43: Stop as the answer's message ends, then an older save without the note.
		if (wanted("43")) {
			const stop = await enter("Stop End Room");
			const { page } = stop;
			await sendGated(page, `Stop question ${GATED}`);
			release(2);
			await waitUntil(() => lineShown(page, 2), "the answer has begun on screen");
			stop.holdTurnEnd(true);
			modelDone();
			await settled("Stop End Room");
			await waitUntil(() => stop.saves().some((body) => JSON.stringify(body?.items ?? []).includes("Line 2:")), "a save holds the answer");
			const older = [...stop.saves()].reverse().find((body) => JSON.stringify(body?.items ?? []).includes("Line 2:"));
			await page.locator(".stop-btn").first().click();
			await page.waitForTimeout(300);
			stop.holdTurnEnd(false);
			await turnOver(page);
			await reached(async () => (await stored("Stop End Room")).items.some((item) => item.kind === "assistant" && String(item.text ?? "").trimEnd().endsWith(`_${STOPPED_LINE}_`)), 10_000);
			await row("case 43: Stop as the message ends puts the note on that answer, with no line of its own", async () => {
				const { items } = await stored("Stop End Room");
				const answer = items.find((item) => item.kind === "assistant" && String(item.text ?? "").includes("Line 2:"));
				if (!answer || !String(answer.text).trimEnd().endsWith(`_${STOPPED_LINE}_`)) return `the saved answer ends ${JSON.stringify(String(answer?.text ?? "").slice(-60))}`;
				return items.some((item) => item.kind === "system" && String(item.text ?? "").includes(STOPPED_LINE)) ? "the note is also a line of its own" : null;
			});
			assert(older, "a save before the Stop held the answer");
			await saveFromElsewhere("Stop End Room", older);
			await row("case 43: an older save without the note keeps the note", async () => {
				const { items } = await stored("Stop End Room");
				const answer = items.find((item) => item.kind === "assistant" && String(item.text ?? "").includes("Line 2:"));
				return answer && String(answer.text).includes(STOPPED_LINE) ? null : `the saved answer ends ${JSON.stringify(String(answer?.text ?? "").slice(-60))}`;
			});
			await page.context().close();
		}

		// A hidden lookup between two text blocks of one message: the server keeps both blocks in one part.
		if (wanted("lookup")) {
			const lookup = await enter("Lookup Room");
			const { page } = lookup;
			await sendGated(page, `Lookup question ${GATED}`);
			release(1);
			await waitUntil(() => lineShown(page, 1), "the answer has begun on screen");
			modelHiddenLookup();
			await waitUntil(async () => (await answers(page)).some((text) => text.includes(AFTER_STEP)), "the answer has gone on after the lookup's result");
			await turnOver(page);
			await settled("Lookup Room");
			const shownAfter = async () => (await answers(page)).filter((text) => text.includes(AFTER_LOOKUP)).length;
			await row("lookup: the words after a hidden lookup show once, live and after a reload", async () => {
				const live = await shownAfter();
				await waitUntil(() => lookup.saves().some((body) => JSON.stringify(body?.items ?? []).includes(AFTER_STEP)), "the page has saved the whole answer");
				const before = lookup.readies();
				await page.reload();
				await waitUntil(() => lookup.readies() > before, "the reloaded room's connection is ready");
				await waitUntil(async () => (await shownAfter()) > 0, "the reloaded room shows the answer");
				const reloaded = await shownAfter();
				const saved = (await stored("Lookup Room")).items.filter((item) => item.kind === "assistant" && String(item.text ?? "").includes(AFTER_LOOKUP)).length;
				return live === 1 && reloaded === 1 && saved === 1 ? null : `shown ${live} time(s) live, ${reloaded} after the reload, saved ${saved} time(s)`;
			});
			await page.context().close();
		}

		/** Answer parts a save named as removed: a retried attempt's ids may be the retry's again, so never one. */
		const removedAnswerParts = (room: RoomPage) => room.saves().flatMap((body) => (Array.isArray(body?.removed) ? body.removed : [])).filter((id: unknown) => /-a\d+$/.test(String(id)));
		/** A room cut once, after a thinking block, whose retry waits for the smoke; resolves once a save holds the cut part and the retry's first words show. */
		const cutThenRetrying = async (room: (typeof ROOMS)[number]) => {
			const retrying = await enter(room);
			const { page } = retrying;
			await type(page, `${room} question ${SPLIT_RETRY_AWAY}`);
			await waitUntil(() => open !== null, "the retry has begun");
			await waitUntil(() => retrying.saves().some((body) => JSON.stringify(body?.items ?? []).includes(CUT_PART)), "a save holds the cut attempt");
			// The save after the retry's first words never gets out.
			retrying.failSaves(() => true);
			release(1);
			await waitUntil(() => lineShown(page, 1), "the retry's words show");
			return retrying;
		};
		const retryCounts = async (room: RoomPage, roomName: (typeof ROOMS)[number], words: string[]) => {
			const onScreen = await Promise.all(words.map(async (w) => (await answers(room.page)).filter((text) => text.includes(w)).length));
			const saved = (await stored(roomName)).items.filter((item) => item.kind === "assistant").map((item) => String(item.text ?? ""));
			const inFile = words.map((w) => saved.filter((text) => text.includes(w)).length);
			return { onScreen, inFile };
		};

		// The provider cuts an answer after a thinking block, and the runtime asks again: the retry is split the same way.
		if (wanted("retry")) {
			const retry = await enter("Retry Room");
			const { page } = retry;
			await type(page, `Split retry question ${SPLIT_RETRY}`);
			const shown = async (words: string) => (await answers(page)).filter((text) => text.includes(words)).length;
			await waitUntil(async () => (await shown(RETRIED_AFTER)) > 0, "the retry's words after its thinking show");
			await turnOver(page);
			await settled("Retry Room");
			await waitUntil(() => retry.saves().some((body) => JSON.stringify(body?.items ?? []).includes(RETRIED_AFTER)), "the page has saved the retried answer");
			await row("retry: an answer asked again after a cut split by thinking shows the retry whole and the cut part nowhere, live and after a reload", async () => {
				const live = [await shown(RETRIED_FIRST), await shown(RETRIED_AFTER), await shown(CUT_PART)];
				const before = retry.readies();
				await page.reload();
				await waitUntil(() => retry.readies() > before, "the reloaded room's connection is ready");
				await reached(async () => (await shown(RETRIED_FIRST)) > 0, 10_000);
				const reloaded = [await shown(RETRIED_FIRST), await shown(RETRIED_AFTER), await shown(CUT_PART)];
				const saved = (await stored("Retry Room")).items.filter((item) => item.kind === "assistant").map((item) => String(item.text ?? ""));
				const savedCounts = [RETRIED_FIRST, RETRIED_AFTER, CUT_PART].map((words) => saved.filter((text) => text.includes(words)).length);
				if (removedAnswerParts(retry).length) return `a save named ${JSON.stringify(removedAnswerParts(retry))} as removed`;
				const want = JSON.stringify([1, 1, 0]);
				return [live, reloaded, savedCounts].every((counts) => JSON.stringify(counts) === want) ? null : `retry first, retry after, cut part: live ${JSON.stringify(live)}, after the reload ${JSON.stringify(reloaded)}, saved ${JSON.stringify(savedCounts)}`;
			});
			await page.context().close();
		}

		// The same cut, saved while the retry waits; the retry is one block and ends while the page is away.
		if (wanted("retryaway")) {
			const away = await enter("Retry Away Room");
			const { page } = away;
			const shown = async (words: string) => (await answers(page)).filter((text) => text.includes(words)).length;
			await type(page, `Retry away question ${SPLIT_RETRY_AWAY}`);
			await waitUntil(() => open !== null, "the retry has begun");
			await waitUntil(() => away.saves().some((body) => JSON.stringify(body?.items ?? []).includes(CUT_PART)), "a save holds the cut attempt");
			// The save after the retry's first words never gets out.
			away.failSaves(() => true);
			release(1);
			await waitUntil(() => lineShown(page, 1), "the retry's words show");
			await reconnect(away, 1500, async () => {
				modelDone();
				await settled("Retry Away Room");
				away.failSaves(null);
			});
			await turnOver(page);
			await row("retryaway: a retry that ended while the page was away leaves the cut attempt out of the room and the file", async () => {
				await reached(async () => !JSON.stringify((await stored("Retry Away Room")).items).includes(CUT_PART), 5000);
				const onScreen = [await shown("Line 1:"), await shown(CUT_PART)];
				const saved = (await stored("Retry Away Room")).items.filter((item) => item.kind === "assistant").map((item) => String(item.text ?? ""));
				const inFile = ["Line 1:", CUT_PART].map((words) => saved.filter((text) => text.includes(words)).length);
				if (removedAnswerParts(away).length) return `a save named ${JSON.stringify(removedAnswerParts(away))} as removed`;
				return JSON.stringify(onScreen) === "[1,0]" && JSON.stringify(inFile) === "[1,0]" ? null : `retry, cut part: on screen ${JSON.stringify(onScreen)}, saved ${JSON.stringify(inFile)}`;
			});
			await page.context().close();
		}

		// The same, but the reconnect reads the saved copy while the retry still runs, and its save waits until the retry has landed.
		if (wanted("retryhold")) {
			const hold = await cutThenRetrying("Retry Hold Room");
			const { page } = hold;
			const before = hold.readies();
			hold.setDown(true);
			hold.drop();
			await page.waitForTimeout(1500);
			hold.failSaves(null);
			hold.holdNextSave();
			hold.setDown(false);
			await waitUntil(() => hold.savesHeld() > 0, "the reconnect's save is on its way", 40_000);
			modelDone();
			await settled("Retry Hold Room");
			hold.releaseSave();
			await waitUntil(() => hold.readies() > before, "the room has reconnected", 40_000);
			await turnOver(page);
			await row("retryhold: a reconnect whose save waits until the retry has landed leaves the cut attempt out", async () => {
				await reached(async () => !JSON.stringify((await stored("Retry Hold Room")).items).includes(CUT_PART), 5000);
				const { onScreen, inFile } = await retryCounts(hold, "Retry Hold Room", ["Line 1:", CUT_PART]);
				if (removedAnswerParts(hold).length) return `a save named ${JSON.stringify(removedAnswerParts(hold))} as removed`;
				return JSON.stringify(onScreen) === "[1,0]" && JSON.stringify(inFile) === "[1,0]" ? null : `retry, cut part: on screen ${JSON.stringify(onScreen)}, saved ${JSON.stringify(inFile)}`;
			});
			await page.context().close();
		}

		// The retry, while the page is away, thinks and writes again under the id the page took off with the cut attempt.
		if (wanted("retryreuse")) {
			const reuse = await cutThenRetrying("Retry Reuse Room");
			const { page } = reuse;
			await reconnect(reuse, 1500, async () => {
				modelThinkThenDone(RETRIED_AFTER);
				await settled("Retry Reuse Room");
				reuse.failSaves(null);
			});
			await turnOver(page);
			await row("retryreuse: the retry's words under a retired id, written while the page was away, show and stay saved", async () => {
				await reached(async () => (await answers(page)).some((text) => text.includes(RETRIED_AFTER)), 5000);
				const { onScreen, inFile } = await retryCounts(reuse, "Retry Reuse Room", ["Line 1:", RETRIED_AFTER, CUT_PART]);
				if (removedAnswerParts(reuse).length) return `a save named ${JSON.stringify(removedAnswerParts(reuse))} as removed`;
				return JSON.stringify(onScreen) === "[1,1,0]" && JSON.stringify(inFile) === "[1,1,0]" ? null : `retry, retry after thinking, cut part: on screen ${JSON.stringify(onScreen)}, saved ${JSON.stringify(inFile)}`;
			});
			await page.context().close();
		}

		// The reconnect's second way: another window's items stay.
		if (wanted("window")) {
			const mine = await enter("Other Window Room");
			const { page } = mine;
			await sendPlain(page, "A first plain question.");
			await page.waitForTimeout(1000);
			mine.failSaves(() => true);
			for (const n of [1, 2, 3]) askCard(mine, `req_mine_${n}`, `This window's question ${n}?`);
			await waitUntil(async () => (await cardsTitled(page, "This window's question 3?")) > 0, "this window's cards show");
			await reconnect(mine, 1500, async () => {
				const file = await stored("Other Window Room");
				await saveFromElsewhere("Other Window Room", {
					state: "active", origin: "unknown", model: file.model,
					items: [...file.items, { kind: "approval", id: "other_card", requestId: "req_other", uiKind: "confirm", title: "The other window's question?" }, { kind: "system", id: "other_failure", text: "The other window's answer could not be written.", level: "error" }],
				});
				mine.failSaves(null);
			});
			await row("reconnect: another window's question card and failure line, written while this one was away, stay", async () => {
				if ((await cardsTitled(page, "The other window's question?")) !== 1) return "the other window's card is gone";
				return (await page.getByText("The other window's answer could not be written.").count()) === 1 ? null : "the other window's failure line is gone";
			});
			await row("reconnect: this window's own unsaved cards stay beside them", async () => {
				for (const n of [1, 2, 3]) if ((await cardsTitled(page, `This window's question ${n}?`)) !== 1) return `this window's card ${n} shows ${await cardsTitled(page, `This window's question ${n}?`)} times`;
				return null;
			});
			await page.context().close();
		}

		// A question the other window asked again shows one card.
		if (wanted("again")) {
			const again = await enter("Asked Again Room");
			const { page } = again;
			await sendPlain(page, "A first plain question.");
			askCard(again, "req_again", "Shall the smoke go on?");
			await waitUntil(async () => (await stored("Asked Again Room")).items.some((item) => item.kind === "approval" && item.requestId === "req_again"), "the card is saved");
			again.failSaves(() => true);
			askCard(again, "req_local_a", "This window's other question?");
			await reconnect(again, 1500, async () => {
				const file = await stored("Asked Again Room");
				await saveFromElsewhere("Asked Again Room", {
					state: "active", origin: "unknown", model: file.model,
					items: [...file.items.filter((item) => item.requestId !== "req_again"), { kind: "approval", id: "asked_again_card", requestId: "req_again", uiKind: "confirm", title: "Shall the smoke go on?" }],
				});
				again.failSaves(null);
			});
			await row("reconnect: a question the other window asked again shows one card", async () => {
				const shown = await cardsTitled(page, "Shall the smoke go on?");
				return shown === 1 ? null : `the card shows ${shown} times`;
			});
			await page.context().close();
		}

		// The handoff queue: an answer transferred from another room.
		const transferHere = async (room: RoomPage, question: string) => {
			const { page } = room;
			const composer = page.locator("textarea").first();
			await composer.fill(`@${rooms["Asked Room"]} ${question}`);
			await composer.press("Enter");
			const add = page.getByRole("button", { name: "Add to this conversation" });
			await add.first().waitFor({ timeout: 30_000 });
			await add.first().click();
			await waitUntil(async () => (await page.locator(".messages").getByText(question).count()) > 0, "the transferred answer's card shows");
		};
		if (wanted("transfer")) {
			const transfer = await enter("Transfer Room");
			const { page } = transfer;
			await sendPlain(page, "A first plain question.");
			await page.waitForTimeout(800);
			transfer.failSaves(() => true);
			await transferHere(transfer, "What did the asked room decide?");
			await reconnect(transfer, 1500, async () => {
				const file = await stored("Transfer Room");
				await saveFromElsewhere("Transfer Room", {
					state: "active", origin: "unknown", model: file.model,
					items: [...file.items, { kind: "system", id: "other_note_1", text: "A note the other window wrote." }, { kind: "system", id: "other_note_2", text: "Another note the other window wrote." }],
				});
				transfer.failSaves(null);
			});
			await row("reconnect: an unsaved transfer keeps its card and its place in the queue", async () => {
				if ((await page.locator(".messages").getByText("What did the asked room decide?").count()) === 0) return "the transferred card is gone";
				const queued = await reached(async () => (await stored("Transfer Room")).pendingHandoffs.length === 1, 8000);
				return queued ? null : `the saved queue holds ${(await stored("Transfer Room")).pendingHandoffs.length} entries`;
			});
			await page.context().close();
		}
		if (wanted("used")) {
			const used = await enter("Used Room");
			const { page } = used;
			await sendPlain(page, "A first plain question.");
			await transferHere(used, "What did the asked room say?");
			await waitUntil(async () => (await stored("Used Room")).pendingHandoffs.length === 1, "the transfer is saved with its queue");
			used.failSaves(() => true);
			for (const n of [1, 2]) askCard(used, `req_used_${n}`, `A question while away ${n}?`);
			await waitUntil(async () => (await cardsTitled(page, "A question while away 2?")) > 0, "this window's cards show");
			await reconnect(used, 1500, async () => {
				const file = await stored("Used Room");
				await saveFromElsewhere("Used Room", {
					state: "active", origin: "unknown", model: file.model, pendingHandoffs: [],
					items: [...file.items, { kind: "user", id: "sent_elsewhere", text: "Sent from the other window.", ts: Date.now() }],
				});
				used.failSaves(null);
			});
			await row("reconnect: a queue another window used stays used", async () => {
				// The reconnect's save has answered (it comes before the ready); a later save must not bring the entry back either.
				await page.waitForTimeout(500);
				const left = (await stored("Used Room")).pendingHandoffs.length;
				return left === 0 ? null : `the saved queue holds ${left} entries again`;
			});
			await page.context().close();
		}

		// A reconnect whose save answers after the person opened another room.
		if (wanted("switch")) {
			const switching = await enter("Switch Room");
			const { page } = switching;
			const leftRoom = switching.readyRooms()[0];
			await sendPlain(page, "A question in the room left behind.");
			await page.waitForTimeout(800);
			switching.setDown(true);
			switching.drop();
			await page.waitForTimeout(1500);
			switching.holdNextSave();
			switching.setDown(false);
			await waitUntil(() => switching.savesHeld() > 0, "the reconnect's save is on its way", 40_000);
			await toRooms(page);
			const before = switching.readies();
			await page.locator(".persistent-agent-card").filter({ hasText: "Other Room" }).getByRole("button", { name: /^(Enter|Resume)$/ }).click();
			await page.locator('button[title="Send"]').first().waitFor({ timeout: 15000 });
			await waitUntil(() => switching.readies() > before, "the other room's connection is ready");
			const readiesInOther = switching.readies();
			const answered = page.waitForResponse((res) => res.request().method() === "PUT" && new URL(res.url()).pathname.startsWith(`/api/persistent-agents/${encodeURIComponent(leftRoom)}/threads/`), { timeout: 30_000 });
			switching.releaseSave();
			await answered;
			// Whatever the save's answer would set off has had its moment.
			await page.waitForTimeout(1000);
			await row("reconnect: a save that answers after the person opened another room changes nothing there", async () => {
				if ((await bubbles(page, "A question in the room left behind.")) > 0) return "the room left behind's conversation shows in the other room";
				// Only the room left behind counts: what the new room's own socket does is not this save's doing.
				const backInLeft = switching.readyRooms().slice(readiesInOther).filter((room) => room === leftRoom).length;
				return backInLeft === 0 ? null : `the room left behind's connection was made again (${backInLeft} time(s))`;
			});
			await page.context().close();
		}
	} finally {
		await browser.close();
	}
} catch (error) {
	console.error(error);
	console.error(serverOutput.join("").slice(-4000));
	failures.push("setup");
} finally {
	try { (endpoint as any).closeAllConnections?.(); } catch {}
	try { endpoint.close(); } catch {}
	await stopSmokeServer(server);
	fs.rmSync(tempRoot, { recursive: true, force: true });
}

if (failures.length) {
	console.error(`\nsave ids page smoke: ${failures.length} row(s) failed: ${failures.join("; ")}`);
	process.exit(1);
}
console.log("\nsave ids page smoke passed");
