// A standby save for an older conversation, sent through the thread route,
// must leave the room on the newer one; an active save still switches.
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { authedFetch, freePort, type AuthedFetchInit, SMOKE_SERVER_AUTH_ENV, SMOKE_SERVER_SPAWN_TREE_OPTIONS, stopSmokeServer } from "./smoke-server-process.js";

const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), "exxperts-standby-route-home-"));
const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const webServerDir = path.resolve(scriptDir, "..");
const repoRoot = path.resolve(webServerDir, "..", "..");
const port = await freePort();
const baseUrl = `http://127.0.0.1:${port}`;
const agentDir = path.join(tempHome, ".exxperts", "agent");
const productAppRoot = path.join(tempHome, ".exxperts", "app");

function assert(condition: unknown, message: string): asserts condition {
	if (!condition) throw new Error(message);
}

async function requestJson(pathname: string, init: AuthedFetchInit = {}): Promise<{ status: number; body: any }> {
	const response = await authedFetch(`${baseUrl}${pathname}`, {
		...init,
		headers: { ...(init.body ? { "content-type": "application/json" } : {}), ...init.headers },
	});
	const text = await response.text();
	return { status: response.status, body: text ? JSON.parse(text) : null };
}

const MODEL = { provider: "openai-compatible", model: "room-model" };
const item = (id: string, text: string) => ({ id, role: "user", content: text, createdAt: new Date().toISOString() });

let server: ChildProcessWithoutNullStreams | null = null;
const serverOutput: string[] = [];
try {
	fs.mkdirSync(agentDir, { recursive: true, mode: 0o700 });
	fs.mkdirSync(productAppRoot, { recursive: true, mode: 0o700 });
	fs.writeFileSync(path.join(agentDir, "models.json"), JSON.stringify({
		providers: {
			"openai-compatible": {
				name: "Synthetic Gateway",
				baseUrl: "http://127.0.0.1:9/v1",
				api: "openai-completions",
				models: [{ id: "room-model", name: "Room Model", contextWindow: 128000, maxTokens: 16384 }],
			},
		},
	}, null, 2), { mode: 0o600 });
	fs.writeFileSync(path.join(agentDir, "auth.json"), JSON.stringify({ "openai-compatible": { type: "api_key", key: "synthetic-standby-route-key" } }, null, 2), { mode: 0o600 });
	fs.writeFileSync(path.join(productAppRoot, "openai-compatible-ai-profile.json"), JSON.stringify({
		profileId: "openai-compatible",
		providerId: "openai-compatible",
		label: "Synthetic Gateway",
		roomModels: [{ modelId: "room-model", label: "Room Model" }],
		maintenanceModel: "room-model",
	}, null, 2), { mode: 0o600 });
	fs.writeFileSync(path.join(productAppRoot, "persistent-agent-ai-profile.json"), JSON.stringify({ profileId: "openai-compatible" }, null, 2), { mode: 0o600 });

	const env: NodeJS.ProcessEnv = { ...process.env };
	for (const key of ["ANTHROPIC_API_KEY", "ANTHROPIC_OAUTH_TOKEN", "OPENAI_API_KEY", "AZURE_OPENAI_API_KEY", "EXXETA_AI_API_KEY", "COPILOT_GITHUB_TOKEN", "GH_TOKEN", "GITHUB_TOKEN", "GEMINI_API_KEY", "GOOGLE_CLOUD_API_KEY", "OPENROUTER_API_KEY"]) {
		delete env[key];
	}
	Object.assign(env, SMOKE_SERVER_AUTH_ENV);
	env.HOME = tempHome;
	env.USERPROFILE = tempHome;
	env.PORT = String(port);
	env.EXXETA_HOME = repoRoot;
	env.EXXPERTS_CODING_AGENT_DIR = agentDir;
	server = spawn("npx", ["tsx", "src/index.ts"], {
		shell: process.platform === "win32",
		...SMOKE_SERVER_SPAWN_TREE_OPTIONS,
		cwd: webServerDir,
		env,
	});
	server.stdout.on("data", (chunk) => serverOutput.push(String(chunk)));
	server.stderr.on("data", (chunk) => serverOutput.push(String(chunk)));
	const deadline = Date.now() + 60_000;
	for (;;) {
		if (server.exitCode != null) throw new Error(`server exited before startup with code ${server.exitCode}`);
		try {
			if ((await fetch(`${baseUrl}/healthz`)).ok) break;
		} catch {}
		if (Date.now() > deadline) throw new Error("server did not become ready");
		await new Promise((resolve) => setTimeout(resolve, 150));
	}

	const created = await requestJson("/api/persistent-agents", {
		method: "POST",
		body: JSON.stringify({ displayName: "Standby Route Room", userName: "Synthetic User", preferredUserAddress: "Synthetic User" }),
	});
	assert(created.status === 201, `room creation should return 201, got ${created.status}: ${JSON.stringify(created.body)}`);
	const roomId = encodeURIComponent(String(created.body?.agent?.id ?? ""));
	const save = (threadId: string, body: Record<string, unknown>) => requestJson(`/api/persistent-agents/${roomId}/threads/${threadId}`, { method: "PUT", body: JSON.stringify({ origin: "launcher", model: MODEL, ...body }) });
	const pointer = async (): Promise<string> => {
		const runtime = await requestJson(`/api/persistent-agents/${roomId}/runtime`);
		assert(runtime.status === 200, `the room's runtime should return 200, got ${runtime.status}`);
		return String(runtime.body?.runtime?.activeThreadId ?? "");
	};

	const older = await save("c_route_a", { state: "active", items: [item("a1", "older conversation")] });
	assert(older.status === 200, `the first save should return 200, got ${older.status}: ${JSON.stringify(older.body).slice(0, 300)}`);
	const newer = await save("c_route_b", { state: "active", items: [item("b1", "newer conversation")] });
	assert(newer.status === 200, `the second save should return 200, got ${newer.status}`);
	assert(await pointer() === "c_route_b", `an active save moves the room to the newer conversation, got ${await pointer()}`);

	const parked = await save("c_route_a", { state: "standby", items: [item("a1", "older conversation"), item("a2", "a late save")] });
	assert(parked.status === 200, `the standby save should return 200, got ${parked.status}: ${JSON.stringify(parked.body).slice(0, 300)}`);
	assert(await pointer() === "c_route_b", `a standby save for the older conversation must leave the room on the newer one, got ${await pointer()}`);
	const olderThread = await requestJson(`/api/persistent-agents/${roomId}/threads/c_route_a`);
	assert(JSON.stringify(olderThread.body ?? "").includes("a late save"), `the standby save must still store the older conversation's items, got ${JSON.stringify(olderThread.body).slice(0, 300)}`);

	const switched = await save("c_route_a", { state: "active", items: [item("a1", "older conversation"), item("a2", "a late save")] });
	assert(switched.status === 200 && await pointer() === "c_route_a", "an active save for the older conversation switches the room back to it");

	console.log("persistent-agent-thread-standby-route-smoke ok");
} catch (error) {
	console.error(`persistent-agent-thread-standby-route-smoke FAILED: ${(error as Error).message}`);
	if (serverOutput.length > 0) console.error(serverOutput.join("").slice(-3000));
	process.exitCode = 1;
} finally {
	if (server) await stopSmokeServer(server);
	try { fs.rmSync(tempHome, { recursive: true, force: true }); } catch {}
}
