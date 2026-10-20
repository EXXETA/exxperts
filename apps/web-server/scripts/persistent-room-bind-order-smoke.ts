// In a room's live bind, bash approval runs after the permissions extension,
// and the blocked-tool check reads the tools after bindExtensions.
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import fs from "node:fs";
import type { AddressInfo } from "node:net";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { authedFetch, freePort, type AuthedFetchInit, SMOKE_AUTH_HEADERS, SMOKE_SERVER_AUTH_ENV, SMOKE_SERVER_SPAWN_TREE_OPTIONS, stopSmokeServer } from "./smoke-server-process.js";

const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), "exxperts-room-bind-order-home-"));
const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const webServerDir = path.resolve(scriptDir, "..");
const repoRoot = path.resolve(webServerDir, "..", "..");
const agentDir = path.join(tempHome, ".exxperts", "agent");
const productAppRoot = path.join(tempHome, ".exxperts", "app");
const recordFile = path.join(tempHome, "bind-record.jsonl");
const preloadUrl = pathToFileURL(path.join(scriptDir, "room-bind-probe-preload.mjs")).href;
const LEAK_TOOL = "memory_write";

function assert(condition: unknown, message: string): asserts condition {
	if (!condition) throw new Error(message);
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

// The gateway is never asked anything: no turn runs.
const gateway = http.createServer((_req, res) => {
	res.writeHead(500);
	res.end();
});

type Frame = Record<string, any>;
const WebSocketImpl: any = (await import("ws")).default;

type Server = { child: ChildProcessWithoutNullStreams; output: string[]; port: number };

async function startServer(probeEnv: Record<string, string>): Promise<Server> {
	const port = await freePort();
	const env: NodeJS.ProcessEnv = { ...process.env };
	for (const key of ["ANTHROPIC_API_KEY", "ANTHROPIC_OAUTH_TOKEN", "OPENAI_API_KEY", "AZURE_OPENAI_API_KEY", "EXXETA_AI_API_KEY", "COPILOT_GITHUB_TOKEN", "GH_TOKEN", "GITHUB_TOKEN", "GEMINI_API_KEY", "GOOGLE_CLOUD_API_KEY", "OPENROUTER_API_KEY"]) {
		delete env[key];
	}
	Object.assign(env, SMOKE_SERVER_AUTH_ENV, probeEnv);
	env.HOME = tempHome;
	env.USERPROFILE = tempHome;
	env.PORT = String(port);
	env.EXXETA_HOME = repoRoot;
	env.EXXPERTS_CODING_AGENT_DIR = agentDir;
	env.NODE_OPTIONS = `${env.NODE_OPTIONS ? `${env.NODE_OPTIONS} ` : ""}--import ${preloadUrl}`;
	const child = spawn("npx", ["tsx", "src/index.ts"], {
		shell: process.platform === "win32",
		...SMOKE_SERVER_SPAWN_TREE_OPTIONS,
		cwd: webServerDir,
		env,
	});
	const output: string[] = [];
	child.stdout.on("data", (chunk) => output.push(String(chunk)));
	child.stderr.on("data", (chunk) => output.push(String(chunk)));
	const deadline = Date.now() + 60_000;
	let lastError = "not started";
	while (Date.now() < deadline) {
		if (child.exitCode != null) throw new Error(`server exited before startup with code ${child.exitCode}: ${output.join("").slice(-2000)}`);
		try {
			const response = await fetch(`http://127.0.0.1:${port}/healthz`);
			if (response.ok) return { child, output, port };
			lastError = `healthz returned ${response.status}`;
		} catch (error) {
			lastError = (error as Error).message;
		}
		await sleep(150);
	}
	throw new Error(`server did not become ready: ${lastError}`);
}

async function requestJson(server: Server, pathname: string, init: AuthedFetchInit = {}): Promise<{ status: number; body: any }> {
	const response = await authedFetch(`http://127.0.0.1:${server.port}${pathname}`, {
		...init,
		headers: { ...(init.body ? { "content-type": "application/json" } : {}), ...init.headers },
	});
	const text = await response.text();
	return { status: response.status, body: text ? JSON.parse(text) : null };
}

/** Opens a room conversation and returns its frames once the bind has settled one way or the other. */
async function connectRoom(server: Server, roomId: string, conversationId: string): Promise<Frame[]> {
	const frames: Frame[] = [];
	const socket = new WebSocketImpl(`ws://127.0.0.1:${server.port}/ws?persistentAgentId=${roomId}&conversationId=${conversationId}&modelProvider=openai-compatible&model=room-model&reattach=1`, { headers: { ...SMOKE_AUTH_HEADERS } });
	socket.addEventListener("message", (event: { data: unknown }) => {
		try { frames.push(JSON.parse(String(event.data))); } catch {}
	});
	let closed = false;
	socket.addEventListener("close", () => { closed = true; });
	await new Promise<void>((resolve, reject) => {
		socket.addEventListener("open", () => resolve());
		socket.addEventListener("error", () => reject(new Error("websocket failed to connect")));
	});
	const deadline = Date.now() + 30_000;
	while (Date.now() < deadline && !closed && !frames.some((frame) => frame.type === "ready" || frame.type === "error")) await sleep(25);
	try { socket.close(); } catch {}
	return frames;
}

async function createRoom(server: Server, name: string): Promise<{ roomId: string; conversationId: string }> {
	const created = await requestJson(server, "/api/persistent-agents", {
		method: "POST",
		body: JSON.stringify({ displayName: name, userName: "Synthetic User", preferredUserAddress: "Synthetic User" }),
	});
	assert(created.status === 201, `room creation should return 201, got ${created.status}: ${JSON.stringify(created.body)}`);
	const roomId = String(created.body?.agent?.id ?? "");
	const conversationId = `bindorder_${Date.now().toString(36)}`;
	const seeded = await requestJson(server, `/api/persistent-agents/${encodeURIComponent(roomId)}/threads/${encodeURIComponent(conversationId)}`, {
		method: "PUT",
		body: JSON.stringify({ state: "active", origin: "launcher", model: { provider: "openai-compatible", model: "room-model" }, items: [] }),
	});
	assert(seeded.status === 200, `thread seed should return 200, got ${seeded.status}: ${JSON.stringify(seeded.body).slice(0, 300)}`);
	return { roomId, conversationId };
}

let server: Server | null = null;
try {
	await new Promise<void>((resolve) => gateway.listen(0, "127.0.0.1", resolve));
	const gatewayPort = (gateway.address() as AddressInfo).port;
	fs.mkdirSync(agentDir, { recursive: true, mode: 0o700 });
	fs.mkdirSync(productAppRoot, { recursive: true, mode: 0o700 });
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
	fs.writeFileSync(path.join(agentDir, "auth.json"), JSON.stringify({ "openai-compatible": { type: "api_key", key: "synthetic-bind-order-key" } }, null, 2), { mode: 0o600 });
	fs.writeFileSync(path.join(productAppRoot, "openai-compatible-ai-profile.json"), JSON.stringify({
		profileId: "openai-compatible",
		providerId: "openai-compatible",
		label: "Synthetic Gateway",
		roomModels: [{ modelId: "room-model", label: "Room Model" }],
		maintenanceModel: "room-model",
	}, null, 2), { mode: 0o600 });
	fs.writeFileSync(path.join(productAppRoot, "persistent-agent-ai-profile.json"), JSON.stringify({ profileId: "openai-compatible" }, null, 2), { mode: 0o600 });

	// 1. The live extension order.
	server = await startServer({ ROOM_BIND_PROBE_RECORD: recordFile });
	{
		const { roomId, conversationId } = await createRoom(server, "Bind Order Room");
		const frames = await connectRoom(server, roomId, conversationId);
		assert(frames.some((frame) => frame.type === "ready"), `the room should bind, got frames: ${JSON.stringify(frames).slice(0, 600)}`);
		const loads: string[][] = fs.existsSync(recordFile)
			? fs.readFileSync(recordFile, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line))
			: [];
		const roomLoad = loads.find((names) => names.includes("permissionsExtForSession"));
		assert(roomLoad, `the room's bind should load the permissions extension, recorded loads: ${JSON.stringify(loads)}`);
		const permissionsAt = roomLoad.indexOf("permissionsExtForSession");
		const approvalAt = roomLoad.indexOf("persistentRoomBashApproval");
		assert(approvalAt >= 0, `the room's bind should load the bash approval extension, got: ${JSON.stringify(roomLoad)}`);
		assert(permissionsAt < approvalAt, `the bash approval extension must come after the permissions extension, got: ${JSON.stringify(roomLoad)}`);
	}
	await stopSmokeServer(server.child);
	server = null;

	// 2. A blocked tool that turns up during the bind fails the bind.
	server = await startServer({ ROOM_BIND_PROBE_LEAK: LEAK_TOOL });
	{
		const { roomId, conversationId } = await createRoom(server, "Bind Leak Room");
		const frames = await connectRoom(server, roomId, conversationId);
		const leakReported = frames.some((frame) => frame.type === "error" && String(frame.message ?? "").includes(LEAK_TOOL))
			|| server.output.join("").includes(`blocked tool leaked into session: ${LEAK_TOOL}`);
		assert(leakReported, `a blocked tool that turns up during the bind must fail it; frames: ${JSON.stringify(frames).slice(0, 600)}`);
		assert(!frames.some((frame) => frame.type === "ready"), `a bind with a leaked tool must not report ready; frames: ${JSON.stringify(frames).slice(0, 600)}`);
	}

	console.log("persistent-room-bind-order-smoke ok");
} catch (error) {
	console.error(`persistent-room-bind-order-smoke FAILED: ${(error as Error).message}`);
	if (server && server.output.length > 0) console.error(server.output.join("").slice(-4000));
	process.exitCode = 1;
} finally {
	if (server) await stopSmokeServer(server.child);
	try { (gateway as any).closeAllConnections?.(); } catch {}
	await new Promise<void>((resolve) => gateway.close(() => resolve()));
	try { fs.rmSync(tempHome, { recursive: true, force: true }); } catch {}
}
