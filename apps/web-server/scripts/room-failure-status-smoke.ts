// A failed message whose words name nothing still says what happened, when
// its status does. A local stand-in for the ChatGPT backend answers each room
// with one status and a body of words no reader knows; the ChatGPT sign-in's
// client writes no status into its words, so only the status the runtime keeps
// beside them can tell the kinds apart. In the browser, each room shows the
// line its kind already has:
//
// - 401 the sign-in notice; 402 the usage-limit line; 403 the refused-request
//   line; 404 the line for a model no longer offered;
// - 429, 500, 502, 503 and 504 are not asked again by the runtime, since the
//   ChatGPT sign-in's client already asked them again itself: no retry note;
//   a 429 then says "still busy", since the client did try several times,
//   and a 5xx the plain line;
// - 529, which that client does not ask again, is asked again with the busy
//   note, then "still busy";
// - a 429 in the backend's own rate-limit words is not asked again either:
//   the client's own tries are the only requests, no retry note, then
//   "still busy";
// - 413 keeps the plain line, as a request too large does in the chat;
// - the server's log line names each kind and its status.
//
// Offline: the backend is a local fake. The rooms run side by side.
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import { fileURLToPath } from "node:url";
import { chromium, type Browser } from "playwright";
import { authedFetch, SMOKE_AUTH_TOKEN, SMOKE_SERVER_AUTH_ENV, SMOKE_SERVER_SPAWN_TREE_OPTIONS, smokeHomeEnv, stopSmokeServer, freePort } from "./smoke-server-process.js";

function assert(condition: unknown, message: string): asserts condition {
	if (!condition) throw new Error(message);
}

// A machine without Chromium cannot run a browser assertion at all; skip
// whole, the same way room-failure-line-smoke does.
{
	const p = typeof chromium?.executablePath === "function" ? chromium.executablePath() : "";
	if (!p || !fs.existsSync(p)) {
		console.log("room failure status smoke skipped (Chromium not installed)");
		process.exit(0);
	}
}

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const webServerDir = path.resolve(scriptDir, "..");
const repoRoot = path.resolve(webServerDir, "..", "..");
const port = await freePort();
const baseUrl = `http://127.0.0.1:${port}`;

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "exxperts-failure-status-"));
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

const SOL = { provider: "openai-codex", model: "gpt-6.1-sol" };
const NAME = "GPT-6.1 Sol";
// Words no reader knows: no status, no type, nothing a matcher takes.
const UNKNOWN = "Something unusual happened on our side.";
const PLAIN = `${NAME} could not answer this message.`;
const STILL_BUSY = `${NAME} is still busy after several tries.`;

type Expected = { status: number; worded?: true; cause?: string; notice?: true; retry?: "busy" | "provider-error"; logged: string };
const cases: Expected[] = [
	{ status: 401, notice: true, logged: "unreachable:signed-out" },
	{ status: 402, cause: `${NAME} has reached your plan's usage limit.`, logged: "unreachable:quota" },
	{ status: 403, cause: `${NAME} refused this request: it may not be offered in your region or on your plan.`, logged: "unreachable:region-or-plan" },
	{ status: 404, cause: `This room's model, ${NAME} on ChatGPT Plus/Pro, is no longer offered.`, logged: "unreachable:not-offered" },
	{ status: 413, cause: PLAIN, logged: "too-large" },
	{ status: 429, cause: STILL_BUSY, logged: "busy:too-many-requests" },
	{ status: 500, cause: PLAIN, logged: "busy:server-error" },
	{ status: 502, cause: PLAIN, logged: "busy:server-error" },
	{ status: 503, cause: PLAIN, logged: "busy:server-error" },
	{ status: 504, cause: PLAIN, logged: "busy:server-error" },
	{ status: 529, cause: STILL_BUSY, retry: "busy", logged: "busy:overload" },
	{ status: 429, worded: true, cause: STILL_BUSY, logged: "busy:rate-limit" },
];
const caseKey = (expected: Expected) => `${expected.status}${expected.worded ? " worded" : ""}`;
const roomName = (expected: Expected) => `Status ${caseKey(expected)} Room`;
// The client's own tries: its first request and three more.
const CLIENT_TRIES = 4;
// A short rate limit in the backend's own shape, whose words the runtime's retry words also match.
const RATE_LIMIT_WORDS = "Rate limit reached for gpt-6.1-sol on tokens per min (TPM): Limit 30000, Used 29000. Please try again in 20s.";
const requestsFor = new Map<string, number>();

// The ChatGPT backend: every request fails with the status its message names,
// in a bare `detail` body. A WebSocket upgrade finds no listener, so the
// runtime falls back to the plain request.
const backend = http.createServer((req, res) => {
	let raw = "";
	req.on("data", (chunk) => { raw += chunk; });
	req.on("end", () => {
		const asked = /\bstatus (\d{3})( worded)? please\b/.exec(raw);
		const status = Number(asked?.[1] ?? 400);
		const key = `${status}${asked?.[2] ?? ""}`;
		requestsFor.set(key, (requestsFor.get(key) ?? 0) + 1);
		res.writeHead(status, { "content-type": "application/json" });
		res.end(JSON.stringify(asked?.[2] ? { error: { type: "tokens", code: "rate_limit_exceeded", message: RATE_LIMIT_WORDS } } : { detail: UNKNOWN }));
	});
});

// A ChatGPT sign-in as the runtime reads it: a token carrying an account id.
const base64 = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64").replace(/=+$/, "");
const syntheticToken = `${base64({ alg: "none" })}.${base64({ "https://api.openai.com/auth": { chatgpt_account_id: "synthetic-account" } })}.synthetic`;

async function waitUntil(predicate: () => Promise<boolean> | boolean, label: string, timeoutMs = 25_000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (await predicate()) return;
		await new Promise((resolve) => setTimeout(resolve, 200));
	}
	throw new Error(`timed out waiting until ${label}`);
}

let server: ChildProcessWithoutNullStreams | undefined;
const serverOutput: string[] = [];

// One room's message, sent in its own page: the line, or the notice, it ends in, and the retry notes it got.
async function roomShows(browser: Browser, expected: Expected): Promise<void> {
	const room = roomName(expected);
	const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
	try {
		const page = await ctx.newPage();
		const retryFrames: Array<{ failure?: string }> = [];
		page.on("websocket", (socket) => socket.on("framereceived", (frame) => {
			try {
				const data = JSON.parse(String(frame.payload));
				if (data?.event?.type === "auto_retry_start") retryFrames.push(data.event);
			} catch {}
		}));
		await page.goto(`${baseUrl}/auth/session?token=${SMOKE_AUTH_TOKEN}`);
		await page.waitForLoadState("networkidle");
		const dismiss = page.locator(".whats-new-close");
		if (await dismiss.count()) await dismiss.click();
		await page.locator(".persistent-agent-card").filter({ hasText: room }).getByRole("button", { name: "Resume →" }).click();
		const composer = page.locator("textarea").first();
		await page.locator('button[title="Send"]').first().waitFor({ timeout: 15000 });
		await page.waitForTimeout(800);
		const sent = `A question, status ${caseKey(expected)} please.`;
		await composer.fill(sent);
		await composer.press("Enter");
		const newest = async () => (await page.locator(".failure-line:not(.is-folded) .system-line-text").allInnerTexts()).map((text) => text.replace(/\s+/g, " ").trim()).at(-1) ?? "";
		const banner = page.locator(".room-model-notice");
		const shown = async () => expected.notice ? (await banner.count()) > 0 && /is signed out/.test(await banner.innerText()) : (await newest()).startsWith(expected.cause!);
		await waitUntil(shown, `${room}: the room shows the kind's line`, 90_000).catch(async () => {
			throw new Error(`${room}: expected ${expected.notice ? "the sign-in notice" : JSON.stringify(expected.cause)}; the newest line says ${JSON.stringify(await newest())}, the notice ${JSON.stringify((await banner.count()) ? await banner.innerText() : null)}`);
		});
		assert(!(await page.locator("body").innerText()).includes(expected.worded ? RATE_LIMIT_WORDS : UNKNOWN), `${room}: the provider's words stay off the face`);
		await waitUntil(async () => (await composer.inputValue()) === sent, `${room}: the message is back in the box, got ${JSON.stringify(await composer.inputValue())}`, 15_000);
		if (expected.worded) assert((requestsFor.get(caseKey(expected)) ?? 0) <= CLIENT_TRIES, `${room}: only the client's own ${CLIENT_TRIES} tries reach the backend, got ${requestsFor.get(caseKey(expected))}`);
		const notes = retryFrames.map((frame) => frame.failure);
		if (expected.retry) assert(notes.length > 0 && notes.every((note) => note === expected.retry), `${room}: asked again with the ${expected.retry} note, got ${JSON.stringify(notes)}`);
		else assert(notes.length === 0, `${room}: not asked again, got ${JSON.stringify(notes)}`);
	} finally {
		await ctx.close();
	}
}

try {
	await new Promise<void>((resolve) => backend.listen(0, "127.0.0.1", resolve));
	const backendPort = (backend.address() as AddressInfo).port;
	fs.writeFileSync(path.join(agentDir, "models.json"), JSON.stringify({ providers: { "openai-codex": { baseUrl: `http://127.0.0.1:${backendPort}` } } }, null, 2), { mode: 0o600 });
	fs.writeFileSync(path.join(agentDir, "auth.json"), JSON.stringify({ "openai-codex": { type: "api_key", key: syntheticToken } }, null, 2), { mode: 0o600 });
	fs.writeFileSync(path.join(appDir, "persistent-agent-ai-profile.json"), JSON.stringify({ profileId: "chatgpt-codex" }, null, 2), { mode: 0o600 });
	// One retry of the runtime's own, soon, so a busy status is asked again once.
	fs.writeFileSync(path.join(agentDir, "settings.json"), JSON.stringify({ retry: { maxRetries: 1, baseDelayMs: 500 } }, null, 2), { mode: 0o600 });

	const agents = await import("../src/persistent-agents.js");
	const roomModels = await import("../src/room-models.js");
	const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
	// A room on GPT-6.1 Sol with a conversation started on it.
	for (const expected of cases) {
		const agentId = agents.createPersistentAgentFromScaffoldInput({ displayName: roomName(expected), userName: "Synthetic User", preferredUserAddress: "Synthetic User" }).agent.agentId;
		roomModels.writeRoomModels(agentId, { conversation: SOL, memory: SOL });
		const conversationId = `c_status_${caseKey(expected).replace(" ", "_")}`;
		const created = agents.writePersistentAgentThread(agentId, conversationId, { state: "standby", origin: "home", model: SOL, items: [{ kind: "user", id: "u1", text: "Earlier question." }, { kind: "assistant", id: "a1", text: "Earlier answer." }] }, {
			createRuntime: ({ model }) => agents.createPersistentAgentPiSessionJsonlThreadRuntime({ agentId, threadId: conversationId, model, cwd: threadCwd }),
		});
		const seed = agents.openPersistentAgentPiSessionManager(agentId, created.thread.runtime as any, threadCwd);
		seed.appendMessage({ role: "user", content: [{ type: "text", text: "Earlier question." }], timestamp: Date.now() } as any);
		seed.appendMessage({ role: "assistant", content: [{ type: "text", text: "Earlier answer." }], api: "openai-codex-responses", provider: SOL.provider, model: SOL.model, usage, stopReason: "stop", timestamp: Date.now() } as any);
	}

	server = spawn("npx", ["tsx", "src/index.ts"], {
		shell: process.platform === "win32",
		...SMOKE_SERVER_SPAWN_TREE_OPTIONS,
		cwd: webServerDir,
		env: smokeHomeEnv(tempHome, { PORT: String(port), ...SMOKE_SERVER_AUTH_ENV, EXXETA_HOME: repoRoot, EXXPERTS_CODING_AGENT_DIR: agentDir, EXXETA_PERSISTENT_AGENTS_ROOT: agentsRoot }) as NodeJS.ProcessEnv,
	});
	server.stdout.on("data", (chunk) => serverOutput.push(String(chunk)));
	server.stderr.on("data", (chunk) => serverOutput.push(String(chunk)));
	await waitUntil(() => fetch(`${baseUrl}/healthz`).then((r) => r.ok).catch(() => false), "server ready");
	assert((await authedFetch(`${baseUrl}/healthz`)).ok, "the server answers");

	const browser = await chromium.launch();
	try {
		const settled = await Promise.allSettled(cases.map((expected) => roomShows(browser, expected)));
		const failed = settled.flatMap((result) => (result.status === "rejected" ? [result.reason instanceof Error ? result.reason.message : String(result.reason)] : []));
		assert(failed.length === 0, `rooms that did not show their kind's line:\n${failed.join("\n")}`);
	} finally {
		await browser.close();
	}
	console.log("  ok  words that name nothing: each status shows its kind's line in the room, the sign-in notice for a 401; a 529 is asked again with its note, and the statuses the client already asked again are not asked on top, whatever their words");

	// The log line per failed call names the kind the status gave, and the status.
	const logged = serverOutput.join("").split("\n").filter((line) => line.includes("provider call failed")).map((line) => { try { return JSON.parse(line); } catch { return null; } }).filter(Boolean) as Array<{ cause?: string; status?: number; callKind?: string }>;
	const misLogged = cases.filter((expected) => !logged.some((line) => line.callKind === "chat" && line.status === expected.status && line.cause === expected.logged)).map((expected) => `${expected.status} as ${expected.logged}`);
	assert(misLogged.length === 0, `the log names each kind and its status; missing ${misLogged.join(", ")}; got ${JSON.stringify(logged.map((line) => [line.status, line.cause]))}`);
	console.log("  ok  the log line names each kind and its status");
	console.log("room-failure-status smoke: ok");
} catch (error) {
	console.error(serverOutput.join("").split("\n").filter((line) => !line.includes("token=")).join("\n").slice(-6000));
	throw error;
} finally {
	try { (backend as any).closeAllConnections?.(); } catch {}
	try { backend.close(); } catch {}
	await stopSmokeServer(server);
	fs.rmSync(tempRoot, { recursive: true, force: true });
}
