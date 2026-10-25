// The page's two guards for the server's graceful stop, in the browser against
// a real spawned server, its real stop (SIGTERM) and one synthetic Anthropic
// endpoint on a Claude API key:
//
// - an answer that ends whole while the server stops (its agent_end carries no
//   stoppedByServer) is never stamped "the connection was lost", even while
//   its reveal is still running at the close, and is never saved so;
// - an approval card stops taking clicks at the stop's notice: a click after
//   it never records "You approved this command.";
// - the notice counts before the connection's ready too, and only for that
//   connection: the next one, after the restart, takes clicks again.
//
// The cards are sent by the smoke on the page's end of the room's socket; the
// notice is the server's own, except in the row that sends it before ready.
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { authedFetch, SMOKE_AUTH_TOKEN, SMOKE_SERVER_AUTH_ENV, SMOKE_SERVER_SPAWN_TREE_OPTIONS, smokeHomeEnv, stopSmokeServer, freePort } from "./smoke-server-process.js";

function assert(condition: unknown, message: string): asserts condition {
	if (!condition) throw new Error(message);
}

{
	const p = typeof chromium?.executablePath === "function" ? chromium.executablePath() : "";
	if (!p || !fs.existsSync(p)) {
		console.log("room stop notice smoke skipped (Chromium not installed)");
		process.exit(0);
	}
}
// On Windows a stop is a forced kill, so no notice is ever sent.
if (process.platform === "win32") {
	console.log("room stop notice smoke skipped (no graceful stop on Windows)");
	process.exit(0);
}

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const webServerDir = path.resolve(scriptDir, "..");
const repoRoot = path.resolve(webServerDir, "..", "..");
const port = await freePort();
const baseUrl = `http://127.0.0.1:${port}`;

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "exxperts-stop-notice-"));
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
const CONNECTION_LOST = "Response interrupted: the connection was lost.";
const APPROVED = "You approved this command.";
// A long answer streamed over about a second: it ends inside the stop's wait, and its reveal runs on well past the close.
const PARTS = 24;
const part = (index: number) => `Part ${index + 1} of the long answer says something worth reading slowly, one sentence after another, to the very end. `;
const LAST_WORDS = `Part ${PARTS} of the long answer`;

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
		let index = 0;
		const timer = setInterval(() => {
			if (index < PARTS) {
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
		}, 40);
		res.on("close", () => clearInterval(timer));
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

let server: ChildProcessWithoutNullStreams | undefined;
const serverOutput: string[] = [];
const failures: string[] = [];
const expect = (condition: unknown, message: string) => { if (!condition) failures.push(message); };

try {
	await new Promise<void>((resolve) => endpoint.listen(0, "127.0.0.1", resolve));
	const endpointUrl = `http://127.0.0.1:${(endpoint.address() as AddressInfo).port}`;
	fs.writeFileSync(path.join(agentDir, "models.json"), JSON.stringify({ providers: { [KEY_PROVIDER]: { baseUrl: endpointUrl } } }, null, 2), { mode: 0o600 });
	fs.writeFileSync(path.join(agentDir, "auth.json"), JSON.stringify({ [KEY_PROVIDER]: { type: "api_key", key: "synthetic-anthropic-key" } }, null, 2), { mode: 0o600 });
	fs.writeFileSync(path.join(agentDir, "settings.json"), JSON.stringify({ retry: { baseDelayMs: 1000, provider: { maxRetries: 0 } } }, null, 2), { mode: 0o600 });
	const agents = await import("../src/persistent-agents.js");
	const agentId = agents.createPersistentAgentFromScaffoldInput({ displayName: "Stop Room", userName: "Synthetic User", preferredUserAddress: "Synthetic User" }).agent.agentId;
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
		// The page's end of the room's socket, passed through. A scene can send the page a frame of its own,
		// hold the close until it has looked, or put the notice ahead of the next connection's ready.
		let pageSocket: { send(message: string): void } | undefined;
		const socket = { noticeSeen: false, holdClose: false, release: undefined as undefined | (() => void), noticeBeforeReady: false };
		await page.routeWebSocket(/\/ws\?/, (ws) => {
			pageSocket = ws;
			const upstream = ws.connectToServer();
			ws.onMessage((message) => upstream.send(message));
			upstream.onMessage((message) => {
				const text = String(message);
				if (text.includes('"type":"server_stopping"')) socket.noticeSeen = true;
				if (socket.noticeBeforeReady && text.includes('"type":"ready"')) {
					socket.noticeBeforeReady = false;
					ws.send(JSON.stringify({ type: "server_stopping" }));
				}
				ws.send(message);
			});
			upstream.onClose((code, reason) => {
				if (!socket.holdClose) { ws.close({ code, reason }); return; }
				socket.release = () => ws.close({ code, reason });
			});
			ws.onClose(() => upstream.close());
		});
		const open = async () => {
			await page.goto(`${baseUrl}/auth/session?token=${SMOKE_AUTH_TOKEN}`);
			await page.waitForLoadState("networkidle");
			const dismiss = page.locator(".whats-new-close");
			if (await dismiss.count()) await dismiss.click();
			await page.locator(".persistent-agent-card").filter({ hasText: "Stop Room" }).getByRole("button", { name: /^(Enter|Resume) →$/ }).click();
			await page.locator('button[title="Send"]').first().waitFor({ timeout: 15000 });
			await page.waitForTimeout(800);
		};
		await open();
		const composer = page.locator("textarea").first();
		const card = (id: string) => ({ type: "ui_request", kind: "confirm", id, title: "Run this command?", message: `echo ${id}` });
		const approvedLines = () => page.getByText(APPROVED).count();
		// Clicks the newest card's Yes when it still offers one; a card that stopped taking clicks has none.
		const clickYes = async () => {
			const yes = page.locator(".approval-row .btn-primary").last();
			if (await yes.count()) await yes.click({ timeout: 1000 }).catch(() => {});
		};
		const savedItems = async () => {
			const status = await (await authedFetch(`${baseUrl}/api/persistent-agents/${agentId}/status`)).json();
			const threadId = String(status?.activeThread?.threadId ?? "");
			const thread = await (await authedFetch(`${baseUrl}/api/persistent-agents/${agentId}/threads/${encodeURIComponent(threadId)}`)).json();
			return (thread?.thread?.items ?? thread?.items ?? []) as any[];
		};

		// An answer that ends whole while the server stops, with a card open: the server's notice comes first, the answer ends in the wait, then the close.
		await composer.fill("A long answer, please.");
		await composer.press("Enter");
		await waitUntil(() => deltasSent >= 2, "the answer has begun");
		pageSocket?.send(JSON.stringify(card("card-before-stop")));
		await page.locator(".approval-row .btn-primary").last().waitFor({ timeout: 5000 });
		socket.holdClose = true;
		const stopped = stopSmokeServer(server);
		await waitUntil(() => socket.noticeSeen, "the server's notice reached the page", 10_000);
		await page.waitForTimeout(300);
		await clickYes();
		await page.waitForTimeout(300);
		expect((await approvedLines()) === 0, "a click after the stop's notice recorded the approval");
		// The close, once the answer has ended: its reveal is still running.
		await waitUntil(() => socket.release !== undefined, "the server closed the connection", 10_000);
		socket.release?.();
		await stopped;
		await waitUntil(async () => (await page.getByText(LAST_WORDS).count()) > 0, "the whole answer is revealed", 30_000);
		await page.waitForTimeout(800);
		expect((await page.getByText(CONNECTION_LOST).count()) === 0, "an answer that ended whole during the stop was stamped as a lost connection");
		socket.holdClose = false;
		socket.release = undefined;
		socket.noticeSeen = false;

		// The restart: the next connection gets the notice before its ready, as one still opening when a stop begins does.
		socket.noticeBeforeReady = true;
		await startServer();
		await page.locator('button[title="Send"]').first().waitFor({ timeout: 20000 });
		await waitUntil(() => !socket.noticeBeforeReady, "the notice went ahead of ready", 20_000);
		await page.waitForTimeout(800);
		const saved = await savedItems();
		expect(!JSON.stringify(saved).includes(CONNECTION_LOST), "the saved conversation calls an answer that ended during the stop a lost connection");
		expect(saved.some((item) => item?.kind === "assistant" && String(item?.text ?? "").includes(LAST_WORDS)), "the whole answer was not saved");
		pageSocket?.send(JSON.stringify(card("card-after-early-notice")));
		await page.waitForTimeout(500);
		await clickYes();
		await page.waitForTimeout(300);
		expect((await approvedLines()) === 0, "a card on a connection told of the stop before its ready took a click");

		// A new connection starts clean: its cards take clicks again.
		await open();
		const approvedBefore = await approvedLines();
		pageSocket?.send(JSON.stringify(card("card-on-a-new-connection")));
		await page.locator(".approval-row .btn-primary").last().waitFor({ timeout: 5000 });
		await clickYes();
		await waitUntil(async () => (await approvedLines()) === approvedBefore + 1, "a card on a new connection takes the click", 5000).catch(() => {});
		expect((await approvedLines()) === approvedBefore + 1, "a card on the next connection did not take its click");

		assert(failures.length === 0, `the stop's guards:\n  ${failures.join("\n  ")}`);
		console.log("  ok  an answer that ends whole while the server stops is never stamped or saved as a lost connection, its reveal running on");
		console.log("  ok  a card stops taking clicks at the stop's notice, also when the notice comes before ready");
		console.log("  ok  the next connection starts clean: its cards take clicks");
	} finally {
		await browser.close();
	}
	console.log("room-stop-notice smoke: ok");
} catch (error) {
	console.error(serverOutput.join("").slice(-6000));
	throw error;
} finally {
	try { (endpoint as any).closeAllConnections?.(); } catch {}
	try { endpoint.close(); } catch {}
	await stopSmokeServer(server);
	fs.rmSync(tempRoot, { recursive: true, force: true });
}
