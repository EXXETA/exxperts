import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { authedFetch, SMOKE_SERVER_AUTH_ENV, SMOKE_SERVER_SPAWN_TREE_OPTIONS, stopSmokeServer } from "./smoke-server-process.js";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), "exxperts-provider-status-home-"));
const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const webServerDir = path.resolve(scriptDir, "..");
const repoRoot = path.resolve(webServerDir, "..", "..");
const port = 23000 + Math.floor(Math.random() * 10000);
const baseUrl = `http://127.0.0.1:${port}`;
const agentDir = path.join(tempHome, ".exxperts", "agent");
const productAppRoot = path.join(tempHome, ".exxperts", "app");

const syntheticEnvSecret = "synthetic-secret-do-not-print";
const syntheticOauthAccess = "synthetic-oauth-access-do-not-print";
const syntheticOauthRefresh = "synthetic-oauth-refresh-do-not-print";

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

async function requestJson(pathname: string): Promise<{ status: number; body: any }> {
	const response = await authedFetch(`${baseUrl}${pathname}`);
	const text = await response.text();
	return { status: response.status, body: text ? JSON.parse(text) : null };
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

function assertStatusOk(response: { status: number; body: any }, label: string): void {
	assert(response.status === 200, `${label} should return 200, got ${response.status}: ${JSON.stringify(response.body)}`);
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

function roomModelLabels(roomModelStatus: any): string[] {
	return (roomModelStatus?.roomModels ?? []).map((model: any) => String(model?.label ?? ""));
}

function compactModelLabel(label: string): string {
	return label.replace(/^.*—\s*/, "").trim() || label;
}

function compactRoomModelLabels(roomModelStatus: any): string[] {
	return roomModelLabels(roomModelStatus).map(compactModelLabel);
}

function smokeEnv(): NodeJS.ProcessEnv {
	const env: NodeJS.ProcessEnv = { ...process.env };
	const providerEnvNames = [
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
		"GOOGLE_APPLICATION_CREDENTIALS",
		"GOOGLE_CLOUD_PROJECT",
		"GCLOUD_PROJECT",
		"GOOGLE_CLOUD_LOCATION",
		"OPENROUTER_API_KEY",
		"AI_GATEWAY_API_KEY",
		"DEEPSEEK_API_KEY",
		"GROQ_API_KEY",
		"CEREBRAS_API_KEY",
		"XAI_API_KEY",
		"MISTRAL_API_KEY",
		"HF_TOKEN",
		"FIREWORKS_API_KEY",
		"TOGETHER_API_KEY",
	];
	for (const key of providerEnvNames) delete env[key];

	env.HOME = tempHome;
	env.USERPROFILE = tempHome;
	env.PORT = String(port);
	env.EXXPERTS_AUTH_TOKEN = SMOKE_SERVER_AUTH_ENV.EXXPERTS_AUTH_TOKEN;
	env.EXXETA_HOME = repoRoot;
	env.EXXPERTS_CODING_AGENT_DIR = agentDir;
	env.OPENAI_API_KEY = syntheticEnvSecret;
	return env;
}

let server: ChildProcessWithoutNullStreams | null = null;
const serverOutput: string[] = [];

try {
	fs.mkdirSync(agentDir, { recursive: true });
	fs.mkdirSync(productAppRoot, { recursive: true });
	fs.writeFileSync(
		path.join(agentDir, "auth.json"),
		JSON.stringify(
			{
				anthropic: {
					type: "oauth",
					access: syntheticOauthAccess,
					refresh: syntheticOauthRefresh,
					expires: Date.now() + 60_000,
				},
			},
			null,
			2,
		),
		"utf-8",
	);
	fs.writeFileSync(path.join(agentDir, "models.json"), "{ invalid synthetic models json", "utf-8");
	fs.writeFileSync(path.join(productAppRoot, "persistent-agent-ai-profile.json"), JSON.stringify({ profileId: "anthropic" }, null, 2), "utf-8");

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
	const roomModelStatus = await requestJson("/api/persistent-agent-room/model-status");

	assertStatusOk(authStatus, "auth status");
	assertStatusOk(aiProfileStatus, "AI profile status");
	assertStatusOk(roomModelStatus, "persistent-room model status");

	const responses = { authStatus: authStatus.body, aiProfileStatus: aiProfileStatus.body, roomModelStatus: roomModelStatus.body };
	assertNoLeak(responses, "status diagnostics", [
		tempHome,
		agentDir,
		productAppRoot,
		syntheticEnvSecret,
		syntheticOauthAccess,
		syntheticOauthRefresh,
	]);

	assert(authStatus.body?.authDir === "~/.exxperts/agent", `authDir should be redacted, got ${authStatus.body?.authDir}`);
	const openAiStatus = providerStatus(authStatus.body, "openai");
	assert(openAiStatus?.configured === true, `openai env auth should be configured, got ${JSON.stringify(openAiStatus)}`);
	assert(openAiStatus?.source === "environment", `openai auth source should be environment, got ${JSON.stringify(openAiStatus)}`);
	assert(openAiStatus?.label === "OPENAI_API_KEY", `openai auth label should be env var name, got ${JSON.stringify(openAiStatus)}`);

	const anthropicAuthStatus = providerStatus(authStatus.body, "anthropic");
	assert(anthropicAuthStatus?.configured === true, `anthropic synthetic OAuth should be configured, got ${JSON.stringify(anthropicAuthStatus)}`);
	assert(anthropicAuthStatus?.source === "stored", `anthropic auth source should be stored, got ${JSON.stringify(anthropicAuthStatus)}`);

	const anthropicProfile = profileStatus(aiProfileStatus.body, "anthropic");
	assert(anthropicProfile, `AI profile status should include anthropic, got ${JSON.stringify(aiProfileStatus.body?.profiles)}`);
	assert(anthropicProfile.label === "Claude", `anthropic profile label should be Claude, got ${JSON.stringify(anthropicProfile)}`);
	assert(anthropicProfile.provider?.id === "anthropic", `anthropic profile provider should be anthropic, got ${JSON.stringify(anthropicProfile)}`);
	assert(anthropicProfile.provider?.configured === true, `anthropic profile provider should be configured, got ${JSON.stringify(anthropicProfile)}`);
	assert(anthropicProfile.provider?.source === "stored", `anthropic profile provider source should be stored, got ${JSON.stringify(anthropicProfile)}`);
	assert(anthropicProfile.ready === true, `anthropic profile should be ready under synthetic OAuth/catalog, got ${JSON.stringify(anthropicProfile)}`);
	assert(anthropicProfile.active === true, `anthropic profile should be active from synthetic profile state, got ${JSON.stringify(anthropicProfile)}`);
	assert(aiProfileStatus.body?.activeProfileId === "anthropic", `active profile should be anthropic, got ${aiProfileStatus.body?.activeProfileId}`);

	assert(
		aiProfileStatus.body?.state?.path === "~/.exxperts/app/persistent-agent-ai-profile.json",
		`AI profile state path should be redacted, got ${aiProfileStatus.body?.state?.path}`,
	);
	assert(
		roomModelStatus.body?.selectionState?.path === "~/.exxperts/app/web-chat-model.json",
		`room model selection path should be redacted, got ${roomModelStatus.body?.selectionState?.path}`,
	);
	assert(roomModelStatus.body?.activeProfileId === "anthropic", `room model status active profile should be anthropic, got ${roomModelStatus.body?.activeProfileId}`);
	assert(roomModelStatus.body?.activeProfileLabel === "Claude", `room model status active profile label should be Claude, got ${roomModelStatus.body?.activeProfileLabel}`);
	assert(
		JSON.stringify(roomModelKeys(roomModelStatus.body)) === JSON.stringify([
			"anthropic/claude-opus-4-8",
			"anthropic/claude-sonnet-5",
			"anthropic/claude-fable-5",
			"anthropic/claude-opus-4-6",
			"anthropic/claude-opus-4-7",
			"anthropic/claude-sonnet-4-6",
		]),
		`room model options should match approved Claude order, got ${JSON.stringify(roomModelKeys(roomModelStatus.body))}`,
	);
	assert(
		JSON.stringify(compactRoomModelLabels(roomModelStatus.body)) === JSON.stringify([
			"Opus 4.8",
			"Sonnet 5",
			"Fable 5",
			"Opus 4.6",
			"Opus 4.7",
			"Sonnet 4.6",
		]),
		`room model picker labels should be friendly Claude labels, got ${JSON.stringify(compactRoomModelLabels(roomModelStatus.body))}`,
	);

	console.log("provider status diagnostics smoke passed");
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
