// How a room's commands run: what a folder can't set, and what a command can't read.
//
// A real server, a real room with Full access and Bash on, real websocket turns;
// the model is a synthetic gateway that runs one command per conversation. Pinned:
//
// - a folder's .exxperts/settings.json can't name the shell or a command prefix,
//   and can't hide the Windows no-shell line;
// - the person's global settings still set both, with the folder's beside them;
// - a command can't read the app's sign-in token or a provider key: the runtime's
//   own names, and the names models.json and auth.json point at, a name saved
//   while the connection is open included;
// - the person's own variables still arrive, the tokens of their own tools among
//   them, and the agent bin stays first on PATH;
// - long output and a command's timeout read as they always did;
// - a background run on the same room is offered no bash, a memory worker no tools.
//
// The stand-in shells are shell scripts, so this needs a machine that is not Windows.
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import { fileURLToPath } from "node:url";
import { authedFetch, SMOKE_AUTH_HEADERS, SMOKE_AUTH_TOKEN, SMOKE_SERVER_AUTH_ENV, SMOKE_SERVER_SPAWN_TREE_OPTIONS, smokeHomeEnv, stopSmokeServer, freePort, type AuthedFetchInit, putRunWithoutAsking } from "./smoke-server-process.js";
import { waitForTurnSettled } from "./smoke-turn-settle.js";

function assert(condition: unknown, message: string): asserts condition {
	if (!condition) throw new Error(message);
}

if (process.platform === "win32") {
	console.log("room-command-tool smoke skipped (the stand-in shells need a machine that is not Windows)");
	process.exit(0);
}

const NO_SHELL_SENTENCE = "On Windows, shell commands need Git for Windows. Install it from gitforwindows.org; the room can run commands as soon as it is installed. If it still says this, restart exxperts.";

// Written by hand: a name the runtime's table gains or loses shows up here.
const PROVIDER_KEY_NAMES = [
	"ANTHROPIC_OAUTH_TOKEN", "ANTHROPIC_API_KEY", "OPENAI_API_KEY", "AZURE_OPENAI_API_KEY", "DEEPSEEK_API_KEY", "GEMINI_API_KEY",
	"GOOGLE_CLOUD_API_KEY", "GROQ_API_KEY", "CEREBRAS_API_KEY", "XAI_API_KEY", "OPENROUTER_API_KEY", "AI_GATEWAY_API_KEY", "ZAI_API_KEY",
	"MISTRAL_API_KEY", "MINIMAX_API_KEY", "MINIMAX_CN_API_KEY", "MOONSHOT_API_KEY", "FIREWORKS_API_KEY", "TOGETHER_API_KEY",
	"OPENCODE_API_KEY", "KIMI_API_KEY", "CLOUDFLARE_API_KEY", "XIAOMI_API_KEY", "XIAOMI_TOKEN_PLAN_CN_API_KEY", "XIAOMI_TOKEN_PLAN_AMS_API_KEY",
	"XIAOMI_TOKEN_PLAN_SGP_API_KEY", "COPILOT_GITHUB_TOKEN", "AWS_BEARER_TOKEN_BEDROCK",
];
const MODELS_JSON_KEY_NAME = "SMOKE_MODELS_JSON_KEY";
const AUTH_JSON_KEY_NAME = "SMOKE_AUTH_JSON_KEY";
const HEADER_KEY_NAME = "SMOKE_PROVIDER_HEADER_KEY";
const MODEL_HEADER_KEY_NAME = "SMOKE_MODEL_HEADER_KEY";
const OVERRIDE_HEADER_KEY_NAME = "SMOKE_OVERRIDE_HEADER_KEY";
const REMOVED_NAMES = ["EXXPERTS_AUTH_TOKEN", ...PROVIDER_KEY_NAMES, MODELS_JSON_KEY_NAME, AUTH_JSON_KEY_NAME, HEADER_KEY_NAME, MODEL_HEADER_KEY_NAME, OVERRIDE_HEADER_KEY_NAME];
// Plain variables until a key is saved under their name, with the room's connection open.
const LATE_AUTH_KEY_NAME = "SMOKE_LATE_AUTH_KEY";
const LATE_MODELS_KEY_NAME = "SMOKE_LATE_MODELS_KEY";
const LATE_REPLACEMENT_KEY_NAME = "SMOKE_LATE_REPLACEMENT_KEY";
// Next to the removed names on purpose: nothing goes by what a name looks like.
const KEPT_VARIABLES: Record<string, string> = { SMOKE_OWN_VARIABLE: "own-value", MY_OPENAI_API_KEY_NOTES: "own-notes", AWS_REGION: "eu-central-1", GH_TOKEN: "own-gh-token", GITHUB_TOKEN: "own-github-token", HF_TOKEN: "own-hf-token" };
const markerValue = (name: string) => `marker-value-of-${name.toLowerCase()}`;

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const webServerDir = path.resolve(scriptDir, "..");
const repoRoot = path.resolve(webServerDir, "..", "..");
const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "exxperts-room-commands-"));

/** A stand-in shell: says it ran by leaving a file, then runs the command in bash. */
function writeShell(file: string, marker: string): void {
	fs.writeFileSync(file, `#!/bin/sh\n: > ${JSON.stringify(marker)}\nexec /bin/bash "$@"\n`, { mode: 0o755 });
}

// ---------------------------------------------------------------------------
// Synthetic gateway: a conversation's first request runs `nextCall`, or answers
// at once with none set; the request with the tool's result is answered "done".
// ---------------------------------------------------------------------------
let nextCall: { command: string; timeout?: number } | null = null;
const offeredTools: string[][] = [];
let finishedTurns = 0;

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
		const parsed = JSON.parse(body);
		const messages: any[] = Array.isArray(parsed?.messages) ? parsed.messages : [];
		offeredTools.push((parsed?.tools ?? []).map((tool: any) => String(tool?.function?.name)));
		res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
		const base = { id: `cmpl_${offeredTools.length}`, object: "chat.completion.chunk", created: Math.floor(Date.now() / 1000), model: String(parsed?.model ?? "room-model") };
		if (nextCall && messages.at(-1)?.role !== "tool") {
			res.write(sseChunk({ ...base, choices: [{ index: 0, delta: { role: "assistant", tool_calls: [{ index: 0, id: "call_bash", type: "function", function: { name: "bash", arguments: "" } }] }, finish_reason: null }] }));
			res.write(sseChunk({ ...base, choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: JSON.stringify(nextCall) } }] }, finish_reason: null }] }));
			res.write(sseChunk({ ...base, choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }], usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 } }));
		} else {
			finishedTurns += 1;
			res.write(sseChunk({ ...base, choices: [{ index: 0, delta: { role: "assistant", content: "done" }, finish_reason: null }] }));
			res.write(sseChunk({ ...base, choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 150, completion_tokens: 5, total_tokens: 155 } }));
		}
		res.write("data: [DONE]\n\n");
		res.end();
	});
});

type SmokeServer = { process: ChildProcessWithoutNullStreams; baseUrl: string; port: number; output: string[]; home: string; agentDir: string; agentsRoot: string };

function writeHome(label: string, gatewayPort: number): { home: string; agentDir: string; agentsRoot: string } {
	const home = path.join(tempRoot, label);
	const agentDir = path.join(home, ".exxperts", "agent");
	const productAppRoot = path.join(home, ".exxperts", "app");
	const agentsRoot = path.join(productAppRoot, "personalized-agents");
	fs.mkdirSync(agentsRoot, { recursive: true, mode: 0o700 });
	fs.mkdirSync(agentDir, { recursive: true, mode: 0o700 });
	const gatewayProvider = { baseUrl: `http://127.0.0.1:${gatewayPort}/v1`, api: "openai-completions", models: [{ id: "room-model", name: "Room Model", contextWindow: 128000, maxTokens: 16384 }] };
	fs.writeFileSync(path.join(agentDir, "models.json"), JSON.stringify({
		providers: {
			"openai-compatible": { name: "Synthetic Gateway", ...gatewayProvider },
			"models-json-gateway": { name: "Key In Models", apiKey: MODELS_JSON_KEY_NAME, ...gatewayProvider },
			"auth-json-gateway": { name: "Key In Auth", ...gatewayProvider },
			"header-gateway": { name: "Key In Headers", headers: { "x-portkey-api-key": HEADER_KEY_NAME }, ...gatewayProvider, models: [{ ...gatewayProvider.models[0], headers: { "x-model-key": MODEL_HEADER_KEY_NAME } }], modelOverrides: { "room-model": { headers: { "x-override-key": OVERRIDE_HEADER_KEY_NAME } } } },
		},
	}, null, 2), { mode: 0o600 });
	fs.writeFileSync(path.join(agentDir, "auth.json"), JSON.stringify({
		"openai-compatible": { type: "api_key", key: "synthetic-command-key" },
		"auth-json-gateway": { type: "api_key", key: AUTH_JSON_KEY_NAME },
	}, null, 2), { mode: 0o600 });
	fs.writeFileSync(path.join(productAppRoot, "openai-compatible-ai-profile.json"), JSON.stringify({ profileId: "openai-compatible", providerId: "openai-compatible", label: "Synthetic Gateway", roomModels: [{ modelId: "room-model", label: "Room Model" }], maintenanceModel: "room-model" }, null, 2), { mode: 0o600 });
	fs.writeFileSync(path.join(productAppRoot, "persistent-agent-ai-profile.json"), JSON.stringify({ profileId: "openai-compatible" }, null, 2), { mode: 0o600 });
	return { home, agentDir, agentsRoot };
}

async function startServer(label: string, gatewayPort: number, extraEnv: Record<string, string>): Promise<SmokeServer> {
	const { home, agentDir, agentsRoot } = writeHome(label, gatewayPort);
	const port = await freePort();
	const child = spawn("npx", ["tsx", "src/index.ts"], {
		...SMOKE_SERVER_SPAWN_TREE_OPTIONS,
		cwd: webServerDir,
		env: smokeHomeEnv(home, { PORT: String(port), ...SMOKE_SERVER_AUTH_ENV, EXXETA_HOME: repoRoot, EXXPERTS_CODING_AGENT_DIR: agentDir, EXXETA_PERSISTENT_AGENTS_ROOT: agentsRoot, ...extraEnv }) as NodeJS.ProcessEnv,
	});
	const output: string[] = [];
	child.stdout.on("data", (chunk) => output.push(String(chunk)));
	child.stderr.on("data", (chunk) => output.push(String(chunk)));
	const baseUrl = `http://127.0.0.1:${port}`;
	const deadline = Date.now() + 20_000;
	while (true) {
		if (child.exitCode != null) throw new Error(`server ${label} exited before startup with code ${child.exitCode}`);
		try {
			if ((await fetch(`${baseUrl}/healthz`)).ok) break;
		} catch {}
		if (Date.now() > deadline) throw new Error(`server ${label} did not become ready`);
		await new Promise((resolve) => setTimeout(resolve, 150));
	}
	return { process: child, baseUrl, port, output, home, agentDir, agentsRoot };
}

async function requestJson(server: SmokeServer, pathname: string, init: AuthedFetchInit = {}): Promise<{ status: number; body: any }> {
	const response = await authedFetch(`${server.baseUrl}${pathname}`, { ...init, headers: { ...(init.body ? { "content-type": "application/json" } : {}), ...init.headers } });
	const text = await response.text();
	return { status: response.status, body: text ? JSON.parse(text) : null };
}

/** A room on `folder` with Full access, Bash on and asking off, as a person would set it. */
async function createBashRoom(server: SmokeServer, folder: string): Promise<string> {
	const room = await requestJson(server, "/api/persistent-agents", { method: "POST", body: JSON.stringify({ displayName: "Command Room", userName: "Synthetic User", preferredUserAddress: "Synthetic User" }) });
	assert(room.status === 201, `room creation: expected 201, got ${room.status}: ${JSON.stringify(room.body)}`);
	const agentId = String(room.body?.agent?.id ?? "");
	const workspace = await requestJson(server, `/api/persistent-agents/${encodeURIComponent(agentId)}/workspace-default`, {
		method: "PUT",
		body: JSON.stringify({ root: folder, displayLabel: "Command Workspace", workspaceAccessMode: "localFiles", bashEnabled: true }),
	});
	assert(workspace.status === 200 && workspace.body?.policy?.bashEnabled === true, `workspace default PUT: got ${workspace.status}: ${JSON.stringify(workspace.body)}`);
	const ask = await putRunWithoutAsking(`${server.baseUrl}/api/persistent-agents/${encodeURIComponent(agentId)}/bash-settings`, true);
	assert(ask.status === 200, `bash-settings PUT: got ${ask.status}`);
	return agentId;
}

const WebSocketImpl: any = (await import("ws")).default;

type Conversation = { run: (call: { command: string; timeout?: number }) => Promise<{ text: string; isError: boolean }>; close: () => void };

/** A new conversation on its own connection, which binds a new session; `run` is one turn, returning the command's result as the chat received it. */
async function openConversation(server: SmokeServer, agentId: string, conversationId: string): Promise<Conversation> {
	const seeded = await requestJson(server, `/api/persistent-agents/${encodeURIComponent(agentId)}/threads/${encodeURIComponent(conversationId)}`, {
		method: "PUT",
		body: JSON.stringify({ state: "active", origin: "launcher", model: { provider: "openai-compatible", model: "room-model" }, items: [] }),
	});
	assert(seeded.status === 200, `thread seed: expected 200, got ${seeded.status}: ${JSON.stringify(seeded.body).slice(0, 300)}`);
	const socket = new WebSocketImpl(`ws://127.0.0.1:${server.port}/ws?persistentAgentId=${agentId}&conversationId=${conversationId}&modelProvider=openai-compatible&model=room-model&reattach=1`, { headers: { ...SMOKE_AUTH_HEADERS } });
	const frames: any[] = [];
	socket.addEventListener("message", (event: { data: unknown }) => {
		try { frames.push(JSON.parse(String(event.data))); } catch {}
	});
	await new Promise<void>((resolve, reject) => {
		socket.addEventListener("open", () => resolve());
		socket.addEventListener("error", () => reject(new Error("websocket failed to connect")));
	});
	const run: Conversation["run"] = async (call) => {
		const firstFrame = frames.length;
		const before = finishedTurns;
		nextCall = call;
		socket.send(JSON.stringify({ type: "prompt", text: "Run a command, please." }));
		const deadline = Date.now() + 30_000;
		while (Date.now() < deadline) {
			const turnFrames = frames.slice(firstFrame);
			if (finishedTurns > before && turnFrames.some((frame) => frame?.type === "event" && frame?.event?.type === "agent_end")) {
				await waitForTurnSettled((pathname) => requestJson(server, pathname), agentId, `${conversationId}: the turn has settled`);
				nextCall = null;
				const toolResult = turnFrames.find((frame) => frame?.type === "event" && frame?.event?.type === "message_end" && frame?.event?.message?.role === "toolResult")?.event?.message;
				assert(toolResult, "the chat must receive the command's result");
				return { text: (toolResult.content ?? []).filter((part: any) => part?.type === "text").map((part: any) => part.text).join("\n"), isError: toolResult.isError === true };
			}
			const errors = turnFrames.filter((frame) => String(frame?.type ?? "").includes("error"));
			if (errors.length > 0) throw new Error(`turn errored: ${JSON.stringify(errors[0]).slice(0, 400)}`);
			await new Promise((resolve) => setTimeout(resolve, 100));
		}
		throw new Error(`turn did not complete; frame types: ${frames.slice(firstFrame).map((frame) => frame?.type).join(", ")}`);
	};
	return { run, close: () => { try { socket.close(); } catch {} } };
}

async function runCommand(server: SmokeServer, agentId: string, conversationId: string, call: { command: string; timeout?: number }): Promise<{ text: string; isError: boolean }> {
	const conversation = await openConversation(server, agentId, conversationId);
	try {
		return await conversation.run(call);
	} finally {
		conversation.close();
	}
}

/** The variable names a finished `env` printed. */
function variableNames(text: string): Set<string> {
	return new Set(text.split("\n").filter((line) => line.includes("=")).map((line) => line.slice(0, line.indexOf("="))));
}

let server: SmokeServer | undefined;
let windowsServer: SmokeServer | undefined;
try {
	await new Promise<void>((resolve) => gateway.listen(0, "127.0.0.1", resolve));
	const gatewayPort = (gateway.address() as AddressInfo).port;

	// A downloaded project: its settings name a shell of its own and a hidden line.
	// In the main server's home: a room's folder in the shared temp is one no room may use.
	const folder = path.join(tempRoot, "main", "downloaded-project");
	fs.mkdirSync(path.join(folder, ".exxperts"), { recursive: true });
	const folderShellRan = path.join(tempRoot, "folder-shell-ran");
	writeShell(path.join(folder, "project-shell.sh"), folderShellRan);
	fs.writeFileSync(path.join(folder, ".exxperts", "settings.json"), JSON.stringify({ shellPath: path.join(folder, "project-shell.sh"), shellCommandPrefix: "echo folder-prefix-ran" }));

	const markers = Object.fromEntries(REMOVED_NAMES.filter((name) => name !== "EXXPERTS_AUTH_TOKEN").map((name) => [name, markerValue(name)]));
	// Acts as Linux, so on a Mac too these rows hold the plain path; the box's own environment has its row in room-box-smoke.ts.
	server = await startServer("main", gatewayPort, { EXXPERTS_TEST_INTROSPECTION: "1", EXXPERTS_TEST_SHELL_PLATFORM: "linux", ...markers, ...KEPT_VARIABLES, [LATE_AUTH_KEY_NAME]: "late-auth-value", [LATE_MODELS_KEY_NAME]: "late-models-value", [LATE_REPLACEMENT_KEY_NAME]: "late-replacement-value" });
	const room = await createBashRoom(server, folder);

	// 1. The folder's two settings do nothing.
	const plain = await runCommand(server, room, "conv-folder", { command: "echo command-ran" });
	assert(!plain.isError && plain.text.includes("command-ran"), `the command must run, got ${JSON.stringify(plain)}`);
	assert(!fs.existsSync(folderShellRan), "a folder's shellPath must not run the command");
	assert(!plain.text.includes("folder-prefix-ran"), `a folder's shellCommandPrefix must not run, got ${JSON.stringify(plain.text)}`);
	console.log("ok: a folder's shell path and command prefix have no effect");

	// 2. What a command can read, and what it can't.
	const envRun = await runCommand(server, room, "conv-env", { command: "env" });
	assert(!envRun.isError, `env must run, got ${JSON.stringify(envRun)}`);
	const seen = new Map(envRun.text.split("\n").filter((line) => line.includes("=")).map((line) => [line.slice(0, line.indexOf("=")), line.slice(line.indexOf("=") + 1)]));
	for (const name of REMOVED_NAMES) assert(!seen.has(name), `a command must not get ${name}`);
	assert(!envRun.text.includes(SMOKE_AUTH_TOKEN) && !envRun.text.includes("marker-value-of-"), "no secret's value may reach a command under another name");
	console.log(`ok: a command gets none of the ${REMOVED_NAMES.length} secret variables`);

	for (const [name, value] of Object.entries(KEPT_VARIABLES)) assert(seen.get(name) === value, `a person's ${name} must reach the command, got ${JSON.stringify(seen.get(name))}`);
	const pathEntries = String(seen.get("PATH")).split(path.delimiter);
	assert(pathEntries[0] === path.join(server.agentDir, "bin"), `the agent bin must stay first on PATH, got ${pathEntries[0]}`);
	assert(pathEntries.includes("/usr/bin"), `the rest of PATH must stay, got ${JSON.stringify(pathEntries)}`);
	console.log("ok: a person's own variables arrive and the agent bin stays first on PATH");

	// 3. A key saved while the connection is open counts from the next command.
	const open = await openConversation(server, room, "conv-late");
	const before = variableNames((await open.run({ command: "env" })).text);
	assert(before.has(LATE_AUTH_KEY_NAME) && before.has(LATE_MODELS_KEY_NAME), "a variable that holds no key still arrives");
	const saved = await requestJson(server, "/api/auth/api-key", { method: "POST", body: JSON.stringify({ provider: "openrouter", key: LATE_AUTH_KEY_NAME }) });
	assert(saved.status === 200, `saving a key by its variable's name: got ${saved.status}: ${JSON.stringify(saved.body)}`);
	const afterAuth = variableNames((await open.run({ command: "env" })).text);
	assert(!afterAuth.has(LATE_AUTH_KEY_NAME) && afterAuth.has(LATE_MODELS_KEY_NAME), "a key saved in auth.json must leave the very next command, and only that one");
	const modelsPath = path.join(server.agentDir, "models.json");
	const catalog = JSON.parse(fs.readFileSync(modelsPath, "utf8"));
	catalog.providers["late-gateway"] = { ...catalog.providers["models-json-gateway"], apiKey: LATE_MODELS_KEY_NAME };
	const lateCatalog = JSON.stringify(catalog);
	fs.writeFileSync(modelsPath, lateCatalog);
	assert(!variableNames((await open.run({ command: "env" })).text).has(LATE_MODELS_KEY_NAME), "a key named in models.json must leave the very next command");
	fs.writeFileSync(modelsPath, `${lateCatalog}, not json`);
	assert(!variableNames((await open.run({ command: "env" })).text).has(LATE_MODELS_KEY_NAME), "a models.json that stops parsing must not hand back the keys it named");
	// The open session keeps signing in with the old key, so naming a new one must not free it.
	catalog.providers["late-gateway"].apiKey = LATE_REPLACEMENT_KEY_NAME;
	fs.writeFileSync(modelsPath, JSON.stringify(catalog));
	const afterReplace = variableNames((await open.run({ command: "env" })).text);
	assert(!afterReplace.has(LATE_MODELS_KEY_NAME) && !afterReplace.has(LATE_REPLACEMENT_KEY_NAME), "replacing a key's name must keep both out of the next command");
	open.close();
	console.log("ok: a key saved with the connection open leaves the next command, and neither a broken file nor a new name gives one back");

	// 4. Long output and a timeout read as they always did.
	const long = await runCommand(server, room, "conv-long", { command: "seq 1 5000" });
	const fullOutput = /Full output: (\S+?)\]/.exec(long.text)?.[1];
	assert(!long.isError && long.text.includes("[Showing lines 3002-5001 of 5001.") && fullOutput, `long output must be cut with its note, got ${JSON.stringify(long.text.slice(-200))}`);
	assert(fs.readFileSync(fullOutput, "utf8").split("\n").length === 5001, "the full output must be on disk");
	const startedAt = Date.now();
	const late = await runCommand(server, room, "conv-timeout", { command: "echo before-the-wait; sleep 30", timeout: 1 });
	assert(late.isError && late.text.includes("before-the-wait") && late.text.includes("Command timed out after 1 seconds"), `a timeout must fail with its line, got ${JSON.stringify(late)}`);
	assert(Date.now() - startedAt < 25_000, "the timeout must end the command, not wait for it");
	console.log("ok: long output and a timeout read as before");

	// 5. The person's global settings set both, with the folder's settings still there.
	const globalShellRan = path.join(tempRoot, "global-shell-ran");
	const globalShell = path.join(tempRoot, "global-shell.sh");
	writeShell(globalShell, globalShellRan);
	fs.writeFileSync(path.join(server.agentDir, "settings.json"), JSON.stringify({ shellPath: globalShell, shellCommandPrefix: "export FROM_GLOBAL_PREFIX=global-prefix-ran" }));
	const personal = await runCommand(server, room, "conv-global", { command: "echo \"$FROM_GLOBAL_PREFIX\"" });
	assert(!personal.isError && personal.text.includes("global-prefix-ran"), `the global prefix must run, got ${JSON.stringify(personal)}`);
	assert(fs.existsSync(globalShellRan), "the global shell path must run the command");
	assert(!fs.existsSync(folderShellRan) && !personal.text.includes("folder-prefix-ran"), "the folder's settings must stay out beside the global ones");
	console.log("ok: the global shell path and prefix still work, the folder's beside them do not");

	await stopSmokeServer(server.process);
	const { agentDir, agentsRoot, home } = server;
	server = undefined;

	// 6. A background run on the same room, Bash on, is offered no bash.
	delete process.env.EXXPERTS_DATA_DIR;
	delete process.env.EXXPERTS_STATE_HOME;
	Object.assign(process.env, { HOME: home, USERPROFILE: home, EXXPERTS_CODING_AGENT_DIR: agentDir, EXXETA_PERSISTENT_AGENTS_ROOT: agentsRoot, EXXETA_HOME: repoRoot });
	const { executePersistentRoomBackgroundPrompt } = await import("../src/persistent-room-background-execution.js");
	const offeredBefore = offeredTools.length;
	await executePersistentRoomBackgroundPrompt({ roomId: room, target: { kind: "fresh-thread", model: { provider: "openai-compatible", model: "room-model" } }, prompt: "Run a command, please.", executionId: "room-commands-background", cwd: folder, agentDir } as any);
	const backgroundTools = offeredTools[offeredBefore] ?? [];
	assert(backgroundTools.includes("read") && !backgroundTools.includes("bash"), `a background run has its file tools and no bash, got ${JSON.stringify(backgroundTools)}`);
	console.log("ok: a background run is offered no bash");

	// 7. Nor is a memory worker offered any tool. Specialist templates can't grant bash: specialist-runtime-smoke holds that.
	const { AuthStorage, ModelRegistry } = await import("@exxeta/exxperts-runtime");
	const { runIsolatedPersistentAgentWorker } = await import("../src/persistent-agent-worker-runtime.js");
	const workerRegistry = ModelRegistry.create(AuthStorage.create(path.join(agentDir, "auth.json")), path.join(agentDir, "models.json"));
	const workerRan = offeredTools.length;
	await runIsolatedPersistentAgentWorker({
		cwd: folder,
		agentDir,
		modelRegistry: workerRegistry,
		modelLock: { provider: "openai-compatible", model: "room-model" },
		resolveExpectedModel: (registry: any, lock: any) => registry.find(lock.provider, lock.model),
		workerSystemPrompt: "Answer.",
		triggerPrompt: "Run a command, please.",
		emptyTextError: "the worker gave no answer",
	});
	assert(offeredTools.length > workerRan && offeredTools[workerRan].length === 0, `a worker has no tools, got ${JSON.stringify(offeredTools[workerRan])}`);
	console.log("ok: a memory worker is offered no tools");

	// 8. A folder's shell path can't hide the Windows no-shell line.
	const programFiles = path.join(tempRoot, "program-files");
	fs.mkdirSync(programFiles);
	windowsServer = await startServer("windows", gatewayPort, { EXXPERTS_TEST_INTROSPECTION: "1", EXXPERTS_TEST_SHELL_PLATFORM: "win32", ProgramFiles: programFiles });
	const windowsFolder = path.join(windowsServer.home, "downloaded-project");
	fs.cpSync(folder, windowsFolder, { recursive: true });
	const windowsRoom = await createBashRoom(windowsServer, windowsFolder);
	const pane = await requestJson(windowsServer, `/api/persistent-agents/${encodeURIComponent(windowsRoom)}/workspace-default`);
	assert(pane.status === 200 && pane.body?.shellMissingNote === NO_SHELL_SENTENCE, `the folder's shell path must not count as a shell, got ${JSON.stringify(pane.body?.shellMissingNote)}`);
	console.log("ok: a folder's shell path does not hide the no-shell line");

	console.log("room-command-tool-smoke: OK");
} catch (error) {
	for (const running of [server, windowsServer]) {
		if (running) console.error(running.output.join("").split("\n").filter((line) => !line.includes("token=")).join("\n").slice(-6000));
	}
	throw error;
} finally {
	try { gateway.close(); } catch {}
	await stopSmokeServer(server?.process);
	await stopSmokeServer(windowsServer?.process);
	fs.rmSync(tempRoot, { recursive: true, force: true });
}
