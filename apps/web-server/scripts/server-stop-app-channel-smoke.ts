// The desktop app's quit mid-answer, on the server's own process: the server
// started as apps/desktop/src/server.ts starts it (Node with tsx's loader
// flags, through bin/lib/server-entry.cjs, with an IPC channel), its stop
// asked for with the stop message on that channel, never a signal. A stand-in
// model answers over the OpenAI-compatible API with an answer that never ends.
//
// One server cuts the answer with the message: it ends by itself with exit
// code 0, the room's thread file holds the message, the partial and the
// stop's sentence once, and the room's lock file is gone. A second server on
// the same home shows the room's card with no lock, and stops on the message
// too.
//
// It runs on every platform: the message is how the desktop app gets the
// server's stop on Windows, where a signal from another process is a forced
// kill.
//
// Run: node --import tsx/esm apps/web-server/scripts/server-stop-app-channel-smoke.ts
import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import { fileURLToPath } from "node:url";
import { SERVER_STOP_MESSAGE, STOP_CUT_ANSWER_SENTENCE } from "../src/server-stop.js";
import { authedFetch, freePort, smokeHomeEnv, SMOKE_AUTH_HEADERS, SMOKE_SERVER_AUTH_ENV, type AuthedFetchInit } from "./smoke-server-process.js";
import { waitEvery } from "./smoke-wait.js";

const SMOKE = "server-stop-app-channel-smoke";

function assert(condition: unknown, message: string): asserts condition {
	if (!condition) throw new Error(message);
}

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, "..", "..", "..");
const { serverLaunchArgs } = createRequire(import.meta.url)(path.join(repoRoot, "bin", "lib", "server-entry.cjs")) as {
	serverLaunchArgs: (root: string, options?: { tsxLoader?: boolean; env?: NodeJS.ProcessEnv }) => string[];
};
const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "exxperts-stop-app-channel-"));
const home = path.join(tempRoot, "home");
const waitUntil = waitEvery(50);

const MESSAGE = "Tell me a long story.";
const FIRST_WORDS = "Part 1 of the long story.";
const PART_GAP_MS = 100;

// ---------------------------------------------------------------------------
// The stand-in model.
// ---------------------------------------------------------------------------
let partsSent = 0;
const gateway = http.createServer((req, res) => {
	let body = "";
	req.on("data", (chunk) => (body += chunk));
	req.on("end", () => {
		let parsed: { model?: unknown } = {};
		try {
			parsed = JSON.parse(body);
		} catch {}
		res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
		const base = { id: `cmpl_${Date.now()}`, object: "chat.completion.chunk", created: Math.floor(Date.now() / 1000), model: String(parsed.model ?? "room-model") };
		// Far longer than the stop's wait: the stop cuts it. It goes on until the room's client goes away.
		let part = 0;
		const timer = setInterval(() => {
			part += 1;
			partsSent += 1;
			res.write(`data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: { role: "assistant", content: `Part ${part} of the long story. ` }, finish_reason: null }] })}\n\n`);
		}, PART_GAP_MS);
		res.on("close", () => clearInterval(timer));
	});
});

// ---------------------------------------------------------------------------
// The server, as the desktop app starts it.
// ---------------------------------------------------------------------------
type Exited = { code: number | null; signal: NodeJS.Signals | null };
type Server = { process: ChildProcess; port: number; output: () => string; exited: Promise<Exited> };
const running = new Set<Server>();
let gatewayPort = 0;

function writeHome(): void {
	const agentDir = path.join(home, ".exxperts", "agent");
	const appRoot = path.join(home, ".exxperts", "app");
	fs.mkdirSync(agentDir, { recursive: true, mode: 0o700 });
	fs.mkdirSync(path.join(appRoot, "personalized-agents"), { recursive: true, mode: 0o700 });
	const write = (file: string, value: unknown) => fs.writeFileSync(file, JSON.stringify(value, null, 2), { mode: 0o600 });
	write(path.join(agentDir, "models.json"), { providers: { "openai-compatible": { name: "Stand-in Model", baseUrl: `http://127.0.0.1:${gatewayPort}/v1`, api: "openai-completions", models: [{ id: "room-model", name: "Room Model", contextWindow: 128000, maxTokens: 16384 }] } } });
	write(path.join(agentDir, "auth.json"), { "openai-compatible": { type: "api_key", key: "stand-in-app-channel-key" } });
	write(path.join(appRoot, "openai-compatible-ai-profile.json"), { profileId: "openai-compatible", providerId: "openai-compatible", label: "Stand-in Model", roomModels: [{ modelId: "room-model", label: "Room Model" }], maintenanceModel: "room-model" });
	write(path.join(appRoot, "persistent-agent-ai-profile.json"), { profileId: "openai-compatible" });
	write(path.join(agentDir, "settings.json"), { retry: { provider: { maxRetries: 0 } } });
}

async function startServer(what: string): Promise<Server> {
	const port = await freePort();
	const env = smokeHomeEnv(home, { PORT: String(port), ...SMOKE_SERVER_AUTH_ENV, EXXETA_HOME: repoRoot }) as NodeJS.ProcessEnv;
	// The source runs, never a hand-built bundle.
	delete env.EXXPERTS_SERVER_BUNDLE;
	const child = spawn(process.execPath, serverLaunchArgs(repoRoot, { tsxLoader: true, env }), { cwd: repoRoot, env, stdio: ["ignore", "pipe", "pipe", "ipc"] });
	let output = "";
	child.stdout?.on("data", (chunk) => (output += String(chunk)));
	child.stderr?.on("data", (chunk) => (output += String(chunk)));
	const exited = new Promise<Exited>((resolve) => child.once("exit", (code, signal) => resolve({ code, signal })));
	const server: Server = { process: child, port, output: () => output, exited };
	running.add(server);
	void exited.then(() => running.delete(server));
	await waitUntil(async () => {
		if (child.exitCode !== null || child.signalCode !== null) throw new Error(`${what}: the server ended before it was ready:\n${output.slice(-3000)}`);
		return fetch(`http://127.0.0.1:${port}/healthz`).then((response) => response.ok).catch(() => false);
	}, `${what}: the server is ready`, 60_000);
	return server;
}

// The stop message, then the server's own end within the bound; past it the smoke fails and kills the server.
async function stopByMessage(server: Server, what: string): Promise<void> {
	server.process.send({ type: SERVER_STOP_MESSAGE });
	let timer: NodeJS.Timeout | undefined;
	const ended = await Promise.race([server.exited, new Promise<null>((resolve) => (timer = setTimeout(() => resolve(null), 8_000)))]);
	clearTimeout(timer);
	if (ended === null) {
		server.process.kill("SIGKILL");
		await server.exited;
		throw new Error(`${what}: the server did not end within 8 s of the stop message:\n${server.output().slice(-3000)}`);
	}
	assert(ended.code === 0 && ended.signal === null, `${what}: the server ended with exit code ${ended.code} and signal ${ended.signal}, not exit code 0`);
	assert(server.output().includes("server stop: started by stop message;"), `${what}: the server's stop did not start on the stop message:\n${server.output().slice(-3000)}`);
}

async function requestJson(server: Server, pathname: string, init: AuthedFetchInit = {}): Promise<{ status: number; body: any }> {
	const response = await authedFetch(`http://127.0.0.1:${server.port}${pathname}`, { ...init, headers: { ...(init.body ? { "content-type": "application/json" } : {}), ...init.headers } });
	const text = await response.text();
	let body: any = text;
	try {
		body = text ? JSON.parse(text) : null;
	} catch {}
	return { status: response.status, body };
}

// ---------------------------------------------------------------------------
// The room's live connection.
// ---------------------------------------------------------------------------
type Frame = Record<string, any>;
const WebSocketImpl: any = (await import("ws")).default;
async function openLive(server: Server, roomId: string, conversationId: string, what: string) {
	const socket = new WebSocketImpl(`ws://127.0.0.1:${server.port}/ws?persistentAgentId=${roomId}&conversationId=${conversationId}&modelProvider=openai-compatible&model=room-model&reattach=1`, { headers: { ...SMOKE_AUTH_HEADERS } });
	const frames: Frame[] = [];
	socket.on("message", (raw: unknown) => {
		try {
			frames.push(JSON.parse(String(raw)));
		} catch {}
	});
	socket.on("error", () => {});
	await waitUntil(() => frames.some((frame) => frame.type === "ready"), `${what}: the room's connection is ready`, 45_000);
	return { frames, send: (frame: Frame) => socket.send(JSON.stringify(frame)), close: () => socket.close() };
}
const isEvent = (type: string) => (frame: Frame) => frame.type === "event" && frame.event?.type === type;

try {
	await new Promise<void>((resolve) => gateway.listen(0, "127.0.0.1", resolve));
	gatewayPort = (gateway.address() as AddressInfo).port;
	writeHome();

	// The quit mid-answer.
	const first = await startServer("the quit");
	const made = await requestJson(first, "/api/persistent-agents", { method: "POST", body: JSON.stringify({ displayName: "Story Room", userName: "Quit Person", preferredUserAddress: "Quit Person" }) });
	assert(made.status === 201, `creating a room: ${made.status} ${JSON.stringify(made.body)}`);
	const roomId = String(made.body?.agent?.id ?? "");
	const roomDir = path.join(home, ".exxperts", "app", "personalized-agents", roomId);
	const lockFile = path.join(home, ".exxperts", "app", ".room-locks", `${roomId.replace(/[^a-zA-Z0-9_-]+/g, "_")}.json`);
	const conversationId = `appchannel_${Date.now().toString(36)}`;
	const opened = await requestJson(first, `/api/persistent-agents/${encodeURIComponent(roomId)}/threads/${encodeURIComponent(conversationId)}`, { method: "PUT", body: JSON.stringify({ state: "active", origin: "launcher", model: { provider: "openai-compatible", model: "room-model" }, items: [] }) });
	assert(opened.status === 200, `making the conversation active: ${opened.status} ${JSON.stringify(opened.body)}`);
	const live = await openLive(first, roomId, conversationId, "the quit");
	live.send({ type: "prompt", text: MESSAGE });
	await waitUntil(() => partsSent >= 3, "the quit: the long answer streams", 30_000);
	assert(fs.existsSync(lockFile), `control: the open room holds no lock file at ${lockFile}`);
	await stopByMessage(first, "the quit");
	assert(live.frames.find(isEvent("agent_end"))?.event?.stoppedByServer === true, "the quit: the answer's end does not carry stoppedByServer: the stop did not cut it");

	const items = (JSON.parse(fs.readFileSync(path.join(roomDir, "runtime", "threads", `${conversationId}.json`), "utf8")) as { items?: { kind?: string; text?: string }[] }).items ?? [];
	const messages = items.filter((item) => item.kind === "user" && String(item.text ?? "").includes(MESSAGE));
	const partials = items.filter((item) => item.kind === "assistant" && String(item.text ?? "").includes(FIRST_WORDS));
	const sentences = items.filter((item) => String(item.text ?? "").includes(STOP_CUT_ANSWER_SENTENCE));
	assert(messages.length === 1 && partials.length === 1 && sentences.length === 1, `the quit: the thread file does not hold the message, the partial and the stop's sentence once each (${messages.length}, ${partials.length}, ${sentences.length}): ${JSON.stringify(items)}`);
	assert(items.at(-1)?.text === STOP_CUT_ANSWER_SENTENCE, `the quit: the thread file does not end with the stop's sentence: ${JSON.stringify(items.at(-1))}`);
	assert(!fs.existsSync(lockFile), `the quit: the room's lock file is still there after the stop: ${fs.existsSync(lockFile) ? fs.readFileSync(lockFile, "utf8") : ""}`);
	console.log(`${SMOKE}: the stop message mid-answer: exit code 0; the thread file holds the message, the partial and the stop's sentence once each; the room's lock file is gone`);

	// The start again.
	const second = await startServer("the start again");
	// The room's card on Home reads its lock from the room list.
	const rooms = await requestJson(second, "/api/persistent-agents");
	const card = Array.isArray(rooms.body) ? rooms.body.find((row: { id?: string }) => row.id === roomId) : undefined;
	assert(card && card.activeLock === null, `the start again: the room's card shows a lock (open elsewhere): ${JSON.stringify(card?.activeLock)}`);
	await stopByMessage(second, "the start again");
	console.log(`${SMOKE}: the start again: the room's card shows no lock, and the server stops on the message again`);
	console.log(`${SMOKE}: ok`);
} finally {
	for (const server of running) {
		server.process.kill("SIGKILL");
		await server.exited;
	}
	try {
		gateway.closeAllConnections();
	} catch {}
	gateway.close();
	fs.rmSync(tempRoot, { recursive: true, force: true });
}
