// A room behind a gateway that answers "too many requests" and says how long
// to wait. The model library waits without a word before it asks again, so,
// against a real spawned server, a stand-in gateway and a real room websocket:
//
// 1. Stop during the wait ends the answer at once: the room is idle and takes
//    the next message well under five seconds later, and the stopped message
//    is never sent again, also once the wait would have ended;
// 2. a wait of a second is waited for and answered, with no retry shown;
// 3. a wait of an hour is not waited for: the room asks again itself, which a
//    person sees, and then says the model is still busy;
// 4. the same wait with a status the room has no retry for (a 409) ends at
//    once in a failed answer with the gateway's words, and is asked again
//    where a person sees it when those words name a busy gateway.
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import { fileURLToPath } from "node:url";
import { authedFetch, SMOKE_AUTH_HEADERS, SMOKE_SERVER_AUTH_ENV, SMOKE_SERVER_SPAWN_TREE_OPTIONS, smokeHomeEnv, stopSmokeServer, freePort, waitForServer, type AuthedFetchInit } from "./smoke-server-process.js";
import { waitForTurnSettled } from "./smoke-turn-settle.js";
import { waitEvery } from "./smoke-wait.js";

function assert(condition: unknown, message: string): asserts condition {
	if (!condition) throw new Error(message);
}

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const webServerDir = path.resolve(scriptDir, "..");
const repoRoot = path.resolve(webServerDir, "..", "..");
const port = await freePort();
const baseUrl = `http://127.0.0.1:${port}`;

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "exxperts-stop-provider-wait-"));
const tempHome = path.join(tempRoot, "home");
const agentsRoot = path.join(tempHome, ".exxperts", "app", "personalized-agents");
const agentDir = path.join(tempHome, ".exxperts", "agent");
const productAppRoot = path.join(tempHome, ".exxperts", "app");
for (const dir of [agentsRoot, agentDir, productAppRoot]) fs.mkdirSync(dir, { recursive: true, mode: 0o700 });

const ANSWER = "Here is the answer.";
const BUSY_WORDS = "Too many requests for this key.";
/** None of the words the room asks again for. */
const CONFLICT_WORDS = "The request conflicts with another one.";
/** The gateway's wait in case 1: longer than Stop may take, short enough to see it end. */
const WAIT_SECONDS = 8;
const STOP_WITHIN_MS = 5000;

// What the gateway says to each request, in order; then it answers.
let refusals: Array<{ retryAfter: string; status?: number; words?: string }> = [];
const requestTimes: number[] = [];
const gateway = http.createServer((req, res) => {
	let raw = "";
	req.on("data", (chunk) => { raw += chunk; });
	req.on("end", () => {
		if (!String(req.url ?? "").endsWith("/chat/completions")) {
			res.writeHead(404).end();
			return;
		}
		requestTimes.push(Date.now());
		const refusal = refusals.shift();
		if (refusal) {
			res.writeHead(refusal.status ?? 429, { "content-type": "application/json", "retry-after": refusal.retryAfter });
			res.end(JSON.stringify({ error: { message: refusal.words ?? BUSY_WORDS, type: refusal.words ? "conflict" : "rate_limit_error" } }));
			return;
		}
		const base = { id: `cmpl_${requestTimes.length}`, object: "chat.completion.chunk", created: Math.floor(Date.now() / 1000), model: String(JSON.parse(raw || "{}").model ?? "room-model") };
		res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
		res.write(`data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: { role: "assistant", content: ANSWER }, finish_reason: null }] })}\n\n`);
		res.write(`data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 100, completion_tokens: 5, total_tokens: 105 } })}\n\n`);
		res.end("data: [DONE]\n\n");
	});
});

// Each wait a model library begins in the server, written by a hook the server loads first: the libraries wait
// in this one helper of theirs (its source's name where the stack is mapped), and nothing else shows that a wait
// has begun.
const waitsLog = path.join(tempRoot, "waits.log");
const WAITS_HOOK = `data:text/javascript;base64,${Buffer.from([
	`import fs from "node:fs";`,
	`const plain = globalThis.setTimeout;`,
	`globalThis.setTimeout = Object.defineProperties((...args) => {`,
	`	if (/[\\\\/]internal[\\\\/]utils[\\\\/]sleep\\.(?:m?js|ts)/.test(new Error().stack ?? "")) fs.appendFileSync(process.env.SMOKE_WAITS_LOG, "wait\\n");`,
	`	return plain(...args);`,
	`}, Object.getOwnPropertyDescriptors(plain));`,
].join("\n")).toString("base64")}`;
const waitsBegun = () => (fs.existsSync(waitsLog) ? fs.readFileSync(waitsLog, "utf8").split("\n").filter(Boolean).length : 0);

const waitUntil = waitEvery(25);

async function requestJson(pathname: string, init: AuthedFetchInit = {}): Promise<{ status: number; body: any }> {
	const response = await authedFetch(`${baseUrl}${pathname}`, { ...init, headers: { ...(init.body ? { "content-type": "application/json" } : {}), ...init.headers } });
	const text = await response.text();
	return { status: response.status, body: text ? JSON.parse(text) : null };
}

type Frame = Record<string, any>;
const WebSocketImpl: any = (await import("ws")).default;
const isTurnEnd = (frame: Frame) => frame.type === "event" && frame.event?.type === "agent_end" && !frame.event.retrying;
const eventsOf = (frames: Frame[], type: string) => frames.filter((frame) => frame.type === "event" && frame.event?.type === type).map((frame) => frame.event);
const answered = (frames: Frame[]) => eventsOf(frames, "message_end").some((event) => event.message?.role === "assistant" && JSON.stringify(event.message.content).includes(ANSWER));

let server: ChildProcessWithoutNullStreams | undefined;
const serverOutput: string[] = [];
let socket: any;

try {
	await new Promise<void>((resolve) => gateway.listen(0, "127.0.0.1", resolve));
	const write = (file: string, value: unknown) => fs.writeFileSync(file, JSON.stringify(value, null, 2), { mode: 0o600 });
	write(path.join(agentDir, "models.json"), { providers: { "openai-compatible": { name: "Synthetic Gateway", baseUrl: `http://127.0.0.1:${(gateway.address() as AddressInfo).port}/v1`, api: "openai-completions", models: [{ id: "room-model", name: "Room Model", contextWindow: 128000, maxTokens: 16384 }] } } });
	write(path.join(agentDir, "auth.json"), { "openai-compatible": { type: "api_key", key: "synthetic-provider-wait-key" } });
	// The room's own tries start a moment apart, so case 3 is over in seconds.
	write(path.join(agentDir, "settings.json"), { retry: { baseDelayMs: 200 } });
	write(path.join(productAppRoot, "openai-compatible-ai-profile.json"), { profileId: "openai-compatible", providerId: "openai-compatible", label: "Synthetic Gateway", roomModels: [{ modelId: "room-model", label: "Room Model" }], maintenanceModel: "room-model" });
	write(path.join(productAppRoot, "persistent-agent-ai-profile.json"), { profileId: "openai-compatible" });

	server = spawn("npx", ["tsx", "src/index.ts"], {
		shell: process.platform === "win32",
		...SMOKE_SERVER_SPAWN_TREE_OPTIONS,
		cwd: webServerDir,
		env: smokeHomeEnv(tempHome, { PORT: String(port), ...SMOKE_SERVER_AUTH_ENV, EXXETA_HOME: repoRoot, EXXPERTS_CODING_AGENT_DIR: agentDir, EXXETA_PERSISTENT_AGENTS_ROOT: agentsRoot, SMOKE_WAITS_LOG: waitsLog, NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ""} --import=${WAITS_HOOK}`.trim() }) as NodeJS.ProcessEnv,
	});
	server.stdout.on("data", (chunk) => serverOutput.push(String(chunk)));
	server.stderr.on("data", (chunk) => serverOutput.push(String(chunk)));
	await waitForServer(server, baseUrl, 30_000);

	const room = await requestJson("/api/persistent-agents", { method: "POST", body: JSON.stringify({ displayName: "Waiting Room", userName: "Synthetic User", preferredUserAddress: "Synthetic User" }) });
	assert(room.status === 201, `room creation should return 201, got ${room.status}: ${JSON.stringify(room.body).slice(0, 300)}`);
	const agentId = String(room.body?.agent?.id ?? "");
	const conversationId = `smokeconv_provider_wait_${Date.now().toString(36)}`;
	const seeded = await requestJson(`/api/persistent-agents/${encodeURIComponent(agentId)}/threads/${encodeURIComponent(conversationId)}`, { method: "PUT", body: JSON.stringify({ state: "active", origin: "launcher", model: { provider: "openai-compatible", model: "room-model" }, items: [] }) });
	assert(seeded.status === 200, `thread seed should return 200, got ${seeded.status}`);

	const frames: Frame[] = [];
	socket = new WebSocketImpl(`ws://127.0.0.1:${port}/ws?persistentAgentId=${agentId}&conversationId=${conversationId}&modelProvider=openai-compatible&model=room-model&reattach=1`, { headers: { ...SMOKE_AUTH_HEADERS } });
	socket.addEventListener("message", (event: { data: unknown }) => { frames.push(JSON.parse(String(event.data))); });
	await waitUntil(() => frames.some((frame) => frame.type === "ready"), "the room is ready");
	const send = (frame: Frame) => {
		const from = frames.length;
		socket.send(JSON.stringify(frame));
		return () => frames.slice(from);
	};
	const turnOver = async (shown: () => Frame[], label: string, timeoutMs: number) => {
		await waitUntil(() => shown().some(isTurnEnd), `${label} ends`, timeoutMs);
		await waitForTurnSettled(requestJson, agentId, `${label} is settled`, timeoutMs);
	};

	// --- 1. Stop during the wait
	refusals = [{ retryAfter: String(WAIT_SECONDS) }];
	send({ type: "prompt", text: "The first question, please." });
	await waitUntil(() => waitsBegun() === 1, "the library waits");
	const stoppedAt = Date.now();
	const stopped = send({ type: "abort" });
	await turnOver(stopped, "the stopped answer", 30_000);
	const stopTook = Date.now() - stoppedAt;
	assert(stopTook < STOP_WITHIN_MS, `Stop during a wait of ${WAIT_SECONDS} s leaves the room idle well under ${STOP_WITHIN_MS / 1000} s later, took ${stopTook} ms`);
	const stopEnd = stopped().find(isTurnEnd)!.event;
	assert(stopEnd.endedBy === "stop", `the stopped answer says Stop ended it, got ${JSON.stringify(stopEnd.endedBy)}`);
	const next = send({ type: "prompt", text: "The next question, please." });
	await turnOver(next, "the next answer", 10_000);
	assert(answered(next()), "the next message is answered");
	const roomTook = Date.now() - stoppedAt;
	assert(roomTook < STOP_WITHIN_MS, `the next message works well under ${STOP_WITHIN_MS / 1000} s after Stop, took ${roomTook} ms`);
	await waitUntil(() => Date.now() > requestTimes[0]! + WAIT_SECONDS * 1000 + 1000, "the gateway's wait is over");
	assert(requestTimes.length === 2, `the gateway saw the stopped question once and the next one once, got ${requestTimes.length} requests`);
	console.log(`  Stop during a wait: the room idle after ${stopTook} ms, the next message answered after ${roomTook} ms, nothing sent again`);

	// --- 2. A short wait is waited for
	requestTimes.length = 0;
	refusals = [{ retryAfter: "1" }];
	const short = send({ type: "prompt", text: "A question after a short wait, please." });
	await turnOver(short, "the answer after a short wait", 15_000);
	assert(answered(short()), "a wait of a second is waited for and answered");
	assert(requestTimes.length === 2 && requestTimes[1]! - requestTimes[0]! >= 950, `the second request comes after the wait, got ${requestTimes.map((at) => at - requestTimes[0]!).join(", ")} ms`);
	assert(eventsOf(short(), "auto_retry_start").length === 0, "a short wait shows no retry");
	console.log("  a wait of a second: waited for and answered, no retry shown");

	// --- 3. A long wait is not waited for
	requestTimes.length = 0;
	refusals = Array.from({ length: 4 }, () => ({ retryAfter: "3600" }));
	const longFrom = Date.now();
	const long = send({ type: "prompt", text: "A question after a long wait, please." });
	await turnOver(long, "the answer behind a wait of an hour", 15_000);
	const retries = eventsOf(long(), "auto_retry_start");
	assert(retries.length === 3 && retries.every((event) => event.failure === "busy"), `the room asks again three times and says the model is busy, got ${JSON.stringify(retries.map((event) => event.failure))}`);
	const failed = eventsOf(long(), "message_end").filter((event) => event.message?.role === "assistant").at(-1);
	assert(failed?.failure === "still-busy", `the last try says the model is still busy, got ${JSON.stringify(failed?.failure)}`);
	assert(String(failed.message.errorMessage).includes(BUSY_WORDS), `the gateway's own words are kept, got ${JSON.stringify(failed.message.errorMessage)}`);
	assert(requestTimes.length === 4, `four requests in all, got ${requestTimes.length}`);
	console.log(`  a wait of an hour: three retries shown, then the failure line, ${Date.now() - longFrom} ms`);

	// --- 4. The same with a status the room has no retry for
	const lastAnswerOf = (shown: Frame[]) => eventsOf(shown, "message_end").filter((event) => event.message?.role === "assistant").at(-1);
	requestTimes.length = 0;
	refusals = [{ retryAfter: "3600", status: 409, words: CONFLICT_WORDS }];
	const conflictFrom = Date.now();
	const conflict = send({ type: "prompt", text: "A question the gateway calls a conflict, please." });
	await turnOver(conflict, "the answer behind a conflict and a wait of an hour", 15_000);
	const conflictTook = Date.now() - conflictFrom;
	const refused = lastAnswerOf(conflict());
	assert(refused?.message.stopReason === "error" && refused.failure === "other" && refused.message.errorMessage === `409 ${CONFLICT_WORDS}`, `a 409 ends in a failed answer with the gateway's words, got ${JSON.stringify({ failure: refused?.failure, message: refused?.message })}`);
	assert(requestTimes.length === 1 && eventsOf(conflict(), "auto_retry_start").length === 0, `a 409 in such words is asked once, got ${requestTimes.length} requests`);
	requestTimes.length = 0;
	refusals = [{ retryAfter: "3600", status: 409 }];
	const busyConflict = send({ type: "prompt", text: "A question the gateway is too busy for, please." });
	await turnOver(busyConflict, "the answer behind a busy conflict", 15_000);
	assert(eventsOf(busyConflict(), "auto_retry_start").length === 1 && answered(busyConflict()) && requestTimes.length === 2, `a 409 in a busy gateway's words is asked again where a person sees it, got ${requestTimes.length} requests`);
	console.log(`  a 409 with a wait of an hour: the failure at once (${conflictTook} ms), or the room's own retry when its words name a busy gateway`);

	console.log("stop-during-provider-wait-smoke: OK");
} catch (error) {
	console.error(serverOutput.join("").slice(-6000));
	throw error;
} finally {
	try { socket?.close(); } catch {}
	gateway.closeAllConnections();
	gateway.close();
	await stopSmokeServer(server);
	fs.rmSync(tempRoot, { recursive: true, force: true });
}
