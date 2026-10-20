// Forget throws a running task's result away, end to end: a real server, a
// synthetic gateway, a real websocket and a real specialist worker.
//
// The room is asked for a document; the gateway has it start the specialist on
// the person's own words, and the specialist writes one file into its task
// folder and is then held mid-task. Forget is pressed while it is held. Then:
//   - opening the fresh conversation brings no card of the task back;
//   - the task folder and its ledger row are gone;
//   - the fresh conversation carries no handoff from it;
//   - nothing lands on the room's shelf, and no file holds the task's words.
// The card's "The task was cancelled." is not checked: Forget closes the
// socket in the same request, so the aborted task's last frame reaches no one,
// and the person sees the fresh conversation without the card.
//
// Mutation proof (decision 32's code was there before this smoke): with the
// discard check in src/index.ts forced off (taskDiscarded returning false), the
// task's "cancelled" handoff lands on the fresh conversation and check 3 fails.
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import { fileURLToPath } from "node:url";
import { authedFetch, SMOKE_AUTH_HEADERS, SMOKE_SERVER_AUTH_ENV, SMOKE_SERVER_SPAWN_TREE_OPTIONS, stopSmokeServer, freePort, type AuthedFetchInit } from "./smoke-server-process.js";

function assert(condition: unknown, message: string): asserts condition {
	if (!condition) throw new Error(message);
}

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const webServerDir = path.resolve(scriptDir, "..");
const repoRoot = path.resolve(webServerDir, "..", "..");
const port = await freePort();
const baseUrl = `http://127.0.0.1:${port}`;

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "exxperts-forget-task-"));
const tempHome = path.join(tempRoot, "home");
const agentsRoot = path.join(tempHome, ".exxperts", "app", "personalized-agents");
const agentDir = path.join(tempHome, ".exxperts", "agent");
const productAppRoot = path.join(tempHome, ".exxperts", "app");
fs.mkdirSync(agentsRoot, { recursive: true, mode: 0o700 });
fs.mkdirSync(agentDir, { recursive: true, mode: 0o700 });

const ASK = "Make me a one-page document about the harbour plan.";
/** Only the specialist's file holds it. */
const WORD = "BRACKENSHOAL";

// ---------------------------------------------------------------------------
// The gateway. The room's first leg starts the specialist on the person's own
// words, its second says it is underway. The specialist's first leg writes one
// file; its second is held open until the client goes away.
// ---------------------------------------------------------------------------
let specialistHeld = false;

function sseChunk(payload: unknown): string {
	return `data: ${JSON.stringify(payload)}\n\n`;
}

const gateway = http.createServer((req, res) => {
	if (req.method !== "POST" || !String(req.url ?? "").endsWith("/chat/completions")) {
		res.writeHead(404).end();
		return;
	}
	let body = "";
	req.on("data", (chunk) => { body += chunk; });
	req.on("end", () => {
		let parsed: any = {};
		try { parsed = JSON.parse(body); } catch {}
		const messages: any[] = Array.isArray(parsed?.messages) ? parsed.messages : [];
		const toolNames: string[] = (parsed?.tools ?? []).map((tool: any) => tool?.function?.name ?? tool?.name);
		const firstLeg = !messages.some((message) => message?.role === "tool");
		const room = toolNames.includes("delegate_task");
		res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
		const base = { id: `cmpl_${Date.now()}`, object: "chat.completion.chunk", created: Math.floor(Date.now() / 1000), model: String(parsed?.model ?? "room-model") };
		const call = (name: string, args: unknown) => {
			res.write(sseChunk({ ...base, choices: [{ index: 0, delta: { role: "assistant", tool_calls: [{ index: 0, id: `call_${name}`, type: "function", function: { name, arguments: JSON.stringify(args) } }] }, finish_reason: null }] }));
			res.write(sseChunk({ ...base, choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }], usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 } }));
			res.end("data: [DONE]\n\n");
		};
		if (room && firstLeg) return call("delegate_task", { template: "document-html", brief: "A one-page HTML document about the harbour plan: berths, dates, owners.", userRequest: ASK });
		// The specialist writes where its prompt tells it to.
		const folder = /pass folder: \\?"([^"\\]+)\\?"/.exec(body)?.[1];
		if (!room && firstLeg) return call("artifact_write", { filename: "harbour-plan.html", folder, content: `<!doctype html><html><body><h1>${WORD}</h1></body></html>` });
		if (!room) {
			// Held: the task is mid-way when Forget arrives.
			specialistHeld = true;
			res.write(sseChunk({ ...base, choices: [{ index: 0, delta: { role: "assistant", content: "Working" }, finish_reason: null }] }));
			return;
		}
		res.write(sseChunk({ ...base, choices: [{ index: 0, delta: { role: "assistant", content: "It is underway." }, finish_reason: null }] }));
		res.write(sseChunk({ ...base, choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 100, completion_tokens: 5, total_tokens: 105 } }));
		res.end("data: [DONE]\n\n");
	});
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

async function until(check: () => boolean, label: string, timeoutMs = 20_000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (!check()) {
		if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
		await sleep(25);
	}
}

async function waitForServer(server: ChildProcessWithoutNullStreams): Promise<void> {
	const deadline = Date.now() + 20_000;
	while (Date.now() < deadline) {
		if (server.exitCode != null) throw new Error(`server exited before startup with code ${server.exitCode}`);
		try {
			if ((await fetch(`${baseUrl}/healthz`)).ok) return;
		} catch { /* not up yet */ }
		await sleep(150);
	}
	throw new Error("server did not become ready");
}

async function requestJson(pathname: string, init: AuthedFetchInit = {}): Promise<{ status: number; body: any }> {
	const response = await authedFetch(`${baseUrl}${pathname}`, { ...init, headers: { ...(init.body ? { "content-type": "application/json" } : {}), ...init.headers } });
	const text = await response.text();
	return { status: response.status, body: text ? JSON.parse(text) : null };
}

type Frame = Record<string, any>;
const WebSocketImpl: any = (await import("ws")).default;

let server: ChildProcessWithoutNullStreams | undefined;
const serverOutput: string[] = [];
let socket: any = null;
const frames: Frame[] = [];
const frameOf = (type: string) => frames.find((frame) => frame.type === type);

try {
	await new Promise<void>((resolve) => gateway.listen(0, "127.0.0.1", resolve));
	const gatewayPort = (gateway.address() as AddressInfo).port;
	fs.writeFileSync(path.join(agentDir, "models.json"), JSON.stringify({ providers: { "openai-compatible": { name: "Synthetic Gateway", baseUrl: `http://127.0.0.1:${gatewayPort}/v1`, api: "openai-completions", models: [{ id: "room-model", name: "Room Model", contextWindow: 128000, maxTokens: 16384 }] } } }, null, 2), { mode: 0o600 });
	fs.writeFileSync(path.join(agentDir, "auth.json"), JSON.stringify({ "openai-compatible": { type: "api_key", key: "synthetic-forget-task-key" } }, null, 2), { mode: 0o600 });
	fs.writeFileSync(path.join(productAppRoot, "openai-compatible-ai-profile.json"), JSON.stringify({ profileId: "openai-compatible", providerId: "openai-compatible", label: "Synthetic Gateway", roomModels: [{ modelId: "room-model", label: "Room Model" }], maintenanceModel: "room-model" }, null, 2), { mode: 0o600 });
	fs.writeFileSync(path.join(productAppRoot, "persistent-agent-ai-profile.json"), JSON.stringify({ profileId: "openai-compatible" }, null, 2), { mode: 0o600 });

	process.env.HOME = tempHome;
	process.env.USERPROFILE = tempHome;
	process.env.EXXPERTS_CODING_AGENT_DIR = agentDir;
	process.env.EXXETA_PERSISTENT_AGENTS_ROOT = agentsRoot;
	const { createPersistentAgentFromScaffoldInput } = await import("../src/persistent-agents.js");
	const roomId = createPersistentAgentFromScaffoldInput({ displayName: "Forget Task Room", userName: "Synthetic User", preferredUserAddress: "Synthetic User" }).agent.agentId;
	const roomDir = path.join(agentsRoot, roomId);

	server = spawn("npx", ["tsx", "src/index.ts"], {
		shell: process.platform === "win32",
		...SMOKE_SERVER_SPAWN_TREE_OPTIONS,
		cwd: webServerDir,
		env: { ...process.env, HOME: tempHome, USERPROFILE: tempHome, PORT: String(port), ...SMOKE_SERVER_AUTH_ENV, EXXETA_HOME: repoRoot, EXXPERTS_CODING_AGENT_DIR: agentDir, EXXETA_PERSISTENT_AGENTS_ROOT: agentsRoot },
	});
	server.stdout.on("data", (chunk) => serverOutput.push(String(chunk)));
	server.stderr.on("data", (chunk) => serverOutput.push(String(chunk)));
	await waitForServer(server);

	const conversationId = `smokeconv_forget_task_${Date.now().toString(36)}`;
	const seeded = await requestJson(`/api/persistent-agents/${encodeURIComponent(roomId)}/threads/${encodeURIComponent(conversationId)}`, {
		method: "PUT",
		body: JSON.stringify({ state: "active", origin: "launcher", model: { provider: "openai-compatible", model: "room-model" }, items: [] }),
	});
	assert(seeded.status === 200, `thread seed should return 200, got ${seeded.status}: ${JSON.stringify(seeded.body).slice(0, 300)}`);

	socket = new WebSocketImpl(`ws://127.0.0.1:${port}/ws?persistentAgentId=${roomId}&conversationId=${conversationId}&modelProvider=openai-compatible&model=room-model&reattach=1`, { headers: { ...SMOKE_AUTH_HEADERS } });
	socket.addEventListener("message", (event: { data: unknown }) => {
		try { frames.push(JSON.parse(String(event.data))); } catch {}
	});
	await new Promise<void>((resolve, reject) => {
		socket.addEventListener("open", () => resolve());
		socket.addEventListener("error", () => reject(new Error("websocket failed to connect")));
	});
	await until(() => Boolean(frameOf("ready")), "the room's ready frame");
	socket.send(JSON.stringify({ type: "prompt", text: ASK }));

	// The task starts on the person's words, writes its file and is held.
	await until(() => Boolean(frameOf("task_started")), "the task to start");
	const taskId = String(frameOf("task_started")!.taskId);
	const taskFolder = path.join(productAppRoot, "artifacts", "tasks", taskId);
	const ledgerRow = path.join(roomDir, "runtime", "task-ledger", `${taskId}.json`);
	await until(() => specialistHeld, "the specialist to write its file and be held");
	const written = fs.existsSync(taskFolder) ? fs.readdirSync(taskFolder, { recursive: true }).map(String) : [];
	assert(written.some((name) => name.endsWith("harbour-plan.html")) && fs.existsSync(ledgerRow), `before Forget the task has its file and its ledger row, got ${JSON.stringify(written)}`);
	await until(() => frames.some((frame) => frame.type === "agent_end" || (frame.type === "event" && frame.event?.type === "agent_end")), "the room's turn to end");

	// Forget, mid-task.
	const forgot = await requestJson(`/api/persistent-agents/${encodeURIComponent(roomId)}/memento`, { method: "POST", body: JSON.stringify({ conversationId }) });
	assert(forgot.status === 200, `Forget should return 200, got ${forgot.status}: ${JSON.stringify(forgot.body).slice(0, 300)}`);

	// 1. Opening the fresh conversation soon brings no card of the task back:
	// a running task is replayed to every socket that opens, and it leaves only
	// once it is over, its handoff (if any) written. Everything after reads a
	// room the task can no longer touch.
	const runtime = JSON.parse(fs.readFileSync(path.join(roomDir, "runtime", "state.json"), "utf-8"));
	assert(runtime.activeThreadId && runtime.activeThreadId !== conversationId, `Forget moved the room to a fresh conversation, got ${JSON.stringify(runtime)}`);
	const reopen = async (): Promise<Frame[]> => {
		try { socket?.close(); } catch {}
		frames.length = 0;
		socket = new WebSocketImpl(`ws://127.0.0.1:${port}/ws?persistentAgentId=${roomId}&conversationId=${runtime.activeThreadId}&modelProvider=openai-compatible&model=room-model&reattach=1`, { headers: { ...SMOKE_AUTH_HEADERS } });
		socket.addEventListener("message", (event: { data: unknown }) => {
			try { frames.push(JSON.parse(String(event.data))); } catch {}
		});
		await until(() => Boolean(frameOf("ready")), "the fresh conversation's ready frame");
		await sleep(200);
		return frames.filter((frame) => frame.taskId === taskId);
	};
	const reopenDeadline = Date.now() + 10_000;
	let card = await reopen();
	while (card.length > 0 && Date.now() < reopenDeadline) card = await reopen();
	assert(card.length === 0, `the fresh conversation shows no card of the forgotten task, got ${JSON.stringify(card)}`);
	assert(!frames.some((frame) => frame.type === "task_end" && frame.taskId === taskId), "the task never ends as a finished task");

	// 2. The task folder and its ledger row are gone.
	assert(!fs.existsSync(taskFolder) && !fs.existsSync(ledgerRow), "the task folder and its ledger row are erased");
	// 3. No handoff on the fresh conversation, nothing on the shelf, no file with the task's words.
	const fresh = JSON.parse(fs.readFileSync(path.join(roomDir, "runtime", "threads", `${runtime.activeThreadId}.json`), "utf-8"));
	assert(!(fresh.pendingHandoffs ?? []).length, `the fresh conversation carries no handoff from the task, got ${JSON.stringify(fresh.pendingHandoffs)}`);
	const shelf = path.join(roomDir, "files");
	const shelved = fs.existsSync(shelf) ? fs.readdirSync(shelf, { recursive: true }).map(String) : [];
	assert(!shelved.some((name) => name.endsWith(".html")), `nothing lands on the shelf, got ${JSON.stringify(shelved)}`);
	const holding: string[] = [];
	const walk = (dir: string) => {
		for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
			const file = path.join(dir, entry.name);
			if (entry.isDirectory()) walk(file);
			// portability-ok: the list is only checked for being empty, so its slashes never matter
			else if (fs.readFileSync(file, "utf-8").includes(WORD)) holding.push(path.relative(tempHome, file));
		}
	};
	walk(tempHome);
	assert(holding.length === 0, `no file under the home holds the task's words, got ${JSON.stringify(holding)}`);
	console.log("forget-running-task-smoke: OK");
} catch (error) {
	console.error(serverOutput.join("").slice(-6000));
	throw error;
} finally {
	try { socket?.close(); } catch {}
	try { (gateway as any).closeAllConnections?.(); } catch {}
	try { gateway.close(); } catch {}
	await stopSmokeServer(server);
	fs.rmSync(tempRoot, { recursive: true, force: true });
}
