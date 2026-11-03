// A room never installs packages from settings.json. The runtime's resource
// loader reads a `packages` list from the global settings (<agentDir>) and
// the project settings (<cwd>/.exxperts) and, for a package that is missing,
// starts npm to install it, every time a session opens. A room asks for no
// extensions, skills, prompts or themes from there, so that install is a
// program start nobody chose, on a folder nobody named, and on a shared
// server a way to run code. This smoke lists a missing npm package in both
// settings files, puts a fake npm first on PATH that only writes down how it
// was called, and opens each kind of room session against a synthetic
// gateway: the live room over the socket, a scheduled run, a specialist task
// and a maintenance worker. Each must answer, start no npm, and leave no
// package folder behind. Throwaway HOME.
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { authedFetch, freePort, smokeHomeEnv, SMOKE_AUTH_HEADERS, SMOKE_SERVER_AUTH_ENV, SMOKE_SERVER_SPAWN_TREE_OPTIONS, stopSmokeServer, type AuthedFetchInit } from "./smoke-server-process.js";
import { waitEvery } from "./smoke-wait.js";

function assert(condition: unknown, message: string): asserts condition {
	if (!condition) throw new Error(message);
}

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const webServerDir = path.resolve(scriptDir, "..");
const repoRoot = path.resolve(webServerDir, "..", "..");

const tempRoot = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "exxperts-room-packages-")));
const home = path.join(tempRoot, "home");
const agentDir = path.join(home, ".exxperts", "agent");
const appRoot = path.join(home, ".exxperts", "app");
const agentsRoot = path.join(appRoot, "personalized-agents");
const workspaceRoot = path.join(tempRoot, "workspace");
const fakeBin = path.join(tempRoot, "fake-bin");
const npmLog = path.join(tempRoot, "npm-calls.log");
const fakeGlobalRoot = path.join(tempRoot, "fake-npm-global", "lib", "node_modules");
for (const dir of [agentDir, appRoot, agentsRoot, path.join(workspaceRoot, ".exxperts"), fakeBin, fakeGlobalRoot]) fs.mkdirSync(dir, { recursive: true, mode: 0o700 });

// Set before any of the server's modules load: they read these once.
Object.assign(process.env, { HOME: home, USERPROFILE: home, EXXPERTS_CODING_AGENT_DIR: agentDir, EXXETA_PERSISTENT_AGENTS_ROOT: agentsRoot, EXXETA_HOME: repoRoot });
delete process.env.EXXPERTS_DATA_DIR;
delete process.env.EXXPERTS_STATE_HOME;
// Offline mode would hide the install this smoke looks for.
delete process.env.PI_OFFLINE;

// The fake npm answers `root -g` with a folder of its own and says yes to
// everything else, so a session that starts it still opens and the only
// trace is the log. The runtime finds npm on PATH unless settings name an
// npmCommand, and neither settings file here does.
// portability-ok: Windows finds the npm.cmd written next to it, never this script
fs.writeFileSync(path.join(fakeBin, "npm"), `#!/bin/sh\nprintf '%s :: %s\\n' "$(pwd)" "$*" >> '${npmLog}'\nif [ "$1" = "root" ]; then echo '${fakeGlobalRoot}'; fi\nexit 0\n`, { mode: 0o755 });
fs.writeFileSync(path.join(fakeBin, "npm.cmd"), `@echo off\r\necho %CD% :: %*>> "${npmLog}"\r\nif "%1"=="root" echo ${fakeGlobalRoot}\r\nexit /b 0\r\n`);
fs.writeFileSync(npmLog, "");
process.env.PATH = `${fakeBin}${path.delimiter}${process.env.PATH ?? ""}`;

const PROJECT_PACKAGE = "@room-packages-smoke/project-only";
const GLOBAL_PACKAGE = "@room-packages-smoke/global-only";
fs.writeFileSync(path.join(workspaceRoot, ".exxperts", "settings.json"), JSON.stringify({ packages: [`npm:${PROJECT_PACKAGE}`] }, null, 2));
fs.writeFileSync(path.join(agentDir, "settings.json"), JSON.stringify({ packages: [`npm:${GLOBAL_PACKAGE}`] }, null, 2));

const ANSWER = "ROOM-PACKAGES-ANSWER: the room answered.";
const MODEL = { provider: "openai-compatible", model: "room-model" };
const sseChunk = (payload: unknown): string => `data: ${JSON.stringify(payload)}\n\n`;
const gateway = http.createServer((req, res) => {
	if (req.method !== "POST" || !String(req.url ?? "").endsWith("/chat/completions")) { res.writeHead(404).end(); return; }
	let body = "";
	req.on("data", (chunk) => { body += chunk; });
	req.on("end", () => {
		const base = { id: "cmpl_room_packages", object: "chat.completion.chunk", created: Math.floor(Date.now() / 1000), model: MODEL.model };
		res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
		res.write(sseChunk({ ...base, choices: [{ index: 0, delta: { role: "assistant", content: ANSWER }, finish_reason: null }] }));
		res.write(sseChunk({ ...base, choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 100, completion_tokens: 10, total_tokens: 110 } }));
		res.write("data: [DONE]\n\n");
		res.end();
	});
});

const npmCalls = (): string[] => fs.readFileSync(npmLog, "utf-8").split("\n").filter(Boolean);
// Where an install would land: the project's and the agent dir's package
// folders, and the fake global root the fake npm hands out.
const packageFolders = [
	path.join(workspaceRoot, ".exxperts", "npm"),
	path.join(workspaceRoot, ".exxperts", "git"),
	path.join(agentDir, "npm"),
	path.join(agentDir, "git"),
	path.join(fakeGlobalRoot, GLOBAL_PACKAGE),
];

const waitUntil = waitEvery(100, 30_000);

// Each site runs on its own: a failure is written down and the next site
// still runs, so one run shows every site that starts npm.
const results: Array<{ site: string; problems: string[] }> = [];
async function site(name: string, run: () => Promise<string>): Promise<void> {
	for (const folder of packageFolders) fs.rmSync(folder, { recursive: true, force: true });
	const before = npmCalls().length;
	const problems: string[] = [];
	let answer = "";
	try {
		answer = await run();
	} catch (error) {
		problems.push(`the run failed: ${(error as Error).message.split("\n")[0]}`);
	}
	if (!problems.length && !answer.includes(ANSWER)) problems.push(`no answer from the gateway, got ${JSON.stringify(answer.slice(0, 200))}`);
	const started = npmCalls().slice(before);
	if (started.length) problems.push(`npm was started ${started.length} time(s): ${started.join(" | ")}`);
	const appeared = packageFolders.filter((folder) => fs.existsSync(folder));
	if (appeared.length) problems.push(`package folders appeared: ${appeared.join(", ")}`);
	results.push({ site: name, problems });
}

// The settings a room reads follow the files: a setting written after the
// session opened is read again on reload, `packages` stays out, and a file
// that no longer parses keeps the last read.
{
	const problems: string[] = [];
	const { roomLoaderSettings } = await import("../src/room-loader-settings.js");
	const globalFile = path.join(agentDir, "settings.json");
	const before = fs.readFileSync(globalFile, "utf8");
	const settings = roomLoaderSettings(workspaceRoot, agentDir);
	fs.writeFileSync(globalFile, JSON.stringify({ ...JSON.parse(before), defaultThinkingLevel: "high" }, null, 2));
	await settings.reload();
	const read = settings.getGlobalSettings() as Record<string, unknown>;
	if (read.defaultThinkingLevel !== "high") problems.push(`a setting written after the session opened was not read on reload: ${JSON.stringify(read)}`);
	if ("packages" in read || "packages" in (settings.getProjectSettings() as Record<string, unknown>)) problems.push("packages came back on reload");
	// A settings.json that no longer parses keeps what was last read, and the
	// error is kept, as the runtime's own file storage does.
	settings.drainErrors();
	fs.writeFileSync(globalFile, "{ not json");
	await settings.reload();
	const kept = settings.getGlobalSettings() as Record<string, unknown>;
	if (kept.defaultThinkingLevel !== "high") problems.push(`a settings.json that does not parse replaced what was last read: ${JSON.stringify(kept)}`);
	if (!settings.drainErrors().some((entry) => entry.scope === "global")) problems.push("a settings.json that does not parse left no error");
	fs.writeFileSync(globalFile, before);
	results.push({ site: "settings reload", problems });
}

let server: ChildProcessWithoutNullStreams | undefined;
const serverOutput: string[] = [];
let startupNpmCalls = 0;
try {
	await new Promise<void>((resolve) => gateway.listen(0, "127.0.0.1", resolve));
	const gatewayPort = (gateway.address() as AddressInfo).port;
	fs.writeFileSync(path.join(agentDir, "models.json"), JSON.stringify({ providers: { "openai-compatible": { name: "Synthetic Gateway", baseUrl: `http://127.0.0.1:${gatewayPort}/v1`, api: "openai-completions", models: [{ id: MODEL.model, name: "Room Model", contextWindow: 128000, maxTokens: 16384 }] } } }, null, 2), { mode: 0o600 });
	fs.writeFileSync(path.join(agentDir, "auth.json"), JSON.stringify({ "openai-compatible": { type: "api_key", key: "synthetic-room-packages" } }, null, 2), { mode: 0o600 });
	fs.writeFileSync(path.join(appRoot, "openai-compatible-ai-profile.json"), JSON.stringify({ profileId: "openai-compatible", providerId: "openai-compatible", label: "Synthetic Gateway", roomModels: [{ modelId: MODEL.model, label: "Room Model" }], maintenanceModel: MODEL.model }, null, 2), { mode: 0o600 });
	fs.writeFileSync(path.join(appRoot, "persistent-agent-ai-profile.json"), JSON.stringify({ profileId: "openai-compatible" }, null, 2), { mode: 0o600 });

	// One room whose workspace is the folder with the project settings: the
	// live room and a scheduled run both take that folder as their cwd.
	const { createPersistentAgentFromScaffoldInput } = await import("../src/persistent-agents.js");
	const { createPersistentRoomDefaultCapabilityPolicy, writePersistentRoomDefaultCapabilityPolicy } = await import("../src/persistent-room-workspace-policy.js");
	const room = createPersistentAgentFromScaffoldInput({ displayName: "Packages Room", userName: "Synthetic User", preferredUserAddress: "Synthetic User" }).agent.id;
	writePersistentRoomDefaultCapabilityPolicy(createPersistentRoomDefaultCapabilityPolicy({ agentId: room, repoRoot, root: workspaceRoot, workspaceAccessMode: "bounded", displayLabel: "Packages Workspace", source: "manual" }), { persistentAgentsRoot: agentsRoot });

	const { AuthStorage, ModelRegistry } = await import("@exxeta/exxperts-runtime");
	const registry = () => ModelRegistry.create(AuthStorage.create(path.join(agentDir, "auth.json")), path.join(agentDir, "models.json"));
	const findModel = (workerRegistry: any, lock: { provider: string; model: string }) => {
		const found = workerRegistry.find(lock.provider, lock.model);
		assert(found, `the synthetic model ${lock.model} is in the registry`);
		return found;
	};

	// --- 1. The live room, over the socket of a real server.
	await site("live room (room-socket)", async () => {
		const port = await freePort();
		const baseUrl = `http://127.0.0.1:${port}`;
		server = spawn("npx", ["tsx", "src/index.ts"], {
			shell: process.platform === "win32",
			...SMOKE_SERVER_SPAWN_TREE_OPTIONS,
			cwd: webServerDir,
			env: smokeHomeEnv(home, { PORT: String(port), ...SMOKE_SERVER_AUTH_ENV, EXXETA_HOME: repoRoot, EXXPERTS_CODING_AGENT_DIR: agentDir, EXXETA_PERSISTENT_AGENTS_ROOT: agentsRoot }) as NodeJS.ProcessEnv,
		});
		server.stdout.on("data", (chunk) => serverOutput.push(String(chunk)));
		server.stderr.on("data", (chunk) => serverOutput.push(String(chunk)));
		await waitUntil(() => server?.exitCode == null ? fetch(`${baseUrl}/healthz`).then((r) => r.ok).catch(() => false) : Promise.reject(new Error(`the server exited with code ${server?.exitCode}`)), "the server is up");
		// npm started while the server came up is not a room's doing: counted apart.
		startupNpmCalls = npmCalls().length;
		const json = async (pathname: string, init: AuthedFetchInit = {}): Promise<{ status: number; body: any }> => {
			const response = await authedFetch(`${baseUrl}${pathname}`, { ...init, headers: { ...(init.body ? { "content-type": "application/json" } : {}), ...init.headers } });
			const text = await response.text();
			return { status: response.status, body: text ? JSON.parse(text) : null };
		};
		const conversationId = "conv-room-packages";
		const seeded = await json(`/api/persistent-agents/${encodeURIComponent(room)}/threads/${conversationId}`, { method: "PUT", body: JSON.stringify({ state: "active", origin: "launcher", model: MODEL, items: [] }) });
		assert(seeded.status === 200, `the thread was seeded, got ${seeded.status}`);
		const WebSocketImpl: any = (await import("ws")).default;
		const socket = new WebSocketImpl(`ws://127.0.0.1:${port}/ws?persistentAgentId=${room}&conversationId=${conversationId}&modelProvider=${MODEL.provider}&model=${MODEL.model}&reattach=1`, { headers: { ...SMOKE_AUTH_HEADERS } });
		const frames: string[] = [];
		let closed = false;
		socket.addEventListener("message", (event: { data: unknown }) => { frames.push(String(event.data)); });
		socket.addEventListener("close", () => { closed = true; });
		const isError = (frame: string) => { try { return JSON.parse(frame)?.type === "error"; } catch { return false; } };
		const isReady = (frame: string) => { try { return JSON.parse(frame)?.type === "ready"; } catch { return false; } };
		try {
			await waitUntil(() => closed || frames.some((frame) => isReady(frame) || isError(frame)), "the room is ready");
			assert(frames.some(isReady), `the room opened, got ${frames.join(" ").slice(0, 400)}${closed ? " (closed)" : ""}`);
			socket.send(JSON.stringify({ type: "prompt", text: "Say something." }));
			await waitUntil(() => closed || frames.some((frame) => frame.includes(ANSWER) || isError(frame)), "the room answered");
			return frames.filter((frame) => frame.includes(ANSWER) || isError(frame)).join(" ");
		} finally {
			try { socket.close(); } catch {}
			await stopSmokeServer(server);
			server = undefined;
		}
	});

	// --- 2. A scheduled run in the same room, in this process.
	await site("scheduled run (persistent-room-background-execution)", async () => {
		const background = await import("../src/persistent-room-background-execution.js");
		const result = await background.executePersistentRoomBackgroundPrompt({
			roomId: room,
			target: { kind: "fresh-thread", model: MODEL },
			prompt: "Say something.",
			executionId: "room-packages-scheduled",
			cwd: workspaceRoot,
			agentDir,
			modelRegistry: registry(),
		} as any);
		return result.assistantText;
	});

	// --- 3. A specialist task. The server runs it from the install folder;
	// here it runs from the folder with the project settings.
	await site("specialist task (persistent-room-specialist-execution)", async () => {
		const execution = await import("../src/persistent-room-specialist-execution.js");
		const plan = execution.buildSpecialistSessionPlan({ taskId: "tsk-room-packages", templateId: "document-html", brief: "Write the one-pager." });
		const result = await execution.runSpecialistWorker({ plan, modelLock: MODEL, resolveExpectedModel: findModel, modelRegistry: registry(), cwd: workspaceRoot, agentDir });
		return result.text;
	});

	// --- 4. A maintenance worker (Remember runs it from the room's cwd).
	await site("maintenance worker (persistent-agent-worker-runtime)", async () => {
		const { runIsolatedPersistentAgentWorker } = await import("../src/persistent-agent-worker-runtime.js");
		const result = await runIsolatedPersistentAgentWorker({
			workerSystemPrompt: "Synthetic maintenance worker prompt.",
			triggerPrompt: "Produce the draft now.",
			modelLock: MODEL,
			resolveExpectedModel: findModel,
			workerLabel: "maintenance worker",
			emptyTextError: "maintenance worker produced no text",
			cwd: workspaceRoot,
			agentDir,
			modelRegistry: registry(),
		});
		return result.text;
	});
} catch (error) {
	results.push({ site: "setup", problems: [(error as Error).message] });
} finally {
	try { (gateway as any).closeAllConnections?.(); } catch {}
	try { gateway.close(); } catch {}
	await stopSmokeServer(server);
}

if (startupNpmCalls) console.log(`  note: npm was started ${startupNpmCalls} time(s) while the server came up: ${npmCalls().slice(0, startupNpmCalls).join(" | ")}`);
for (const { site: name, problems } of results) console.log(problems.length ? `  FAIL  ${name}: ${problems.join("; ")}` : `  ok    ${name}: ${name === "settings reload" ? "read from disk, no packages" : "answered, no npm, no package folder"}`);
const failed = results.some((result) => result.problems.length > 0);
if (failed) {
	console.error(serverOutput.join("").slice(-3000));
	console.error("room-packages-ignored smoke: FAIL");
} else {
	console.log("room-packages-ignored smoke: PASS");
}
fs.rmSync(tempRoot, { recursive: true, force: true });
process.exit(failed ? 1 : 0);
