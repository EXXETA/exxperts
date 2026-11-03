import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import { fileURLToPath } from "node:url";
import { ROOM_STATE_HEADING } from "../src/room-state-message.js";
import { authedFetch, SMOKE_AUTH_HEADERS, SMOKE_SERVER_AUTH_ENV, SMOKE_SERVER_SPAWN_TREE_OPTIONS, stopSmokeServer, freePort, type AuthedFetchInit } from "./smoke-server-process.js";
import { computeSkillFilesDigest, sha256, writeSkillProvenance } from "../src/skills-store.js";
import { waitEvery } from "./smoke-wait.js";

// Stop must kill the tool-turn recovery (fix/stop-cancels-recovery). The
// persistent-room recovery prompt (maybeAutoSummarizeToolTurn) used to fire
// even when the user cancelled the turn: after Stop, the tool-only shape of
// the aborted turn looked like "tools ran but no answer was written", so the
// server started a SECOND model completion ([INTERNAL_TOOL_SUMMARY_REQUEST])
// that rendered as a ghost answer the user had just declined to pay for.
// The fix gates the recovery call site on terminalReason === "completed"
// (plus a belt inside the function). Against a real spawned server, a
// synthetic OpenAI-compatible SSE gateway and a real room websocket, proves:
//
// 1. positive control — recovery still works: a turn whose first completion
//    is a bare read_skill tool call and whose post-tool completion carries no
//    assistant text ends cleanly, and the gateway then receives ONE more
//    completion whose messages carry INTERNAL_TOOL_SUMMARY_REQUEST; its
//    answer streams to the client. Three gateway completions total for the
//    turn: the tool-call leg, the empty post-tool leg, the recovery leg —
//    the recovery is the turn's SECOND full model answer, and there is
//    exactly one of it.
// 2. the regression pin — Stop kills recovery: same shape, but the post-tool
//    completion hangs mid-stream and the client sends {type:"abort"} inside
//    that window. The turn settles cancelled, and after a generous settle
//    delay the gateway has seen exactly TWO completions for the turn (the
//    tool-call leg plus the aborted post-tool leg) and NO request anywhere
//    carrying INTERNAL_TOOL_SUMMARY_REQUEST (or the retrieval variant); the
//    websocket saw exactly one agent_start, no assistant text after the
//    abort, and never the ghost answer. Pre-fix, the recovery's second
//    completion would have arrived within that settle window.
// 3. Stop with a command card open ends the turn at once: the card is told
//    it closed, the step's result starts with the Stop's sentence (the next
//    turn's request carries it to the model), and the next turn asks again.
//    Without the fix the abort waits for the card's answer forever. The same
//    step also asks for a specialist on the person's own words: once Stop
//    lands the runtime skips that call, which has not started, so no
//    specialist starts.
// 4. A Stop in a retry wait says Stop on the retry's end, the frame that ends
//    that turn for the page. A model call that failed for good is told by its
//    own `failure`; its turn's end names no one who ended it.

function assert(condition: unknown, message: string): asserts condition {
	if (!condition) throw new Error(message);
}

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const webServerDir = path.resolve(scriptDir, "..");
const repoRoot = path.resolve(webServerDir, "..", "..");
const port = await freePort();
const baseUrl = `http://127.0.0.1:${port}`;

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "exxperts-stop-recovery-"));
const tempHome = path.join(tempRoot, "home");
const agentsRoot = path.join(tempHome, ".exxperts", "app", "personalized-agents");
const agentDir = path.join(tempHome, ".exxperts", "agent");
const productAppRoot = path.join(tempHome, ".exxperts", "app");
fs.mkdirSync(agentsRoot, { recursive: true, mode: 0o700 });
fs.mkdirSync(agentDir, { recursive: true, mode: 0o700 });
fs.mkdirSync(productAppRoot, { recursive: true, mode: 0o700 });

// The tool the room executes with no extra wiring: a planted user-store skill
// read via read_skill (same rig as skills-execution-exposure-smoke). Any tool
// result sets the trace's sawToolResult, which is all the recovery needs.
const skillName = "convert-docs";
const skillDir = path.join(agentDir, "skills", skillName);
fs.mkdirSync(skillDir, { recursive: true, mode: 0o700 });
const skillManifest = `---\nname: ${skillName}\ndescription: Converts documents\n---\n\nRun the conversion steps.\n`;
fs.writeFileSync(path.join(skillDir, "SKILL.md"), skillManifest, { mode: 0o600 });
writeSkillProvenance(skillDir, { source: "upload", importedAt: new Date().toISOString(), license: null, sha256: sha256(skillManifest) });
assert(computeSkillFilesDigest(skillDir), "the planted skill must digest");

// Turn tokens ride the user prompt, so every completion request of a turn
// (the whole message history travels each leg) is attributable to its turn.
const RECOVERY_TURN_TOKEN = "TURN_TOKEN_RECOVERY_CONTROL";
const STOP_TURN_TOKEN = "TURN_TOKEN_STOP_PIN";
const RECOVERY_ANSWER = "Recovered ghost summary.";
const CARD_TURN_TOKEN = "TURN_TOKEN_STOP_WITH_CARD";
const CARD_ANSWER = "Listed the files.";
const CARD_REQUEST = "Make me a one-page document about the files and list them";
const FAILED_TURN_TOKEN = "TURN_TOKEN_FAILED";
const RETRY_STOP_TURN_TOKEN = "TURN_TOKEN_RETRY_STOP";

// ---------------------------------------------------------------------------
// Synthetic OpenAI-compatible gateway. Per request:
//   - INTERNAL_* marker in the body  -> plain-text answer (the recovery leg);
//   - no tool messages yet           -> a bare read_skill tool call;
//   - tool messages + STOP token     -> hang mid-stream after one empty delta
//                                       (the deterministic abort window);
//   - tool messages otherwise        -> empty assistant text, finish stop
//                                       (the tool-only shape recovery targets).
// ---------------------------------------------------------------------------
type GatewayRequest = { body: string; internal: boolean; toolLeg: boolean; hang: boolean; aborted: boolean; finished: boolean };
const gatewayRequests: GatewayRequest[] = [];
const requestsForTurn = (token: string) => gatewayRequests.filter((r) => r.body.includes(token));

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
		const hasToolMessages = messages.some((m) => m?.role === "tool");
		const internal = body.includes("INTERNAL_TOOL_SUMMARY_REQUEST") || body.includes("INTERNAL_RETRIEVAL_SYNTHESIS_REQUEST");
		const toolLeg = !internal && !hasToolMessages;
		const hang = !internal && hasToolMessages && body.includes(STOP_TURN_TOKEN);
		// The card turns ask for a command after the person's message and answer after its result.
		const cardLeg = !internal && body.includes(CARD_TURN_TOKEN) ? (messages.at(-1)?.role === "tool" ? "answer" : "command") : null;
		// The model call fails inside the stream: in words the runtime gives up on, or in words it asks again after a wait.
		const failWords = internal ? null : body.includes(RETRY_STOP_TURN_TOKEN) ? "overloaded_error: the model is busy" : body.includes(FAILED_TURN_TOKEN) ? "invalid_request: this request cannot be answered" : null;
		const record: GatewayRequest = { body, internal, toolLeg: toolLeg && !cardLeg, hang, aborted: false, finished: false };
		gatewayRequests.push(record);
		res.on("close", () => { if (!res.writableFinished) record.aborted = true; });
		res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
		const base = { id: `cmpl_${gatewayRequests.length}`, object: "chat.completion.chunk", created: Math.floor(Date.now() / 1000), model: String(parsed?.model ?? "room-model") };
		if (failWords) {
			res.write(sseChunk({ error: { message: failWords, type: "server_error" } }));
		} else if (cardLeg === "command") {
			res.write(sseChunk({ ...base, choices: [{ index: 0, delta: { role: "assistant", tool_calls: [{ index: 0, id: `call_ls_${gatewayRequests.length}`, type: "function", function: { name: "bash", arguments: JSON.stringify({ command: "ls" }) } }] }, finish_reason: null }] }));
			// The first card turn also asks for a specialist in the same step, quoting the person's own words.
			// A room-state copy after the person's message is the app's, not the request.
			const lastUser = [...messages].reverse().find((m) => m?.role === "user" && !JSON.stringify(m.content ?? "").includes(ROOM_STATE_HEADING));
			if (JSON.stringify(lastUser?.content ?? "").includes(CARD_REQUEST)) res.write(sseChunk({ ...base, choices: [{ index: 0, delta: { tool_calls: [{ index: 1, id: `call_delegate_${gatewayRequests.length}`, type: "function", function: { name: "delegate_task", arguments: JSON.stringify({ template: "document-html", brief: "A one-page HTML document listing the files.", userRequest: CARD_REQUEST }) } }] }, finish_reason: null }] }));
			res.write(sseChunk({ ...base, choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }], usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 } }));
		} else if (cardLeg === "answer") {
			res.write(sseChunk({ ...base, choices: [{ index: 0, delta: { role: "assistant", content: CARD_ANSWER }, finish_reason: null }] }));
			res.write(sseChunk({ ...base, choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 140, completion_tokens: 5, total_tokens: 145 } }));
		} else if (toolLeg) {
			// First leg of the turn: the model "decides" to read the skill and
			// writes no user-facing text at all.
			res.write(sseChunk({ ...base, choices: [{ index: 0, delta: { role: "assistant", tool_calls: [{ index: 0, id: "call_read_skill", type: "function", function: { name: "read_skill", arguments: "" } }] }, finish_reason: null }] }));
			res.write(sseChunk({ ...base, choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: JSON.stringify({ name: skillName }) } }] }, finish_reason: null }] }));
			res.write(sseChunk({ ...base, choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }], usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 } }));
		} else if (hang) {
			// The abort window: the post-tool completion opens, emits one empty
			// delta and then goes silent. The tool result already exists in the
			// turn trace, so pre-fix an abort here left exactly the "tools ran,
			// no answer" shape the recovery pounced on. Never finishes: only the
			// client abort (or process teardown) closes it.
			res.write(sseChunk({ ...base, choices: [{ index: 0, delta: { role: "assistant", content: "" }, finish_reason: null }] }));
			return;
		} else if (internal) {
			// The recovery leg: answer it visibly, so the positive control can
			// assert the answer streamed and the pin can assert it never did.
			res.write(sseChunk({ ...base, choices: [{ index: 0, delta: { role: "assistant", content: RECOVERY_ANSWER }, finish_reason: null }] }));
			res.write(sseChunk({ ...base, choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 150, completion_tokens: 8, total_tokens: 158 } }));
		} else {
			// The post-tool leg of the control turn: the model ends the turn with
			// NO assistant text — the exact tool-only shape the recovery targets.
			res.write(sseChunk({ ...base, choices: [{ index: 0, delta: { role: "assistant", content: "" }, finish_reason: null }] }));
			res.write(sseChunk({ ...base, choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 140, completion_tokens: 0, total_tokens: 140 } }));
		}
		res.write("data: [DONE]\n\n");
		record.finished = true;
		res.end();
	});
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
async function waitForServer(server: ChildProcessWithoutNullStreams): Promise<void> {
	const deadline = Date.now() + 20_000;
	let lastError = "server did not respond";
	while (Date.now() < deadline) {
		if (server.exitCode != null) throw new Error(`server exited before startup with code ${server.exitCode}`);
		try {
			const response = await fetch(`${baseUrl}/healthz`);
			if (response.ok) return;
			lastError = `healthz returned ${response.status}`;
		} catch (error) {
			lastError = (error as Error).message;
		}
		await new Promise((resolve) => setTimeout(resolve, 150));
	}
	throw new Error(`server did not become ready: ${lastError}`);
}

async function requestJson(pathname: string, init: AuthedFetchInit = {}): Promise<{ status: number; body: any }> {
	const response = await authedFetch(`${baseUrl}${pathname}`, {
		...init,
		headers: { ...(init.body ? { "content-type": "application/json" } : {}), ...init.headers },
	});
	const text = await response.text();
	return { status: response.status, body: text ? JSON.parse(text) : null };
}

async function createSkillRoom(displayName: string): Promise<string> {
	const room = await requestJson("/api/persistent-agents", { method: "POST", body: JSON.stringify({ displayName, userName: "Synthetic User", preferredUserAddress: "Synthetic User" }) });
	assert(room.status === 201, `room creation should return 201, got ${room.status}: ${JSON.stringify(room.body)}`);
	const agentId = String(room.body?.agent?.id ?? "");
	assert(agentId, `room creation should return an agent id, got ${JSON.stringify(room.body).slice(0, 300)}`);
	const enable = await requestJson(`/api/persistent-agents/${encodeURIComponent(agentId)}/skill-settings`, { method: "PUT", body: JSON.stringify({ action: "enable", name: skillName }) });
	assert(enable.status === 200, `skill enable should return 200, got ${enable.status}: ${JSON.stringify(enable.body)}`);
	return agentId;
}

async function seedThread(agentId: string, conversationId: string): Promise<void> {
	const seeded = await requestJson(`/api/persistent-agents/${encodeURIComponent(agentId)}/threads/${encodeURIComponent(conversationId)}`, {
		method: "PUT",
		body: JSON.stringify({ state: "active", origin: "launcher", model: { provider: "openai-compatible", model: "room-model" }, items: [] }),
	});
	assert(seeded.status === 200, `thread seed should return 200, got ${seeded.status}: ${JSON.stringify(seeded.body).slice(0, 300)}`);
}

async function getStatus(agentId: string): Promise<any> {
	const response = await requestJson("/api/persistent-agents");
	assert(response.status === 200, `statuses GET should return 200, got ${response.status}`);
	const rows = response.body?.agents ?? response.body ?? [];
	const status = (Array.isArray(rows) ? rows : []).find((row: any) => row.id === agentId);
	assert(status, `status for ${agentId} should exist`);
	return status;
}

type Frame = Record<string, any>;

function deltaText(frame: Frame): string {
	const update = frame?.type === "event" && frame.event?.type === "message_update" ? frame.event.assistantMessageEvent : null;
	return update?.type === "text_delta" ? String(update.delta ?? "") : "";
}

function countAgentStarts(frames: Frame[]): number {
	return frames.filter((frame) => frame?.type === "event" && frame.event?.type === "agent_start").length;
}

const WebSocketImpl: any = (await import("ws")).default;

class WsHarness {
	readonly frames: Frame[] = [];
	private socket: any;

	private constructor(socket: any) {
		this.socket = socket;
		socket.addEventListener("message", (event: { data: unknown }) => {
			try { this.frames.push(JSON.parse(String(event.data))); } catch {}
		});
	}

	static async connect(persistentAgentId: string, conversationId: string): Promise<WsHarness> {
		const socket = new WebSocketImpl(`ws://127.0.0.1:${port}/ws?persistentAgentId=${persistentAgentId}&conversationId=${conversationId}&modelProvider=openai-compatible&model=room-model&reattach=1`, { headers: { ...SMOKE_AUTH_HEADERS } });
		const harness = new WsHarness(socket);
		await new Promise<void>((resolve, reject) => {
			socket.addEventListener("open", () => resolve());
			socket.addEventListener("error", () => reject(new Error("websocket failed to connect")));
		});
		return harness;
	}

	send(frame: Frame): void {
		this.socket.send(JSON.stringify(frame));
	}

	close(): void {
		try { this.socket.close(); } catch {}
	}

	async waitFor(predicate: (frame: Frame) => boolean, label: string, fromIndex = 0, timeoutMs = 25_000): Promise<number> {
		const deadline = Date.now() + timeoutMs;
		let index = fromIndex;
		while (Date.now() < deadline) {
			for (; index < this.frames.length; index++) {
				if (predicate(this.frames[index])) return index;
			}
			await new Promise((resolve) => setTimeout(resolve, 25));
		}
		const errors = this.frames.filter((frame) => String(frame.type).includes("error")).map((frame) => frame.message).join(" | ");
		throw new Error(`timed out waiting for ${label}; saw frame types: ${this.frames.map((frame) => frame.type).join(", ")}${errors ? `; errors: ${errors}` : ""}`);
	}
}

const waitUntil = waitEvery(100);

let server: ChildProcessWithoutNullStreams | undefined;
const serverOutput: string[] = [];
let ws1: WsHarness | null = null;
let ws2: WsHarness | null = null;
let ws3: WsHarness | null = null;
let ws4: WsHarness | null = null;

try {
	await new Promise<void>((resolve) => gateway.listen(0, "127.0.0.1", resolve));
	const gatewayPort = (gateway.address() as AddressInfo).port;
	fs.writeFileSync(path.join(agentDir, "models.json"), JSON.stringify({
		providers: {
			"openai-compatible": {
				name: "Synthetic Gateway",
				baseUrl: `http://127.0.0.1:${gatewayPort}/v1`,
				api: "openai-completions",
				models: [{ id: "room-model", name: "Room Model", contextWindow: 128000, maxTokens: 16384 }],
			},
		},
	}, null, 2), { mode: 0o600 });
	fs.writeFileSync(path.join(agentDir, "auth.json"), JSON.stringify({ "openai-compatible": { type: "api_key", key: "synthetic-stop-recovery-key" } }, null, 2), { mode: 0o600 });
	fs.writeFileSync(path.join(productAppRoot, "openai-compatible-ai-profile.json"), JSON.stringify({
		profileId: "openai-compatible",
		providerId: "openai-compatible",
		label: "Synthetic Gateway",
		roomModels: [{ modelId: "room-model", label: "Room Model" }],
		maintenanceModel: "room-model",
	}, null, 2), { mode: 0o600 });
	fs.writeFileSync(path.join(productAppRoot, "persistent-agent-ai-profile.json"), JSON.stringify({ profileId: "openai-compatible" }, null, 2), { mode: 0o600 });

	server = spawn("npx", ["tsx", "src/index.ts"], {
		shell: process.platform === "win32",
		...SMOKE_SERVER_SPAWN_TREE_OPTIONS,
		cwd: webServerDir,
		env: {
			...process.env,
			HOME: tempHome, USERPROFILE: tempHome,
			PORT: String(port),
			...SMOKE_SERVER_AUTH_ENV,
			EXXETA_HOME: repoRoot,
			EXXPERTS_CODING_AGENT_DIR: agentDir,
			EXXETA_PERSISTENT_AGENTS_ROOT: agentsRoot,
		},
	});
	server.stdout.on("data", (chunk) => serverOutput.push(String(chunk)));
	server.stderr.on("data", (chunk) => serverOutput.push(String(chunk)));
	await waitForServer(server);

	// --- 1. Positive control: a completed tool-only turn still recovers ------
	const room1 = await createSkillRoom("Recovery Control Room");
	const conv1 = `smokeconv_control_${Date.now().toString(36)}`;
	await seedThread(room1, conv1);
	ws1 = await WsHarness.connect(room1, conv1);
	await ws1.waitFor((frame) => frame.type === "ready", "control ready frame");
	ws1.send({ type: "prompt", text: `Please read the convert-docs skill. ${RECOVERY_TURN_TOKEN}` });
	// The recovery is the proof the turn ended COMPLETED and the gate opened:
	// wait for its request to hit the gateway, then for its answer to stream.
	await waitUntil(() => requestsForTurn(RECOVERY_TURN_TOKEN).some((r) => r.internal), "recovery completion request reaches the gateway", 30_000);
	await ws1.waitFor((frame) => deltaText(frame).includes(RECOVERY_ANSWER), "recovery answer streams to the client", 0, 20_000);
	await waitUntil(async () => (await getStatus(room1)).activeThread?.inFlight === false, "control turn settled", 20_000);
	const controlStatus = await getStatus(room1);
	assert(controlStatus.activeThread?.activeTurn?.lastTerminalReason === "completed", `control turn should settle completed, got ${JSON.stringify(controlStatus.activeThread?.activeTurn)}`);
	const controlRequests = requestsForTurn(RECOVERY_TURN_TOKEN);
	// Three legs: the tool call, the empty post-tool answer, the recovery. The
	// recovery is the turn's second full model ANSWER, and there is exactly one.
	assert(controlRequests.length === 3, `the control turn should cost exactly 3 completions (tool leg, empty post-tool leg, recovery), got ${controlRequests.length}`);
	assert(controlRequests.filter((r) => r.internal).length === 1, `exactly one recovery completion should fire, got ${controlRequests.filter((r) => r.internal).length}`);
	assert(controlRequests[2].internal, "the recovery must be the turn's last completion");
	assert(controlRequests[2].body.includes("INTERNAL_TOOL_SUMMARY_REQUEST"), `the recovery request should carry INTERNAL_TOOL_SUMMARY_REQUEST, got: ${controlRequests[2].body.slice(0, 400)}`);
	assert(countAgentStarts(ws1.frames) >= 2, `the recovery should run as a second agent turn on the same socket, got ${countAgentStarts(ws1.frames)} agent_start frames`);
	// A turn that ran to its end says nothing about how it ended.
	const controlEnd = ws1.frames.find((frame) => frame?.type === "event" && frame.event?.type === "agent_end");
	assert(controlEnd && controlEnd.event.endedBy === undefined, `a completed turn's agent_end carries no endedBy, got ${JSON.stringify(controlEnd?.event?.endedBy)}`);
	ws1.close();
	ws1 = null;
	await waitUntil(async () => !(await getStatus(room1)).activeLock, "control room lock released", 20_000);
	console.log("  positive control: completed tool-only turn recovered (3 completions, 1 recovery)");

	// --- 2. The regression pin: Stop while the tool turn is in flight --------
	const room2 = await createSkillRoom("Stop Recovery Room");
	const conv2 = `smokeconv_stop_${Date.now().toString(36)}`;
	await seedThread(room2, conv2);
	ws2 = await WsHarness.connect(room2, conv2);
	await ws2.waitFor((frame) => frame.type === "ready", "stop-turn ready frame");
	ws2.send({ type: "prompt", text: `Please read the convert-docs skill. ${STOP_TURN_TOKEN}` });
	// Deterministic abort window: the tool has executed (its result is in the
	// turn trace) and the post-tool completion is hanging mid-stream.
	await waitUntil(() => requestsForTurn(STOP_TURN_TOKEN).some((r) => r.hang), "hanging post-tool completion opens", 30_000);
	await new Promise((resolve) => setTimeout(resolve, 300));
	const framesAtAbort = ws2.frames.length;
	ws2.send({ type: "abort" });
	const hangRequest = requestsForTurn(STOP_TURN_TOKEN).find((r) => r.hang)!;
	await waitUntil(() => hangRequest.aborted, "hanging provider request aborted by Stop", 20_000);
	await waitUntil(async () => (await getStatus(room2)).activeThread?.inFlight === false, "stopped turn settled", 20_000);
	const stopStatus = await getStatus(room2);
	assert(stopStatus.activeThread?.activeTurn?.lastTerminalReason === "cancelled", `the stopped turn should settle cancelled, got ${JSON.stringify(stopStatus.activeThread?.activeTurn)}`);
	// The settle window: pre-fix, maybeAutoSummarizeToolTurn ran right after
	// the aborted prompt returned, so its second completion (and its ghost
	// answer on the socket) would land well inside these seconds.
	await new Promise((resolve) => setTimeout(resolve, 2500));
	const stopRequests = requestsForTurn(STOP_TURN_TOKEN);
	assert(stopRequests.length === 2, `the stopped turn should cost exactly 2 completions (tool leg + aborted post-tool leg), got ${stopRequests.length}`);
	assert(stopRequests.every((r) => !r.internal), "no recovery completion may fire for a stopped turn");
	assert(gatewayRequests.filter((r) => r.body.includes(STOP_TURN_TOKEN) && (r.body.includes("INTERNAL_TOOL_SUMMARY_REQUEST") || r.body.includes("INTERNAL_RETRIEVAL_SYNTHESIS_REQUEST"))).length === 0, "no gateway request body of the stopped turn may carry an internal recovery marker");
	// The socket reflects the cancellation and nothing more: one agent turn,
	// no assistant text after the abort, never the ghost answer.
	assert(countAgentStarts(ws2.frames) === 1, `the stopped turn must not start a second agent turn, got ${countAgentStarts(ws2.frames)} agent_start frames`);
	const textAfterAbort = ws2.frames.slice(framesAtAbort).map(deltaText).join("");
	assert(textAfterAbort === "", `no assistant text may stream after Stop, got ${JSON.stringify(textAfterAbort.slice(0, 120))}`);
	assert(!ws2.frames.some((frame) => JSON.stringify(frame).includes(RECOVERY_ANSWER)), "the ghost answer must never reach the socket");
	// The turn's end says Stop ended it, so every page that watched picks the Stop line.
	const stopEnd = ws2.frames.find((frame) => frame?.type === "event" && frame.event?.type === "agent_end");
	assert(stopEnd?.event?.endedBy === "stop", `the stopped turn's agent_end says endedBy "stop", got ${JSON.stringify(stopEnd?.event?.endedBy)}`);
	ws2.close();
	ws2 = null;
	await waitUntil(async () => !(await getStatus(room2)).activeLock, "stop room lock released", 20_000);
	console.log("  regression pin: Stop left 2 completions, no INTERNAL_TOOL_SUMMARY_REQUEST, no ghost answer");

	// --- 3. Stop while a command card waits for the person ------------------
	const { STOPPED_BEFORE_ANSWER_SENTENCE } = await import("../src/turn-ended-by.js");
	const room3 = await createSkillRoom("Stop Card Room");
	const workspaceRoot = path.join(tempRoot, "workspace");
	fs.mkdirSync(workspaceRoot, { recursive: true });
	fs.writeFileSync(path.join(workspaceRoot, "notes.txt"), "notes\n");
	const workspace = await requestJson(`/api/persistent-agents/${encodeURIComponent(room3)}/workspace-default`, { method: "PUT", body: JSON.stringify({ root: workspaceRoot, displayLabel: "Card Workspace", workspaceAccessMode: "localFiles", bashEnabled: true }) });
	assert(workspace.status === 200, `Full access with the terminal on, got ${workspace.status}: ${JSON.stringify(workspace.body).slice(0, 300)}`);
	const conv3 = `smokeconv_card_${Date.now().toString(36)}`;
	await seedThread(room3, conv3);
	ws3 = await WsHarness.connect(room3, conv3);
	await ws3.waitFor((frame) => frame.type === "ready", "card-room ready frame");
	const isCard = (frame: Frame) => frame.type === "ui_request" && frame.kind === "confirm";
	const isTurnEnd = (frame: Frame) => frame.type === "event" && frame.event?.type === "agent_end";
	ws3.send({ type: "prompt", text: `${CARD_REQUEST}, please. ${CARD_TURN_TOKEN}` });
	const card = ws3.frames[await ws3.waitFor(isCard, "the command card", 0, 30_000)];
	const framesAtStop = ws3.frames.length;
	ws3.send({ type: "abort" });
	const stopEndIndex = await ws3.waitFor(isTurnEnd, "the stopped turn's end, without the card's answer", framesAtStop, 10_000);
	const cardStopEnd = ws3.frames[stopEndIndex];
	assert(cardStopEnd.event.endedBy === "stop", `the turn Stop ended with a card open says endedBy "stop", got ${JSON.stringify(cardStopEnd.event.endedBy)}`);
	assert(ws3.frames.slice(framesAtStop).some((frame) => frame.type === "ui_request_closed" && frame.id === card.id && frame.reason === "stopped"), `the page is told the card closed, got ${JSON.stringify(ws3.frames.slice(framesAtStop).map((frame) => frame.type))}`);
	const stoppedStep = ws3.frames.slice(framesAtStop).find((frame) => frame.type === "event" && frame.event?.type === "tool_execution_end" && frame.event.toolName === "bash");
	const stoppedStepText = String(stoppedStep?.event?.result?.content?.[0]?.text ?? "");
	assert(stoppedStepText.startsWith(STOPPED_BEFORE_ANSWER_SENTENCE), `the step's result starts with the Stop's sentence, got ${JSON.stringify(stoppedStep?.event?.result).slice(0, 300)}`);
	const delegateStep = ws3.frames.slice(framesAtStop).find((frame) => frame.type === "event" && frame.event?.type === "tool_execution_end" && frame.event.toolName === "delegate_task");
	const delegateText = String(delegateStep?.event?.result?.content?.[0]?.text ?? "");
	assert(delegateStep && !delegateText.startsWith("Specialist started"), `no specialist starts on the stopped turn's message, got ${JSON.stringify(delegateStep?.event?.result ?? null).slice(0, 300)}`);
	await waitUntil(async () => (await getStatus(room3)).activeThread?.inFlight === false, "card turn settled", 20_000);
	assert(fs.existsSync(path.join(workspaceRoot, "notes.txt")), "the workspace is untouched");
	// The next turn asks again, and its answer counts.
	const requestsBeforeNext = requestsForTurn(CARD_TURN_TOKEN).length;
	const framesAtNext = ws3.frames.length;
	ws3.send({ type: "prompt", text: `List them again, please. ${CARD_TURN_TOKEN}` });
	const nextCard = ws3.frames[await ws3.waitFor(isCard, "the next turn's command card", framesAtNext, 30_000)];
	assert(nextCard.id !== card.id, "the next turn asks with a card of its own");
	ws3.send({ type: "ui_response", id: nextCard.id, value: true });
	const nextEnd = ws3.frames[await ws3.waitFor(isTurnEnd, "the next turn's end", framesAtNext, 30_000)];
	assert(nextEnd.event.endedBy === undefined, `a turn that ran to its end carries no endedBy, got ${JSON.stringify(nextEnd.event.endedBy)}`);
	const nextStep = ws3.frames.slice(framesAtNext).find((frame) => frame.type === "event" && frame.event?.type === "tool_execution_end" && frame.event.toolName === "bash");
	assert(String(nextStep?.event?.result?.content?.[0]?.text ?? "").includes("notes.txt"), `the approved command ran, got ${JSON.stringify(nextStep?.event?.result).slice(0, 300)}`);
	assert(ws3.frames.slice(framesAtNext).some((frame) => deltaText(frame).includes(CARD_ANSWER)), "the next turn answered");
	// The model reads the Stop's sentence as the stopped step's result.
	const nextRequest = JSON.parse(requestsForTurn(CARD_TURN_TOKEN)[requestsBeforeNext].body);
	const toolResults = (nextRequest.messages as any[]).filter((message) => message?.role === "tool").map((message) => typeof message.content === "string" ? message.content : JSON.stringify(message.content));
	assert(toolResults.length === 2 && toolResults[0].startsWith(STOPPED_BEFORE_ANSWER_SENTENCE), `the model reads the stopped step's result as the Stop's sentence, got ${JSON.stringify(toolResults).slice(0, 300)}`);
	ws3.close();
	ws3 = null;
	await waitUntil(async () => !(await getStatus(room3)).activeLock, "card room lock released", 20_000);
	console.log("  Stop with a card open: the turn ended at once, the card closed, the model read the Stop's sentence, no specialist started, the next turn asked again");

	// --- 4. A failure ends the turn; Stop in a retry wait ends it too -------
	const room4 = await createSkillRoom("Ended By Room");
	const conv4 = `smokeconv_endedby_${Date.now().toString(36)}`;
	await seedThread(room4, conv4);
	ws4 = await WsHarness.connect(room4, conv4);
	await ws4.waitFor((frame) => frame.type === "ready", "ended-by ready frame");
	ws4.send({ type: "prompt", text: `Please answer this. ${FAILED_TURN_TOKEN}` });
	const failedEnd = ws4.frames[await ws4.waitFor(isTurnEnd, "the failed turn's end", 0, 30_000)];
	assert(failedEnd.event.endedBy === undefined, `a failed model call ends its turn with no endedBy, got ${JSON.stringify(failedEnd.event.endedBy)}`);
	assert(ws4.frames.some((frame) => frame.type === "event" && frame.event?.type === "message_end" && typeof frame.event.failure === "string"), "the failed call is told by its own failure");
	assert(!ws4.frames.some((frame) => frame.type === "event" && frame.event?.type === "auto_retry_start"), "the failure was not asked again");
	await waitUntil(async () => (await getStatus(room4)).activeThread?.inFlight === false, "failed turn settled", 20_000);
	const framesAtRetry = ws4.frames.length;
	ws4.send({ type: "prompt", text: `Please answer this one. ${RETRY_STOP_TURN_TOKEN}` });
	await ws4.waitFor((frame) => frame.type === "event" && frame.event?.type === "auto_retry_start", "the retry wait", framesAtRetry, 30_000);
	const attemptEnd = ws4.frames.slice(framesAtRetry).find(isTurnEnd);
	assert(attemptEnd?.event?.retrying === true && attemptEnd.event.endedBy === undefined, `the attempt the runtime asks again says nothing about how the turn ended, got ${JSON.stringify(attemptEnd?.event ?? null).slice(0, 300)}`);
	const framesAtRetryStop = ws4.frames.length;
	ws4.send({ type: "abort" });
	const retryEnd = ws4.frames[await ws4.waitFor((frame) => frame.type === "event" && frame.event?.type === "auto_retry_end", "the retry wait's end", framesAtRetryStop, 10_000)];
	assert(retryEnd.event.success === false && retryEnd.event.endedBy === "stop", `Stop in a retry wait says endedBy "stop" on the retry's end, got ${JSON.stringify(retryEnd.event)}`);
	await waitUntil(async () => (await getStatus(room4)).activeThread?.inFlight === false, "retry turn settled", 20_000);
	ws4.close();
	ws4 = null;
	await waitUntil(async () => !(await getStatus(room4)).activeLock, "ended-by room lock released", 20_000);
	console.log("  endedBy: Stop in a retry wait says stop on the retry's end; a failed call is told by its own failure");

	console.log("persistent-room-stop-recovery-smoke: OK");
} catch (error) {
	console.error(serverOutput.join("").slice(-6000));
	throw error;
} finally {
	try { ws1?.close(); } catch {}
	try { ws2?.close(); } catch {}
	try { ws3?.close(); } catch {}
	try { ws4?.close(); } catch {}
	try { (gateway as any).closeAllConnections?.(); } catch {}
	try { gateway.close(); } catch {}
	await stopSmokeServer(server);
	fs.rmSync(tempRoot, { recursive: true, force: true });
}
