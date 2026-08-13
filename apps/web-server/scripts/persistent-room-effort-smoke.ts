import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import http from "node:http";
import type { AddressInfo } from "node:net";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { authedFetch, type AuthedFetchInit, SMOKE_AUTH_HEADERS, SMOKE_SERVER_AUTH_ENV, SMOKE_SERVER_SPAWN_TREE_OPTIONS, stopSmokeServer } from "./smoke-server-process.js";

// Per-room reasoning effort, end to end against a real spawned server and a
// synthetic OpenAI-compatible gateway that records the reasoning_effort each
// turn actually asked the provider for. Proves:
//   1. capability exposure: the ready frame reports the level in force plus
//      the levels the room's LOCKED model can do, and a non-reasoning model
//      reports "off" alone (which is how the composer knows to hide the pill);
//   2. a room that never chose keeps the machine-wide default thinking level
//      and has NO settings record written on its behalf, at bind or on a turn;
//   3. a prompt frame carrying `effort` applies that level to the turn and
//      makes it the room's sticky choice;
//   4. a prompt frame WITHOUT `effort` inherits the sticky level;
//   5. the sticky level survives leaving and re-entering the room;
//   6. an unknown value is ignored and a known-but-unreachable value clamps
//      to what the locked model can do, neither ever throwing, and the RAW
//      preference survives in the file rather than being replaced by the clamp;
//   7. the standalone effort frame persists the choice between turns;
//   8. a client that echoes the CLAMPED level it was shown on its next prompt
//      cannot destroy the raw stored preference;
//   9. the ready frame carries the model's own DIAL: one rung per distinct
//      effort, deduped where two internal tokens produce the same one, each
//      labelled the way the provider names it, and selection still speaks
//      internal tokens while storage stays raw;
//  10. a model with a mapped top tier runs a turn at "max" and the gateway
//      sees the provider effort "max";
//  11. a level folded away IMPLICITLY (no map entry, the adapter decides) is
//      reported on the rung that replaced it, never on the bottom of the dial;
//  12. a rung whose label differs from its token is selected and stored by
//      TOKEN, never by the label the user read;
//  13. through all of it, the CLI-wide defaultThinkingLevel in the runtime
//      settings file is never touched.

const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), "exxperts-room-effort-home-"));
const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const webServerDir = path.resolve(scriptDir, "..");
const repoRoot = path.resolve(webServerDir, "..", "..");
const port = 24000 + Math.floor(Math.random() * 10000);
const baseUrl = `http://127.0.0.1:${port}`;
const agentDir = path.join(tempHome, ".exxperts", "agent");
const productAppRoot = path.join(tempHome, ".exxperts", "app");
const settingsPath = path.join(agentDir, "settings.json");

// The CLI-wide preference this feature must never move.
const CLI_DEFAULT_THINKING_LEVEL = "minimal";
const ANSWER_CHUNKS = ["Quick ", "answer."];

function assert(condition: unknown, message: string): asserts condition {
	if (!condition) throw new Error(message);
}

// ---------------------------------------------------------------------------
// Synthetic OpenAI-compatible gateway: every request records the model it was
// for and the reasoning_effort the runtime asked for (absent = no reasoning).
// ---------------------------------------------------------------------------
type GatewayRequest = { model: string; reasoningEffort: string | null };
const gatewayRequests: GatewayRequest[] = [];

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
		const model = String(parsed?.model ?? "");
		gatewayRequests.push({ model, reasoningEffort: typeof parsed?.reasoning_effort === "string" ? parsed.reasoning_effort : null });
		res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
		const base = { id: `cmpl_${gatewayRequests.length}`, object: "chat.completion.chunk", created: Math.floor(Date.now() / 1000), model };
		res.write(sseChunk({ ...base, choices: [{ index: 0, delta: { role: "assistant", content: "" }, finish_reason: null }] }));
		for (const chunk of ANSWER_CHUNKS) {
			res.write(sseChunk({ ...base, choices: [{ index: 0, delta: { content: chunk }, finish_reason: null }] }));
		}
		res.write(sseChunk({
			...base,
			choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
			usage: { prompt_tokens: 40, completion_tokens: 8, total_tokens: 48 },
		}));
		res.write("data: [DONE]\n\n");
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

async function requestJson(pathname: string, init?: AuthedFetchInit): Promise<{ status: number; body: any }> {
	const response = await authedFetch(`${baseUrl}${pathname}`, init);
	const text = await response.text();
	return { status: response.status, body: text ? JSON.parse(text) : null };
}

async function createRoom(displayName: string): Promise<string> {
	const response = await requestJson("/api/persistent-agents", {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ displayName, userName: "Synthetic User", preferredUserAddress: "Synthetic User" }),
	});
	assert(response.status === 201, `room creation should return 201, got ${response.status}: ${JSON.stringify(response.body)}`);
	const id = String(response.body?.agent?.id ?? "");
	assert(id, `room creation should return an agent id, got ${JSON.stringify(response.body)}`);
	return id;
}

async function putThread(agentId: string, threadId: string, modelId: string, items: unknown[]): Promise<void> {
	const response = await requestJson(`/api/persistent-agents/${agentId}/threads/${threadId}`, {
		method: "PUT",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ state: "active", origin: "launcher", model: { provider: "openai-compatible", model: modelId }, items }),
	});
	assert(response.status === 200, `thread PUT should return 200, got ${response.status}: ${JSON.stringify(response.body)}`);
}

function readStickyLevel(agentId: string): string | null {
	const file = path.join(tempHome, ".exxperts", "app", "personalized-agents", agentId, "runtime", "effort-settings.json");
	if (!fs.existsSync(file)) return null;
	return String(JSON.parse(fs.readFileSync(file, "utf-8")).level ?? "");
}

function readCliDefaultThinkingLevel(): unknown {
	if (!fs.existsSync(settingsPath)) return undefined;
	return JSON.parse(fs.readFileSync(settingsPath, "utf-8")).defaultThinkingLevel;
}

type Frame = Record<string, any>;

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

	static async connect(persistentAgentId: string, conversationId: string, modelId: string): Promise<WsHarness> {
		const socket = new WebSocketImpl(`ws://127.0.0.1:${port}/ws?persistentAgentId=${persistentAgentId}&conversationId=${conversationId}&modelProvider=openai-compatible&model=${modelId}&reattach=1`, { headers: { ...SMOKE_AUTH_HEADERS } });
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

// One full turn: send the prompt, wait for the answer to settle, and report
// what the provider was asked for. A real user types between turns; this
// harness does not, so a prompt landing in the previous turn's bookkeeping
// window is retried rather than treated as a failure.
async function runTurn(harness: WsHarness, frame: Frame): Promise<GatewayRequest> {
	for (let attempt = 0; attempt < 40; attempt++) {
		const before = gatewayRequests.length;
		const fromIndex = harness.frames.length;
		harness.send({ type: "prompt", text: "Say something short.", ...frame });
		const settledIndex = await harness.waitFor(
			(row) => (row.type === "event" && row.event?.type === "agent_end") || (row.type === "error" && /still running|is cancelling/.test(String(row.message ?? ""))),
			"turn end",
			fromIndex,
			20_000,
		);
		if (harness.frames[settledIndex].type === "error") {
			await new Promise((resolve) => setTimeout(resolve, 250));
			continue;
		}
		assert(gatewayRequests.length > before, "the turn should have reached the provider");
		return gatewayRequests[before];
	}
	throw new Error("the room never accepted a new turn");
}

function smokeEnv(): NodeJS.ProcessEnv {
	const env: NodeJS.ProcessEnv = { ...process.env };
	for (const key of [
		"ANTHROPIC_API_KEY",
		"ANTHROPIC_OAUTH_TOKEN",
		"OPENAI_API_KEY",
		"AZURE_OPENAI_API_KEY",
		"EXXETA_AI_API_KEY",
		"COPILOT_GITHUB_TOKEN",
		"GH_TOKEN",
		"GITHUB_TOKEN",
		"GEMINI_API_KEY",
		"GOOGLE_CLOUD_API_KEY",
		"OPENROUTER_API_KEY",
	]) {
		delete env[key];
	}
	env.HOME = tempHome;
	env.USERPROFILE = tempHome;
	env.PORT = String(port);
	Object.assign(env, SMOKE_SERVER_AUTH_ENV);
	env.EXXETA_HOME = repoRoot;
	env.EXXPERTS_CODING_AGENT_DIR = agentDir;
	return env;
}

let server: ChildProcessWithoutNullStreams | null = null;
const serverOutput: string[] = [];
let ws: WsHarness | null = null;
let ws2: WsHarness | null = null;
let wsPlain: WsHarness | null = null;
let wsFolding: WsHarness | null = null;
let wsAlways: WsHarness | null = null;
let wsImplicit: WsHarness | null = null;
let wsRenamed: WsHarness | null = null;
let passes = 0;

function pass(label: string): void {
	passes += 1;
	console.log(`  ok ${label}`);
}

try {
	await new Promise<void>((resolve) => gateway.listen(0, "127.0.0.1", resolve));
	const gatewayPort = (gateway.address() as AddressInfo).port;

	fs.mkdirSync(agentDir, { recursive: true, mode: 0o700 });
	fs.mkdirSync(productAppRoot, { recursive: true, mode: 0o700 });
	fs.writeFileSync(
		path.join(agentDir, "models.json"),
		JSON.stringify({
			providers: {
				"openai-compatible": {
					name: "Synthetic SSE Gateway",
					baseUrl: `http://127.0.0.1:${gatewayPort}/v1`,
					api: "openai-completions",
					models: [
						{ id: "thinker-model", name: "Thinker Model", contextWindow: 128000, maxTokens: 16384, reasoning: true },
						{ id: "plain-model", name: "Plain Model", contextWindow: 128000, maxTokens: 16384, reasoning: false },
						// Anthropic-shaped: "minimal" and "low" come out as the same
						// effort, and the two tiers above "high" are mapped, so this is
						// the ladder a Claude 5 model presents.
						{
							id: "folding-model",
							name: "Folding Model",
							contextWindow: 128000,
							maxTokens: 16384,
							reasoning: true,
							thinkingLevelMap: { minimal: "low", xhigh: "xhigh", max: "max" },
						},
						// Opus-4.6-shaped: its top tier is REACHED through the xhigh
						// token but is CALLED max, so label and token differ.
						{
							id: "renamed-top-model",
							name: "Renamed Top Model",
							contextWindow: 128000,
							maxTokens: 16384,
							reasoning: true,
							thinkingLevelMap: { xhigh: "max" },
						},
						// gpt-5-shaped: cannot stop reasoning, no tier above high.
						{
							id: "always-thinking-model",
							name: "Always Thinking Model",
							contextWindow: 128000,
							maxTokens: 16384,
							reasoning: true,
							thinkingLevelMap: { off: null },
						},
					],
				},
			},
		}, null, 2),
		{ mode: 0o600 },
	);
	fs.writeFileSync(
		path.join(agentDir, "auth.json"),
		JSON.stringify({ "openai-compatible": { type: "api_key", key: "synthetic-room-effort-key" } }, null, 2),
		{ mode: 0o600 },
	);
	// The CLI-wide preference, deliberately different from the room default so
	// a leak in either direction is visible.
	fs.writeFileSync(settingsPath, JSON.stringify({ defaultThinkingLevel: CLI_DEFAULT_THINKING_LEVEL }, null, 2), { mode: 0o600 });
	fs.writeFileSync(
		path.join(productAppRoot, "openai-compatible-ai-profile.json"),
		JSON.stringify({
			profileId: "openai-compatible",
			providerId: "openai-compatible",
			label: "Synthetic SSE Gateway",
			roomModels: [
				{ modelId: "thinker-model", label: "Thinker Model" },
				{ modelId: "plain-model", label: "Plain Model" },
				{ modelId: "folding-model", label: "Folding Model" },
				{ modelId: "always-thinking-model", label: "Always Thinking Model" },
				{ modelId: "renamed-top-model", label: "Renamed Top Model" },
			],
			maintenanceModel: "thinker-model",
		}, null, 2),
		{ mode: 0o600 },
	);
	fs.writeFileSync(path.join(productAppRoot, "persistent-agent-ai-profile.json"), JSON.stringify({ profileId: "openai-compatible" }, null, 2), { mode: 0o600 });

	server = spawn("npx", ["tsx", "src/index.ts"], {
		shell: process.platform === "win32",
		...SMOKE_SERVER_SPAWN_TREE_OPTIONS,
		cwd: webServerDir,
		env: smokeEnv(),
	});
	server.stdout.on("data", (chunk) => serverOutput.push(String(chunk)));
	server.stderr.on("data", (chunk) => serverOutput.push(String(chunk)));
	await waitForServer(server);

	const roomId = await createRoom("Effort Room");
	const conversationId = `effortconv_${Date.now().toString(36)}`;
	await putThread(roomId, conversationId, "thinker-model", []);

	// --- 1. Capability exposure on the ready frame ---------------------------
	ws = await WsHarness.connect(roomId, conversationId, "thinker-model");
	const readyIndex = await ws.waitFor((frame) => frame.type === "ready", "ready frame");
	const readyEffort = ws.frames[readyIndex].effort;
	assert(readyEffort, `ready should carry the room's effort status, got ${JSON.stringify(ws.frames[readyIndex])}`);
	assert(
		JSON.stringify(readyEffort.supported) === JSON.stringify(["off", "minimal", "low", "medium", "high"]),
		`a reasoning model should expose exactly its supported levels, got ${JSON.stringify(readyEffort.supported)}`,
	);
	// The machine-wide default is what an unchosen room reports, because it is
	// what the session resolved for itself and nothing overrode it.
	assert(readyEffort.level === CLI_DEFAULT_THINKING_LEVEL, `a room that never chose should report the session's own level, got ${JSON.stringify(readyEffort.level)}`);
	assert(readStickyLevel(roomId) === null, "binding a room must not write a settings record on its behalf");
	pass("ready exposes the locked model's supported levels and the level actually in force");

	// --- 2. A room that never chose keeps the machine-wide default -----------
	const defaultTurn = await runTurn(ws, {});
	assert(defaultTurn.reasoningEffort === CLI_DEFAULT_THINKING_LEVEL, `an unchosen room should keep the machine default, got ${JSON.stringify(defaultTurn.reasoningEffort)}`);
	assert(readStickyLevel(roomId) === null, "a turn in an unchosen room must not invent a settings record");
	pass("a room that never chose keeps the machine default and writes no record");

	// --- 3. A prompt carrying `effort` applies AND sticks --------------------
	const lowTurn = await runTurn(ws, { effort: "low" });
	assert(lowTurn.reasoningEffort === "low", `the chosen level should reach the provider, got ${JSON.stringify(lowTurn.reasoningEffort)}`);
	assert(readStickyLevel(roomId) === "low", `the choice should persist per room, got ${JSON.stringify(readStickyLevel(roomId))}`);
	pass("a prompt frame with effort applies the level and persists it per room");

	// --- 4. A prompt WITHOUT `effort` inherits the sticky level --------------
	const inheritedTurn = await runTurn(ws, {});
	assert(inheritedTurn.reasoningEffort === "low", `a frame without effort should inherit the sticky level, got ${JSON.stringify(inheritedTurn.reasoningEffort)}`);
	assert(readStickyLevel(roomId) === "low", `an inheriting turn must not rewrite the stored choice, got ${JSON.stringify(readStickyLevel(roomId))}`);
	pass("a prompt frame without effort inherits the room's sticky level and rewrites nothing");

	// --- 5. Unknown and unreachable values ----------------------------------
	const nonsenseTurn = await runTurn(ws, { effort: "turbo" });
	assert(nonsenseTurn.reasoningEffort === "low", `an unknown level should be ignored, got ${JSON.stringify(nonsenseTurn.reasoningEffort)}`);
	assert(readStickyLevel(roomId) === "low", `an unknown level must not overwrite the sticky choice, got ${JSON.stringify(readStickyLevel(roomId))}`);
	// xhigh is real vocabulary this model cannot reach: it clamps to the
	// highest level the model does have rather than failing the turn, and the
	// RAW choice stays on disk so a model that can reach it later still will.
	const clampedTurn = await runTurn(ws, { effort: "xhigh" });
	assert(clampedTurn.reasoningEffort === "high", `an unreachable level should clamp to the model's ceiling, got ${JSON.stringify(clampedTurn.reasoningEffort)}`);
	assert(readStickyLevel(roomId) === "xhigh", `the stored preference must stay raw, not the clamp, got ${JSON.stringify(readStickyLevel(roomId))}`);
	pass("an unknown value is ignored, an unreachable one clamps for the turn, and the raw choice survives");

	// --- 5b. A client that echoes the clamped level cannot destroy the raw ---
	// The ready and effort frames report the CLAMPED level. A client that hands
	// that value back on its next prompt (this app's composer deliberately does
	// not, but the frame is public) would otherwise turn "xhigh" into "high"
	// permanently.
	const echoedClampTurn = await runTurn(ws, { effort: "high" });
	assert(echoedClampTurn.reasoningEffort === "high", `the echoed level should still drive the turn, got ${JSON.stringify(echoedClampTurn.reasoningEffort)}`);
	assert(readStickyLevel(roomId) === "xhigh", `echoing the clamped level must not replace the raw preference, got ${JSON.stringify(readStickyLevel(roomId))}`);
	pass("echoing back the clamped level leaves the raw stored preference intact");

	// --- 6. The standalone effort frame, chosen between turns ----------------
	const effortFrameIndex = ws.frames.length;
	ws.send({ type: "effort", level: "minimal" });
	const echoIndex = await ws.waitFor((frame) => frame.type === "effort", "effort echo", effortFrameIndex);
	assert(ws.frames[echoIndex].level === "minimal", `the echo should report what took hold, got ${JSON.stringify(ws.frames[echoIndex].level)}`);
	assert(readStickyLevel(roomId) === "minimal", `the effort frame should persist the choice, got ${JSON.stringify(readStickyLevel(roomId))}`);
	const minimalTurn = await runTurn(ws, {});
	assert(minimalTurn.reasoningEffort === "minimal", `the next turn should use the frame's level, got ${JSON.stringify(minimalTurn.reasoningEffort)}`);
	pass("the standalone effort frame persists the choice and the next turn uses it");

	// --- 7. The choice survives leaving and re-entering the room -------------
	ws.close();
	ws = null;
	await new Promise((resolve) => setTimeout(resolve, 500));
	ws2 = await WsHarness.connect(roomId, conversationId, "thinker-model");
	const reReadyIndex = await ws2.waitFor((frame) => frame.type === "ready", "ready frame after re-entering");
	assert(ws2.frames[reReadyIndex].effort?.level === "minimal", `re-entering should report the sticky level, got ${JSON.stringify(ws2.frames[reReadyIndex].effort)}`);
	const reEnteredTurn = await runTurn(ws2, {});
	assert(reEnteredTurn.reasoningEffort === "minimal", `a turn after re-entering should keep the sticky level, got ${JSON.stringify(reEnteredTurn.reasoningEffort)}`);
	ws2.close();
	ws2 = null;
	pass("the sticky level survives leaving and re-entering the room");

	// --- 8. A non-reasoning model exposes "off" alone ------------------------
	const plainRoomId = await createRoom("Plain Room");
	const plainConversationId = `plainconv_${Date.now().toString(36)}`;
	await putThread(plainRoomId, plainConversationId, "plain-model", []);
	wsPlain = await WsHarness.connect(plainRoomId, plainConversationId, "plain-model");
	const plainReadyIndex = await wsPlain.waitFor((frame) => frame.type === "ready", "ready frame for the non-reasoning room");
	const plainEffort = wsPlain.frames[plainReadyIndex].effort;
	assert(JSON.stringify(plainEffort?.supported) === JSON.stringify(["off"]), `a non-reasoning model should expose off alone, got ${JSON.stringify(plainEffort?.supported)}`);
	assert(plainEffort?.level === "off", `a non-reasoning model should report off as the level, got ${JSON.stringify(plainEffort?.level)}`);
	const plainTurn = await runTurn(wsPlain, { effort: "high" });
	assert(plainTurn.reasoningEffort === null, `a non-reasoning model must never be asked to reason, got ${JSON.stringify(plainTurn.reasoningEffort)}`);
	assert(readStickyLevel(plainRoomId) === "high", `the raw choice should survive on a model that cannot reach it, got ${JSON.stringify(readStickyLevel(plainRoomId))}`);
	// The sharpest version of the raw-preference rule: this room reports "off"
	// on every frame because that is all its model can do, and a following turn
	// must not turn that display value into the stored preference.
	const plainFollowUp = await runTurn(wsPlain, {});
	assert(plainFollowUp.reasoningEffort === null, `the follow-up must still ask for no reasoning, got ${JSON.stringify(plainFollowUp.reasoningEffort)}`);
	assert(readStickyLevel(plainRoomId) === "high", `a follow-up turn must not flatten the stored choice to the model's clamp, got ${JSON.stringify(readStickyLevel(plainRoomId))}`);
	wsPlain.close();
	wsPlain = null;
	pass("a non-reasoning model reports off alone, is never asked to reason, and keeps the room's raw choice");

	// --- 9. The dial a model describes for itself ---------------------------
	// The folding model maps "minimal" onto the same effort as "low", exactly as
	// every Anthropic model does, so the dial must show that rung once.
	const foldingRoomId = await createRoom("Folding Room");
	const foldingConversationId = `foldconv_${Date.now().toString(36)}`;
	await putThread(foldingRoomId, foldingConversationId, "folding-model", []);
	wsFolding = await WsHarness.connect(foldingRoomId, foldingConversationId, "folding-model");
	const foldingReadyIndex = await wsFolding.waitFor((frame) => frame.type === "ready", "ready frame for the folding room");
	const foldingEffort = wsFolding.frames[foldingReadyIndex].effort;
	assert(
		JSON.stringify(foldingEffort?.ladder?.map((rung: any) => rung.level)) === JSON.stringify(["off", "low", "medium", "high", "xhigh", "max"]),
		`the dial should fold minimal into low and keep both top tiers, got ${JSON.stringify(foldingEffort?.ladder)}`,
	);
	assert(
		JSON.stringify(foldingEffort?.ladder?.map((rung: any) => rung.label)) === JSON.stringify(["off", "low", "medium", "high", "xhigh", "max"]),
		`each rung should be labelled with the effort it produces, got ${JSON.stringify(foldingEffort?.ladder)}`,
	);
	// The older unfolded list is still there for clients that predate the dial.
	assert(
		(foldingEffort?.supported ?? []).includes("minimal"),
		`the pre-ladder token list should be unchanged, got ${JSON.stringify(foldingEffort?.supported)}`,
	);
	pass("the ready frame carries the model's own dial, folded and labelled");

	// --- 10. Selection still speaks internal tokens, storage stays raw -------
	const foldingEffortIndex = wsFolding.frames.length;
	wsFolding.send({ type: "effort", level: "max" });
	const foldingEchoIndex = await wsFolding.waitFor((frame) => frame.type === "effort", "effort echo in the folding room", foldingEffortIndex);
	assert(wsFolding.frames[foldingEchoIndex].level === "max", `the echo should speak the internal token, got ${JSON.stringify(wsFolding.frames[foldingEchoIndex].level)}`);
	assert(readStickyLevel(foldingRoomId) === "max", `the raw token should be what is stored, got ${JSON.stringify(readStickyLevel(foldingRoomId))}`);
	const maxTurn = await runTurn(wsFolding, {});
	assert(maxTurn.reasoningEffort === "max", `a turn at the top tier should reach the provider as max, got ${JSON.stringify(maxTurn.reasoningEffort)}`);
	// A folded-away token still selects the rung that replaced it, and does not
	// leave the pill pointing at a tick the dial does not have.
	const foldedIndex = wsFolding.frames.length;
	wsFolding.send({ type: "effort", level: "minimal" });
	const foldedEcho = await wsFolding.waitFor((frame) => frame.type === "effort", "echo for a folded token", foldedIndex);
	assert(wsFolding.frames[foldedEcho].level === "low", `a folded token should report the rung that replaced it, got ${JSON.stringify(wsFolding.frames[foldedEcho].level)}`);
	wsFolding.close();
	wsFolding = null;
	pass("selection speaks internal tokens, a turn at max reaches the provider, and storage stays raw");

	// --- 11. A model that cannot stop reasoning has no off rung -------------
	const alwaysRoomId = await createRoom("Always Thinking Room");
	const alwaysConversationId = `alwaysconv_${Date.now().toString(36)}`;
	await putThread(alwaysRoomId, alwaysConversationId, "always-thinking-model", []);
	wsAlways = await WsHarness.connect(alwaysRoomId, alwaysConversationId, "always-thinking-model");
	const alwaysReadyIndex = await wsAlways.waitFor((frame) => frame.type === "ready", "ready frame for the always-thinking room");
	const alwaysEffort = wsAlways.frames[alwaysReadyIndex].effort;
	assert(
		JSON.stringify(alwaysEffort?.ladder?.map((rung: any) => rung.level)) === JSON.stringify(["minimal", "low", "medium", "high"]),
		`a model that cannot stop reasoning should offer minimal through high only, got ${JSON.stringify(alwaysEffort?.ladder)}`,
	);
	wsAlways.close();
	wsAlways = null;
	pass("a model that cannot stop reasoning offers no off rung");

	// --- 12. An IMPLICITLY folded level lands on the rung that replaced it ---
	// The always-thinking model maps nothing for "minimal", so nothing in the
	// map says where it went: the adapter decides. A room holding that token
	// must still be shown the rung that actually runs, and never "off", which
	// a user could confirm and genuinely stop the thinking.
	const implicitRoomId = await createRoom("Implicit Fold Room");
	const implicitConversationId = `implicitconv_${Date.now().toString(36)}`;
	await putThread(implicitRoomId, implicitConversationId, "folding-model", []);
	wsImplicit = await WsHarness.connect(implicitRoomId, implicitConversationId, "folding-model");
	await wsImplicit.waitFor((frame) => frame.type === "ready", "ready frame for the implicit-fold room");
	const implicitIndex = wsImplicit.frames.length;
	wsImplicit.send({ type: "effort", level: "minimal" });
	const implicitEcho = await wsImplicit.waitFor((frame) => frame.type === "effort", "echo for an implicitly folded token", implicitIndex);
	assert(
		wsImplicit.frames[implicitEcho].level === "low",
		`an implicitly folded token should report the low rung, got ${JSON.stringify(wsImplicit.frames[implicitEcho].level)}`,
	);
	assert(wsImplicit.frames[implicitEcho].level !== "off", "a thinking level must never be displayed as off");
	// Re-entering reads it back off disk through the same resolution.
	wsImplicit.close();
	await new Promise((resolve) => setTimeout(resolve, 500));
	wsImplicit = await WsHarness.connect(implicitRoomId, implicitConversationId, "folding-model");
	const implicitReady = await wsImplicit.waitFor((frame) => frame.type === "ready", "ready frame after re-entering the implicit-fold room");
	assert(
		wsImplicit.frames[implicitReady].effort?.level === "low",
		`a stored folded token should read back as the low rung, got ${JSON.stringify(wsImplicit.frames[implicitReady].effort)}`,
	);
	assert(readStickyLevel(implicitRoomId) === "minimal", `storage should still hold the raw token, got ${JSON.stringify(readStickyLevel(implicitRoomId))}`);
	wsImplicit.close();
	wsImplicit = null;
	pass("an implicitly folded level shows the rung that replaced it, and storage stays raw");

	// --- 13. A rung whose label differs from its token -----------------------
	const renamedRoomId = await createRoom("Renamed Top Room");
	const renamedConversationId = `renamedconv_${Date.now().toString(36)}`;
	await putThread(renamedRoomId, renamedConversationId, "renamed-top-model", []);
	wsRenamed = await WsHarness.connect(renamedRoomId, renamedConversationId, "renamed-top-model");
	const renamedReady = await wsRenamed.waitFor((frame) => frame.type === "ready", "ready frame for the renamed-top room");
	const renamedLadder = wsRenamed.frames[renamedReady].effort?.ladder ?? [];
	const topRung = renamedLadder[renamedLadder.length - 1];
	assert(topRung?.level === "xhigh" && topRung?.label === "max", `the top rung should be token xhigh labelled max, got ${JSON.stringify(topRung)}`);
	const renamedIndex = wsRenamed.frames.length;
	// The client sends the TOKEN of the tick it clicked, never the label.
	wsRenamed.send({ type: "effort", level: topRung.level });
	const renamedEcho = await wsRenamed.waitFor((frame) => frame.type === "effort", "echo in the renamed-top room", renamedIndex);
	assert(wsRenamed.frames[renamedEcho].level === "xhigh", `the echo should speak the token, got ${JSON.stringify(wsRenamed.frames[renamedEcho].level)}`);
	assert(readStickyLevel(renamedRoomId) === "xhigh", `storage should hold the token, not the label, got ${JSON.stringify(readStickyLevel(renamedRoomId))}`);
	const renamedTurn = await runTurn(wsRenamed, {});
	assert(renamedTurn.reasoningEffort === "max", `the provider should receive the label's effort, got ${JSON.stringify(renamedTurn.reasoningEffort)}`);
	wsRenamed.close();
	wsRenamed = null;
	pass("a rung whose label differs from its token is selected and stored by token");

	// --- 14. The CLI-wide default was never touched --------------------------
	assert(
		readCliDefaultThinkingLevel() === CLI_DEFAULT_THINKING_LEVEL,
		`the CLI-wide defaultThinkingLevel must survive untouched, got ${JSON.stringify(readCliDefaultThinkingLevel())}`,
	);
	pass("the CLI-wide default thinking level is never modified");

	console.log(`persistent-room-effort-smoke: ${passes} checks passed`);
} catch (error) {
	console.error(`persistent-room-effort-smoke FAILED: ${(error as Error).message}`);
	if (serverOutput.length > 0) console.error(serverOutput.join("").slice(-4000));
	process.exitCode = 1;
} finally {
	ws?.close();
	ws2?.close();
	wsPlain?.close();
	wsFolding?.close();
	wsAlways?.close();
	wsImplicit?.close();
	wsRenamed?.close();
	if (server) await stopSmokeServer(server);
	await new Promise<void>((resolve) => gateway.close(() => resolve()));
	try { fs.rmSync(tempHome, { recursive: true, force: true }); } catch {}
}
