import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { SMOKE_SERVER_SPAWN_TREE_OPTIONS, stopSmokeServer } from "./smoke-server-process.js";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), "exxperts-openai-compatible-gateway-home-"));
const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const webServerDir = path.resolve(scriptDir, "..");
const repoRoot = path.resolve(webServerDir, "..", "..");
const port = 24000 + Math.floor(Math.random() * 10000);
const baseUrl = `http://127.0.0.1:${port}`;
const agentDir = path.join(tempHome, ".exxperts", "agent");
const productAppRoot = path.join(tempHome, ".exxperts", "app");

const syntheticGatewayKey = "synthetic-openai-compatible-key-do-not-print";
const syntheticGatewayBaseUrl = "https://gateway.example.invalid/v1";

function assert(condition: unknown, message: string): asserts condition {
	if (!condition) throw new Error(message);
}

function normalizeForSearch(value: string): string {
	return value.replace(/\\/g, "/");
}

async function waitForServer(server: ChildProcessWithoutNullStreams): Promise<void> {
	const deadline = Date.now() + 15000;
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

async function requestJson(pathname: string, init?: RequestInit): Promise<{ status: number; body: any }> {
	const response = await fetch(`${baseUrl}${pathname}`, init);
	const text = await response.text();
	return { status: response.status, body: text ? JSON.parse(text) : null };
}

function assertStatusOk(response: { status: number; body: any }, label: string): void {
	assert(response.status === 200, `${label} should return 200, got ${response.status}: ${JSON.stringify(response.body)}`);
}

function assertNoLeak(value: unknown, label: string, blockedValues: string[]): void {
	const serialized = JSON.stringify(value);
	for (const blockedValue of blockedValues) {
		assert(!serialized.includes(blockedValue), `${label}: response must not leak ${blockedValue}`);
		const normalized = normalizeForSearch(blockedValue);
		if (normalized !== blockedValue) {
			assert(!serialized.includes(normalized), `${label}: response must not leak ${normalized}`);
		}
	}
}

function providerStatus(authStatus: any, providerId: string): any {
	return authStatus?.providers?.find((provider: any) => provider?.id === providerId);
}

function profileStatus(aiProfileStatus: any, profileId: string): any {
	return aiProfileStatus?.profiles?.find((profile: any) => profile?.id === profileId);
}

function roomModelKeys(roomModelStatus: any): string[] {
	return (roomModelStatus?.roomModels ?? []).map((model: any) => `${model?.provider}/${model?.model}`);
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
	env.EXXETA_HOME = repoRoot;
	env.EXXPERTS_CODING_AGENT_DIR = agentDir;
	return env;
}

let server: ChildProcessWithoutNullStreams | null = null;
const serverOutput: string[] = [];

try {
	fs.mkdirSync(agentDir, { recursive: true, mode: 0o700 });
	fs.mkdirSync(productAppRoot, { recursive: true, mode: 0o700 });
	fs.writeFileSync(
		path.join(agentDir, "models.json"),
		JSON.stringify(
			{
				providers: {
					"openai-compatible": {
						name: "OpenAI-compatible gateway",
						baseUrl: syntheticGatewayBaseUrl,
						api: "openai-completions",
						models: [
							{ id: "primary-model", name: "Primary Model" },
							{ id: "secondary-model", name: "Secondary Model" },
							{ id: "maintenance-model", name: "Maintenance Model" },
						],
					},
				},
			},
			null,
			2,
		),
		{ mode: 0o600 },
	);
	fs.writeFileSync(
		path.join(agentDir, "auth.json"),
		JSON.stringify(
			{
				"openai-compatible": {
					type: "api_key",
					key: syntheticGatewayKey,
				},
			},
			null,
			2,
		),
		{ mode: 0o600 },
	);
	fs.writeFileSync(
		path.join(productAppRoot, "openai-compatible-ai-profile.json"),
		JSON.stringify(
			{
				profileId: "openai-compatible",
				providerId: "openai-compatible",
				label: "OpenAI-compatible gateway",
				roomModels: [
					{ modelId: "primary-model", label: "Primary Model" },
					{ modelId: "secondary-model", label: "Secondary Model" },
				],
				maintenanceModel: "maintenance-model",
			},
			null,
			2,
		),
		{ mode: 0o600 },
	);

	server = spawn("npx", ["tsx", "src/index.ts"], {
		shell: process.platform === "win32",
		...SMOKE_SERVER_SPAWN_TREE_OPTIONS,
		cwd: webServerDir,
		env: smokeEnv(),
	});
	server.stdout.on("data", (chunk) => serverOutput.push(String(chunk)));
	server.stderr.on("data", (chunk) => serverOutput.push(String(chunk)));
	await waitForServer(server);

	const authStatus = await requestJson("/api/auth/status");
	const aiProfileStatus = await requestJson("/api/persistent-agent-ai-profile");

	assertStatusOk(authStatus, "auth status");
	assertStatusOk(aiProfileStatus, "AI profile status");
	assertNoLeak({ authStatus: authStatus.body, aiProfileStatus: aiProfileStatus.body }, "initial status", [
		tempHome,
		agentDir,
		productAppRoot,
		syntheticGatewayKey,
		syntheticGatewayBaseUrl,
	]);

	const gatewayAuth = providerStatus(authStatus.body, "openai-compatible");
	assert(gatewayAuth, `auth status should include openai-compatible, got ${JSON.stringify(authStatus.body?.providers)}`);
	assert(gatewayAuth.name === "OpenAI-compatible gateway", `gateway auth label should be friendly, got ${JSON.stringify(gatewayAuth)}`);
	assert(gatewayAuth.configured === true, `gateway auth should be configured, got ${JSON.stringify(gatewayAuth)}`);
	assert(gatewayAuth.source === "stored", `gateway auth source should be stored, got ${JSON.stringify(gatewayAuth)}`);
	assert(gatewayAuth.oauth === false, `gateway auth should be API-key based, got ${JSON.stringify(gatewayAuth)}`);

	const gatewayProfile = profileStatus(aiProfileStatus.body, "openai-compatible");
	assert(gatewayProfile, `AI profile status should include openai-compatible, got ${JSON.stringify(aiProfileStatus.body?.profiles)}`);
	assert(gatewayProfile.ready === true, `gateway profile should be ready, got ${JSON.stringify(gatewayProfile)}`);
	assert(gatewayProfile.provider?.id === "openai-compatible", `gateway provider id mismatch: ${JSON.stringify(gatewayProfile)}`);
	assert(gatewayProfile.provider?.configured === true, `gateway provider should be connected: ${JSON.stringify(gatewayProfile)}`);
	assert(gatewayProfile.processes?.persistentRoom?.models?.length === 2, `gateway should expose two room models, got ${JSON.stringify(gatewayProfile.processes?.persistentRoom)}`);
	assert(gatewayProfile.processes?.absorb?.model?.model === "maintenance-model", `absorb should use maintenance model, got ${JSON.stringify(gatewayProfile.processes?.absorb)}`);

	const selectProfile = await requestJson("/api/persistent-agent-ai-profile", {
		method: "PUT",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ profileId: "openai-compatible" }),
	});
	assertStatusOk(selectProfile, "select openai-compatible profile");
	assert(selectProfile.body?.activeProfileId === "openai-compatible", `active profile should switch to openai-compatible, got ${selectProfile.body?.activeProfileId}`);

	const roomModelStatus = await requestJson("/api/persistent-agent-room/model-status");
	assertStatusOk(roomModelStatus, "persistent-room model status");
	assert(roomModelStatus.body?.activeProfileId === "openai-compatible", `room status should use openai-compatible profile, got ${roomModelStatus.body?.activeProfileId}`);
	assert(
		JSON.stringify(roomModelKeys(roomModelStatus.body)) === JSON.stringify([
			"openai-compatible/primary-model",
			"openai-compatible/secondary-model",
		]),
		`room model options should match local policy only, got ${JSON.stringify(roomModelKeys(roomModelStatus.body))}`,
	);
	assert(!roomModelKeys(roomModelStatus.body).includes("openai-compatible/maintenance-model"), "maintenance model should not be a room picker option unless approved as a room model");

	const selectRoomModel = await requestJson("/api/persistent-agent-room/model-selection", {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ provider: "openai-compatible", model: "secondary-model" }),
	});
	assertStatusOk(selectRoomModel, "select openai-compatible room model");

	const rejectMaintenanceModel = await requestJson("/api/persistent-agent-room/model-selection", {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ provider: "openai-compatible", model: "maintenance-model" }),
	});
	assert(rejectMaintenanceModel.status === 400, `maintenance-only model should not be selectable for rooms, got ${rejectMaintenanceModel.status}: ${JSON.stringify(rejectMaintenanceModel.body)}`);

	assertNoLeak({ roomModelStatus: roomModelStatus.body, selectRoomModel: selectRoomModel.body, rejectMaintenanceModel: rejectMaintenanceModel.body }, "room model status", [
		tempHome,
		agentDir,
		productAppRoot,
		syntheticGatewayKey,
		syntheticGatewayBaseUrl,
	]);

	console.log("openai-compatible gateway smoke passed");
} catch (error) {
	const output = serverOutput.join("").trim();
	if (output) console.error(output.split("\n").slice(-80).join("\n"));
	console.error(error instanceof Error ? error.stack || error.message : error);
	console.error(`temp HOME preserved for inspection: ${tempHome}`);
	process.exitCode = 1;
} finally {
	await stopSmokeServer(server);
	if (process.exitCode == null || process.exitCode === 0) {
		fs.rmSync(tempHome, { recursive: true, force: true });
	}
}
