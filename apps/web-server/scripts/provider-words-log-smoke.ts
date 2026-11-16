// A failed model call's own words never reach the server's log: on a shared
// server whoever runs it reads the log, and the words can carry more than a
// code (a gateway's error body, a key echoed back). Each log line below keeps
// what "provider call failed" keeps (the cause, the status, the provider's
// error type), and the words stay where the person reads them.
//
// Against a real spawned server and a local OpenAI-compatible stand-in whose
// every error body carries MARKER, a made-up key:
//   1. "auto-compaction failed": the summary call refused by a content filter;
//      the words still reach the page: its Details shows them and the
//      conversation it saves keeps them (in Chromium, skipped without it);
//   2. "the provider refused the consulted room's Memory model": a consult on
//      a Memory model the provider no longer serves;
//   3. "memory ask failed": HiveMind's question refused with a 400;
//   4. the failed retry of an assessment draft: its warn line, while the
//      warning the person sees keeps the words.
// Offline: the provider is a local fake.
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { authedFetch, freePort, SMOKE_AUTH_HEADERS, SMOKE_AUTH_TOKEN, SMOKE_SERVER_AUTH_ENV, SMOKE_SERVER_SPAWN_TREE_OPTIONS, smokeHomeEnv, stopSmokeServer, waitForServer } from "./smoke-server-process.js";
import { sendFromBox, waitEvery } from "./smoke-wait.js";

const waitUntil = waitEvery(100);

function assert(condition: unknown, message: string): asserts condition {
	if (!condition) throw new Error(message);
}

let passes = 0;
function pass(label: string): void {
	passes += 1;
	console.log(`  ok ${label}`);
}

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const webServerDir = path.resolve(scriptDir, "..");
const repoRoot = path.resolve(webServerDir, "..", "..");
const port = await freePort();
const baseUrl = `http://127.0.0.1:${port}`;

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "exxperts-provider-words-log-"));
const tempHome = path.join(tempRoot, "home");
const agentsRoot = path.join(tempHome, ".exxperts", "app", "personalized-agents");
const agentDir = path.join(tempHome, ".exxperts", "agent");
const appDir = path.join(tempHome, ".exxperts", "app");
const threadCwd = path.join(tempRoot, "cwd");
for (const dir of [agentsRoot, agentDir, threadCwd]) fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
process.env.HOME = tempHome;
process.env.USERPROFILE = tempHome;
process.env.EXXPERTS_CODING_AGENT_DIR = agentDir;
process.env.EXXETA_PERSISTENT_AGENTS_ROOT = agentsRoot;

// A key a provider echoes back in its error: never in the log.
const MARKER = "echoed-key-PROVIDERWORDS-7f3k2q";
const PROVIDER = "openai-compatible";
const NARROW = { provider: PROVIDER, model: "narrow-model" };
const GONE = { provider: PROVIDER, model: "gone-model" };
const ASK = { provider: PROVIDER, model: "ask-model" };
// The runtime condenses once the context passes the window minus its reserve (16384): the answer to SHORTEN reads this much.
const NARROW_WINDOW = 64_000;
const PROMPT_TOKENS = 60_000;
const SHORTEN = "Shorten now, please.";

// ---------------------------------------------------------------------------
// The stand-in provider: a model no longer served answers 404, the ask model
// 400, a summary request a content filter's 400; every other chat answers,
// the one to SHORTEN reading enough to trip the room's condensing.
// ---------------------------------------------------------------------------
let chatCalls = 0;
const errorBody = (message: string, type: string, code?: string) => JSON.stringify({ error: { message: `${message} Key ${MARKER}`, type, ...(code ? { code } : {}) } });
const sse = (payload: unknown) => `data: ${JSON.stringify(payload)}\n\n`;
const textOf = (message: any): string => typeof message?.content === "string" ? message.content : Array.isArray(message?.content) ? message.content.map((part: any) => String(part?.text ?? "")).join("") : "";

const provider = http.createServer((req, res) => {
	let raw = "";
	req.on("data", (chunk) => { raw += chunk; });
	req.on("end", () => {
		let parsed: any = {};
		try { parsed = JSON.parse(raw); } catch {}
		const model = String(parsed?.model ?? "");
		const messages: any[] = Array.isArray(parsed?.messages) ? parsed.messages : [];
		if (model === GONE.model) {
			res.writeHead(404, { "content-type": "application/json" }).end(errorBody("The model `gone-model` does not exist.", "invalid_request_error", "model_not_found"));
			return;
		}
		if (model === ASK.model) {
			res.writeHead(400, { "content-type": "application/json" }).end(errorBody("Unsupported value for this request.", "invalid_request_error"));
			return;
		}
		// The summary request wraps the conversation in <conversation> tags.
		if (messages.some((message) => message?.role === "user" && textOf(message).includes("<conversation>"))) {
			res.writeHead(400, { "content-type": "application/json" }).end(errorBody("The response was filtered due to the prompt triggering content management policy.", "invalid_request_error", "content_filter"));
			return;
		}
		chatCalls += 1;
		const promptTokens = messages.some((message) => message?.role === "user" && textOf(message).includes(SHORTEN)) ? PROMPT_TOKENS : 100;
		const base = { id: `cmpl_${chatCalls}`, object: "chat.completion.chunk", created: Math.floor(Date.now() / 1000), model };
		res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
		res.write(sse({ ...base, choices: [{ index: 0, delta: { role: "assistant", content: "Short answer." }, finish_reason: null }] }));
		res.write(sse({ ...base, choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: promptTokens, completion_tokens: 10, total_tokens: promptTokens + 10 } }));
		res.end("data: [DONE]\n\n");
	});
});

// ---------------------------------------------------------------------------
// The log, as the server writes it: one JSON object a line.
// ---------------------------------------------------------------------------
const serverOutput: string[] = [];
function logLines(msg: string): Array<{ raw: string; fields: Record<string, unknown> }> {
	return serverOutput.join("").split("\n").flatMap((raw) => {
		try {
			const fields = JSON.parse(raw);
			return fields?.msg === msg ? [{ raw, fields }] : [];
		} catch {
			return [];
		}
	});
}

/** The one line with this message: the codes, never the words. */
async function codesOnly(msg: string, want: Record<string, unknown>): Promise<void> {
	await waitUntil(() => logLines(msg).length > 0, `the "${msg}" line`, 20_000);
	const [line] = logLines(msg);
	assert(!line.raw.includes(MARKER), `"${msg}" keeps the provider's words out of the log, got ${line.raw}`);
	for (const [key, value] of Object.entries(want)) assert(line.fields[key] === value, `"${msg}" logs ${key} ${JSON.stringify(value)}, got ${line.raw}`);
}

async function api(pathname: string, init: { method?: string; body?: unknown; timeoutMs?: number } = {}): Promise<{ status: number; body: any }> {
	const response = await authedFetch(`${baseUrl}${pathname}`, { method: init.method ?? "GET", signal: AbortSignal.timeout(init.timeoutMs ?? 10_000), ...(init.body === undefined ? {} : { headers: { "content-type": "application/json" }, body: JSON.stringify(init.body) }) });
	const text = await response.text();
	return { status: response.status, body: text ? JSON.parse(text) : null };
}

const WebSocketImpl: any = (await import("ws")).default;

/** A room's live connection, keeping every frame it receives. */
async function connect(roomId: string, conversationId: string): Promise<{ frames: any[]; send(frame: unknown): void; close(): void }> {
	const socket = new WebSocketImpl(`ws://127.0.0.1:${port}/ws?persistentAgentId=${roomId}&conversationId=${conversationId}&modelProvider=${PROVIDER}&model=${NARROW.model}&reattach=1`, { headers: { ...SMOKE_AUTH_HEADERS } });
	const frames: any[] = [];
	socket.addEventListener("message", (event: { data: unknown }) => { try { frames.push(JSON.parse(String(event.data))); } catch {} });
	await new Promise<void>((resolve, reject) => {
		socket.addEventListener("open", () => resolve());
		socket.addEventListener("error", () => reject(new Error("the live connection failed to open")));
	});
	await waitUntil(() => frames.some((frame) => frame.type === "ready"), "the ready frame");
	return { frames, send: (frame) => socket.send(JSON.stringify(frame)), close: () => { try { socket.close(); } catch {} } };
}

let server: ChildProcessWithoutNullStreams | undefined;
const sockets: Array<{ close(): void }> = [];

try {
	await new Promise<void>((resolve) => provider.listen(0, "127.0.0.1", resolve));
	const providerPort = (provider.address() as AddressInfo).port;
	const models = [
		{ id: NARROW.model, name: "Narrow Model", contextWindow: NARROW_WINDOW, maxTokens: 16384 },
		{ id: GONE.model, name: "Gone Model", contextWindow: 128_000, maxTokens: 16384 },
		{ id: ASK.model, name: "Ask Model", contextWindow: 128_000, maxTokens: 16384 },
	];
	fs.writeFileSync(path.join(agentDir, "models.json"), JSON.stringify({ providers: { [PROVIDER]: { name: "Stand-in Provider", baseUrl: `http://127.0.0.1:${providerPort}/v1`, api: "openai-completions", models } } }, null, 2), { mode: 0o600 });
	fs.writeFileSync(path.join(agentDir, "auth.json"), JSON.stringify({ [PROVIDER]: { type: "api_key", key: "synthetic-provider-words-key" } }, null, 2), { mode: 0o600 });
	fs.writeFileSync(path.join(appDir, "openai-compatible-ai-profile.json"), JSON.stringify({ profileId: PROVIDER, providerId: PROVIDER, label: "Stand-in Provider", roomModels: models.map((model) => ({ modelId: model.id, label: model.name })), maintenanceModel: NARROW.model }, null, 2), { mode: 0o600 });
	fs.writeFileSync(path.join(appDir, "persistent-agent-ai-profile.json"), JSON.stringify({ profileId: PROVIDER }, null, 2), { mode: 0o600 });
	// A small kept window, so the first exchange is what the summary condenses.
	fs.writeFileSync(path.join(agentDir, "settings.json"), JSON.stringify({ compaction: { keepRecentTokens: 5 } }, null, 2), { mode: 0o600 });

	// --- 4. The failed retry of an assessment draft, in this process --------------------
	{
		const { generateAssessmentWithRetry } = await import("../src/persistent-agent-maintenance-worker.js");
		const { ModelUnreachableError } = await import("../src/model-call-causes.js");
		/** A first draft with a problem, so it is asked once more, and a retry that fails with `failure`: the warn line and the warnings the person sees. */
		const failedRetry = async (failure: Error): Promise<{ line: string; shown: string[] }> => {
			const warned: string[] = [];
			const realWarn = console.warn;
			console.warn = (...args: unknown[]) => { warned.push(args.map(String).join(" ")); };
			let drafts = 0;
			try {
				const { warnings } = await generateAssessmentWithRetry({
					agentId: "a_provider_words",
					processLabel: "assessment",
					model: NARROW,
					prompt: "Assess the room.",
					basePrompt: "Assess the room.",
					generate: async () => {
						drafts += 1;
						if (drafts === 1) return { text: "A short first draft." };
						throw failure;
					},
					// The first draft stays usable when the retry fails.
					parse: () => ({ warnings: ["the draft named no topic"] }),
					buildRetryPrompt: (prompt) => prompt,
				});
				const line = warned.find((entry) => entry.startsWith("[assessment-retry-failed]"));
				assert(drafts === 2 && line, `the failed retry writes its warn line, got ${drafts} drafts and ${JSON.stringify(warned)}`);
				assert(!line.includes(MARKER), `the failed retry's line keeps the provider's words out of the log, got ${line}`);
				return { line, shown: warnings };
			} finally {
				console.warn = realWarn;
			}
		};
		const busy = await failedRetry(Object.assign(new Error(`429 Rate limit reached for requests. Key ${MARKER}`), { errorStatus: 429, errorType: "rate_limit_error" }));
		assert(busy.line.includes(`"status":429`) && busy.line.includes(`"errorType":"rate_limit_error"`) && busy.line.includes(`"cause":"busy:rate-limit"`), `the failed retry's line logs the codes, got ${busy.line}`);
		assert(busy.shown.some((warning) => warning.includes(MARKER)), `the warning the person sees keeps the words, got ${JSON.stringify(busy.shown)}`);
		// A Memory model call that cannot be reached hands up the patience's own error, the provider's failure beneath it.
		const refusedKey = Object.assign(new Error(`401 Invalid API key. Key ${MARKER}`), { errorStatus: 401, errorType: "authentication_error" });
		const unreached = await failedRetry(new ModelUnreachableError("signed-out", NARROW, refusedKey));
		assert(unreached.line.includes(`"status":401`) && unreached.line.includes(`"errorType":"authentication_error"`) && unreached.line.includes(`"cause":"unreachable:signed-out"`), `a retry the patience gave up on logs the provider's codes, got ${unreached.line}`);
		pass("a draft's failed retry logs its codes, the provider's beneath an unreachable model too, never the provider's words; the person's warning keeps them");
	}

	// Rooms for the consult and HiveMind: memory to answer from, on the Memory model each row names.
	const agents = await import("../src/persistent-agents.js");
	const roomModels = await import("../src/room-models.js");
	function roomWithMemory(displayName: string, memory: { provider: string; model: string }): string {
		const agentId = agents.createPersistentAgentFromScaffoldInput({ displayName, userName: "Synthetic User", preferredUserAddress: "Synthetic User" }).agent.agentId;
		roomModels.writeRoomModels(agentId, { conversation: NARROW, memory });
		const l1bPath = path.join(agentsRoot, agentId, "L1b", "current.md");
		const text = fs.readFileSync(l1bPath, "utf-8");
		const active = /^##\s+Active Items\s*$/m.exec(text)!;
		const note = ["### Unsorted", "", "<!-- e: id=m-0101 kind=fact saved=2026-09-01 -->", `- Invoices for ${displayName} go out on the first working day.`, "", ""].join("\n");
		fs.writeFileSync(l1bPath, `${text.slice(0, active.index)}${note}${text.slice(active.index)}`, "utf-8");
		return agentId;
	}
	const consultedRoom = roomWithMemory("Consulted Room", GONE);
	const askedRoom = roomWithMemory("Asked Room", ASK);
	// A room with one earlier exchange, for the page to resume.
	const PAGE_ROOM = "Shortening Room";
	const pageConversation = "c_shortening";
	const pageRoom = (() => {
		const agentId = agents.createPersistentAgentFromScaffoldInput({ displayName: PAGE_ROOM, userName: "Synthetic User", preferredUserAddress: "Synthetic User" }).agent.agentId;
		roomModels.writeRoomModels(agentId, { conversation: NARROW, memory: NARROW });
		agents.writePersistentAgentThread(agentId, pageConversation, { state: "standby", origin: "home", model: NARROW, items: [{ kind: "user", id: "u1", text: "Earlier question." }, { kind: "assistant", id: "a1", text: "Earlier answer." }] }, {
			createRuntime: ({ model }) => agents.createPersistentAgentPiSessionJsonlThreadRuntime({ agentId, threadId: pageConversation, model, cwd: threadCwd }),
		});
		return agentId;
	})();

	server = spawn("npx", ["tsx", "src/index.ts"], {
		shell: process.platform === "win32",
		...SMOKE_SERVER_SPAWN_TREE_OPTIONS,
		cwd: webServerDir,
		// The warn lines are the assertion; the launcher's production default keeps them.
		env: smokeHomeEnv(tempHome, { PORT: String(port), ...SMOKE_SERVER_AUTH_ENV, EXXETA_HOME: repoRoot, EXXPERTS_CODING_AGENT_DIR: agentDir, EXXETA_PERSISTENT_AGENTS_ROOT: agentsRoot, LOG_LEVEL: "warn", ANTHROPIC_API_KEY: undefined, OPENAI_API_KEY: undefined }) as NodeJS.ProcessEnv,
	});
	server.stdout.on("data", (chunk) => serverOutput.push(String(chunk)));
	server.stderr.on("data", (chunk) => serverOutput.push(String(chunk)));
	await waitForServer(server, baseUrl, 30_000);

	const created = await api("/api/persistent-agents", { method: "POST", body: { displayName: "Chat Room", userName: "Synthetic User", preferredUserAddress: "Synthetic User" } });
	const chatRoom = String(created.body?.agent?.id ?? "");
	assert(created.status === 201 && chatRoom, `the chat room is made, got ${created.status} ${JSON.stringify(created.body)}`);
	const conversationId = "c_provider_words";
	const thread = await api(`/api/persistent-agents/${chatRoom}/threads/${conversationId}`, { method: "PUT", body: { state: "active", origin: "launcher", model: NARROW, items: [] } });
	assert(thread.status === 200, `the conversation is made, got ${thread.status} ${JSON.stringify(thread.body)}`);
	const room = await connect(chatRoom, conversationId);
	sockets.push(room);

	// --- 1. The room's condensing refused --------------------------------------------------
	const settled = async () => {
		await waitUntil(async () => (await api(`/api/persistent-agents/${chatRoom}/status`)).body?.activeThread?.inFlight === false, "the turn settles", 20_000);
	};
	room.send({ type: "prompt", text: "Say something short." });
	await waitUntil(() => room.frames.some((frame) => frame.type === "event" && frame.event?.type === "agent_end"), "the first answer", 25_000);
	await settled();
	room.send({ type: "prompt", text: SHORTEN });
	await waitUntil(() => room.frames.some((frame) => frame.type === "ui_request" && frame.kind === "notify" && frame.level === "error"), "the condensing's failure notice", 25_000);
	const notice = room.frames.find((frame) => frame.type === "ui_request" && frame.kind === "notify" && frame.level === "error");
	// The runtime hands the summary's failure up as words alone: the codes are read from them.
	await codesOnly("auto-compaction failed", { reason: "threshold", cause: "refused", status: 400 });
	assert(notice.failure === "refused" && String(notice.words ?? "").includes(MARKER), `the page still gets the provider's words for Details, got ${JSON.stringify(notice)}`);
	pass("a refused condensing logs its codes, never the provider's words; the notice keeps them for the page");
	await settled();

	// --- 2. A consult on a Memory model the provider no longer serves ----------------------
	const consultId = "consult_provider_words";
	room.send({ type: "consult", consultId, targetRoomId: consultedRoom, question: "What did we settle?" });
	await waitUntil(() => room.frames.some((frame) => (frame.type === "consult_error" || frame.type === "consult_end") && frame.consultId === consultId), "the consult ends", 30_000);
	const ended = room.frames.find((frame) => (frame.type === "consult_error" || frame.type === "consult_end") && frame.consultId === consultId);
	assert(ended.type === "consult_error" && /no longer offered/.test(String(ended.message)) && !String(ended.message).includes(MARKER), `the consult ends with the plain line, got ${JSON.stringify(ended)}`);
	await codesOnly("the provider refused the consulted room's Memory model", { cause: "unreachable:not-offered", status: 404 });
	pass("a consult on a Memory model no longer served logs its codes, never the provider's words");

	// --- 3. HiveMind's question refused ------------------------------------------------------
	const asked = await api("/api/memory/ask", { method: "POST", body: { question: "When do invoices go out?", rooms: [askedRoom] }, timeoutMs: 70_000 });
	assert(asked.body?.ok === false && asked.body?.reason === "error" && !JSON.stringify(asked.body).includes(MARKER), `HiveMind answers with its own line, got ${asked.status} ${JSON.stringify(asked.body)}`);
	await codesOnly("memory ask failed", { cause: "other", status: 400, errorType: "invalid_request_error" });
	pass("a refused HiveMind question logs its codes, never the provider's words");

	// --- 1, in the page: Details shows the words, and the saved conversation keeps them ---
	const chromiumPath = typeof chromium?.executablePath === "function" ? chromium.executablePath() : "";
	if (!chromiumPath || !fs.existsSync(chromiumPath)) {
		console.log("  skip  the page's Details and saved conversation (Chromium not installed)");
	} else {
		const browser = await chromium.launch();
		try {
			const ui = await (await browser.newContext({ viewport: { width: 1280, height: 900 } })).newPage();
			await ui.goto(`${baseUrl}/auth/session?token=${SMOKE_AUTH_TOKEN}`);
			await ui.waitForLoadState("networkidle");
			const dismiss = ui.locator(".whats-new-close");
			if (await dismiss.count()) await dismiss.click();
			await ui.locator(".persistent-agent-card").filter({ hasText: PAGE_ROOM }).getByRole("button", { name: "Resume" }).click();
			await ui.locator('button[title="Send"]').first().waitFor({ timeout: 15_000 });
			// One exchange in this visit first: the condensing has it to shorten.
			await ui.locator("textarea").first().fill("Say something short.");
			await sendFromBox(ui);
			await waitUntil(async () => (await ui.getByText("Short answer.").count()) === 1, "the first answer shows", 25_000);
			await waitUntil(async () => (await api(`/api/persistent-agents/${pageRoom}/status`)).body?.activeThread?.inFlight === false, "the first turn settles", 20_000);
			await ui.locator("textarea").first().fill(SHORTEN);
			await sendFromBox(ui);
			const line = ui.locator(".failure-line:not(.is-folded)").last();
			await line.waitFor({ timeout: 30_000 }).catch(async () => {
				throw new Error(`the failure line never showed: ${logLines("auto-compaction failed").length} log lines, the page says ${JSON.stringify((await ui.locator("body").innerText()).slice(-800))}`);
			});
			await waitUntil(() => logLines("auto-compaction failed").length === 2, "the page room's \"auto-compaction failed\" line", 20_000);
			assert(!logLines("auto-compaction failed").some((logged) => logged.raw.includes(MARKER)), "the page room's line keeps the provider's words out of the log");
			assert(!(await line.innerText()).includes(MARKER), `the line itself never shows the provider's words, got ${JSON.stringify(await line.innerText())}`);
			await line.getByRole("button", { name: "Show details" }).click();
			await waitUntil(async () => (await line.innerText()).includes(MARKER), "Details shows the provider's words", 10_000);
			const savedDetails = async () => {
				const thread = (await api(`/api/persistent-agents/${pageRoom}/threads/${pageConversation}`)).body;
				const items: any[] = thread?.thread?.items ?? thread?.items ?? [];
				return items.filter((item) => item?.kind === "system" && item?.level === "error").map((item) => String(item.details ?? ""));
			};
			await waitUntil(async () => (await savedDetails()).some((details) => details.includes(MARKER)), "the saved conversation keeps the words with the line", 15_000).catch(async () => {
				throw new Error(`the saved conversation keeps ${JSON.stringify(await savedDetails())}`);
			});
			pass("in the page, a refused condensing's Details shows the provider's words and the saved conversation keeps them");
		} finally {
			await browser.close();
		}
	}

	console.log(`provider-words-log-smoke: ${passes} checks passed`);
} catch (error) {
	console.error(`provider-words-log-smoke FAILED: ${(error as Error).message}`);
	if (serverOutput.length > 0) console.error(serverOutput.join("").split("\n").filter((line) => !line.includes("token=")).join("\n").slice(-4000));
	process.exitCode = 1;
} finally {
	for (const socket of sockets) socket.close();
	if (server) await stopSmokeServer(server);
	await new Promise<void>((resolve) => provider.close(() => resolve()));
	try { fs.rmSync(tempRoot, { recursive: true, force: true }); } catch {}
}
