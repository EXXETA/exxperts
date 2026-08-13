// Per-room MCP grants API smoke, against a really spawned web server:
//
//  1. boot migration - a legacy room seeded WITHOUT a grants file receives the
//     full current connector list at startup, and the one-time marker lands;
//  2. scaffold default - a room created through the API starts with an
//     explicit EMPTY grant list;
//  3. the GET/PUT /api/persistent-agents/:id/mcp-connectors round trip -
//     grant validates against the live configured list (unknown connector is
//     a 400), revoke stays permissive;
//  4. revoke-on-delete - DELETE /api/mcp/servers/:name revokes the connector
//     from every room that held it and names those rooms in its response.
//
// Offline: connectors are URL entries nobody ever connects to.
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { authedFetch, type AuthedFetchInit, SMOKE_SERVER_AUTH_ENV, SMOKE_SERVER_SPAWN_TREE_OPTIONS, stopSmokeServer } from "./smoke-server-process.js";

const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), "exxperts-mcp-grants-home-"));
const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const webServerDir = path.resolve(scriptDir, "..");
const repoRoot = path.resolve(webServerDir, "..", "..");
const port = 24000 + Math.floor(Math.random() * 10000);
const baseUrl = `http://127.0.0.1:${port}`;
const agentDir = path.join(tempHome, ".exxperts", "agent");
const productAppRoot = path.join(tempHome, ".exxperts", "app");
const agentsRoot = path.join(productAppRoot, "personalized-agents");

function assert(condition: unknown, message: string): asserts condition {
	if (!condition) throw new Error(message);
}

function smokeEnv(): NodeJS.ProcessEnv {
	const env: NodeJS.ProcessEnv = { ...process.env };
	for (const key of ["ANTHROPIC_API_KEY", "ANTHROPIC_OAUTH_TOKEN", "OPENAI_API_KEY", "AZURE_OPENAI_API_KEY", "EXXETA_AI_API_KEY", "COPILOT_GITHUB_TOKEN", "GH_TOKEN", "GITHUB_TOKEN", "GEMINI_API_KEY", "GOOGLE_CLOUD_API_KEY", "OPENROUTER_API_KEY"]) {
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

async function waitForServer(server: ChildProcessWithoutNullStreams): Promise<void> {
	const deadline = Date.now() + 30_000;
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

function putGrant(roomId: string, action: "grant" | "revoke", name: string): Promise<{ status: number; body: any }> {
	return requestJson(`/api/persistent-agents/${roomId}/mcp-connectors`, {
		method: "PUT",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ action, name }),
	});
}

let server: ChildProcessWithoutNullStreams | null = null;
const serverOutput: string[] = [];

try {
	// Seed the world BEFORE boot: a configured connector and a legacy room
	// (agent.json, no grants file) that must be migrated on startup.
	fs.mkdirSync(agentDir, { recursive: true, mode: 0o700 });
	fs.mkdirSync(productAppRoot, { recursive: true, mode: 0o700 });
	fs.writeFileSync(path.join(agentDir, "mcp.json"), JSON.stringify({ mcpServers: { "legacy-connector": { url: "http://127.0.0.1:9/mcp" } } }, null, 2));
	const legacyRoomId = "legacy-mcp-room";
	fs.mkdirSync(path.join(agentsRoot, legacyRoomId), { recursive: true, mode: 0o700 });
	fs.writeFileSync(path.join(agentsRoot, legacyRoomId, "agent.json"), JSON.stringify({ agentId: legacyRoomId }), { mode: 0o600 });
	// Minimal AI profile so room creation works (no turn ever runs).
	fs.writeFileSync(path.join(agentDir, "models.json"), JSON.stringify({
		providers: { "openai-compatible": { name: "Dead Gateway", baseUrl: "http://127.0.0.1:9/v1", api: "openai-completions", models: [{ id: "room-model", name: "Room Model", contextWindow: 128000, maxTokens: 16384 }] } },
	}, null, 2), { mode: 0o600 });
	fs.writeFileSync(path.join(agentDir, "auth.json"), JSON.stringify({ "openai-compatible": { type: "api_key", key: "synthetic-mcp-grants-key" } }, null, 2), { mode: 0o600 });
	fs.writeFileSync(path.join(productAppRoot, "openai-compatible-ai-profile.json"), JSON.stringify({
		profileId: "openai-compatible",
		providerId: "openai-compatible",
		label: "Dead Gateway",
		roomModels: [{ modelId: "room-model", label: "Room Model" }],
		maintenanceModel: "room-model",
	}, null, 2), { mode: 0o600 });
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

	// 1. Boot migration: the legacy room got the FULL current connector list.
	const legacySettingsPath = path.join(agentsRoot, legacyRoomId, "runtime", "mcp-settings.json");
	assert(fs.existsSync(legacySettingsPath), "boot migration must write a grants file into the legacy room");
	const legacySettings = JSON.parse(fs.readFileSync(legacySettingsPath, "utf-8"));
	assert(Array.isArray(legacySettings.grantedConnectors) && legacySettings.grantedConnectors.join(",") === "legacy-connector", `the legacy room must hold the full connector list, got ${JSON.stringify(legacySettings.grantedConnectors)}`);
	assert(fs.existsSync(path.join(agentsRoot, ".mcp-grants-migration.json")), "boot migration must write its one-time marker");

	// 2. Scaffold default: a NEW room starts with an explicit empty list.
	const created = await requestJson("/api/persistent-agents", {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ displayName: "Grants Smoke Room", userName: "Synthetic User", preferredUserAddress: "Synthetic User" }),
	});
	assert(created.status === 201, `room creation should return 201, got ${created.status}: ${JSON.stringify(created.body)}`);
	const roomId = String(created.body?.agent?.id ?? "");
	assert(roomId, "room creation should return an agent id");
	const newSettingsPath = path.join(agentsRoot, roomId, "runtime", "mcp-settings.json");
	assert(fs.existsSync(newSettingsPath), "the scaffold must write an explicit grants file");
	assert(JSON.parse(fs.readFileSync(newSettingsPath, "utf-8")).grantedConnectors.length === 0, "a new room must start with an empty grant list");

	// 3. GET/PUT round trip.
	const fresh = await requestJson(`/api/persistent-agents/${roomId}/mcp-connectors`);
	assert(fresh.status === 200, `GET mcp-connectors should return 200, got ${fresh.status}: ${JSON.stringify(fresh.body)}`);
	assert(fresh.body.settings.grantedConnectors.length === 0, "a new room's grants must read empty");
	assert(fresh.body.configuredConnectors.join(",") === "legacy-connector", `the configured list should carry the seeded connector, got ${JSON.stringify(fresh.body.configuredConnectors)}`);
	const grantedNew = await putGrant(roomId, "grant", "legacy-connector");
	assert(grantedNew.status === 200 && grantedNew.body.granted.length === 1 && grantedNew.body.granted[0].name === "legacy-connector" && grantedNew.body.granted[0].configured === true, `granting a configured connector should succeed, got ${JSON.stringify(grantedNew.body)}`);
	const grantedGhost = await putGrant(roomId, "grant", "ghost-connector");
	assert(grantedGhost.status === 400 && /unknown connector/.test(String(grantedGhost.body?.error ?? "")), `granting an unconfigured connector must 400, got ${grantedGhost.status}: ${JSON.stringify(grantedGhost.body)}`);
	const badAction = await putGrant(roomId, "detach" as unknown as "grant", "legacy-connector");
	assert(badAction.status === 400, "an unknown action must 400");

	// 4. Revoke-on-delete: deleting the connector sweeps every room's grant.
	const deleted = await requestJson("/api/mcp/servers/legacy-connector", { method: "DELETE" });
	assert(deleted.status === 200, `connector delete should return 200, got ${deleted.status}: ${JSON.stringify(deleted.body)}`);
	const revokedFromRooms: string[] = Array.isArray(deleted.body?.revokedFromRooms) ? deleted.body.revokedFromRooms : [];
	assert(revokedFromRooms.includes(roomId) && revokedFromRooms.includes(legacyRoomId), `the delete must name every room it revoked from, got ${JSON.stringify(revokedFromRooms)}`);
	const afterDelete = await requestJson(`/api/persistent-agents/${roomId}/mcp-connectors`);
	assert(afterDelete.body.settings.grantedConnectors.length === 0, "the deleted connector's grant must be gone from the room");
	assert(afterDelete.body.configuredConnectors.length === 0, "the deleted connector must be gone from the configured list");
	assert(JSON.parse(fs.readFileSync(legacySettingsPath, "utf-8")).grantedConnectors.length === 0, "the legacy room's grant must be gone too");

	console.log("persistent-room-mcp-grants-api-smoke: OK");
} catch (error) {
	console.error(error instanceof Error ? error.stack || error.message : error);
	console.error(`temp home preserved for inspection: ${tempHome}`);
	console.error(serverOutput.slice(-40).join(""));
	process.exitCode = 1;
} finally {
	await stopSmokeServer(server);
	if (process.exitCode !== 1) fs.rmSync(tempHome, { recursive: true, force: true });
}
