import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { authedFetch, type AuthedFetchInit, SMOKE_SERVER_AUTH_ENV, SMOKE_SERVER_SPAWN_TREE_OPTIONS, stopSmokeServer } from "./smoke-server-process.js";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

function assert(condition: unknown, message: string): asserts condition {
	if (!condition) throw new Error(message);
}

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "exxperts-provider-login-api-"));
const tempHome = path.join(tempRoot, "home");
const tempAgentRuntimeRoot = path.join(tempHome, ".exxperts", "agent");
fs.mkdirSync(tempHome, { recursive: true, mode: 0o700 });

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const webServerDir = path.resolve(scriptDir, "..");
const repoRoot = path.resolve(webServerDir, "..", "..");
const port = 26000 + Math.floor(Math.random() * 10000);
const baseUrl = `http://127.0.0.1:${port}`;
const serverOutput: string[] = [];
let server: ChildProcessWithoutNullStreams | null = null;

async function waitForServer(child: ChildProcessWithoutNullStreams): Promise<void> {
	const deadline = Date.now() + 20000;
	let lastError = "server did not respond";
	while (Date.now() < deadline) {
		if (child.exitCode != null) throw new Error(`server exited before startup with code ${child.exitCode}: ${serverOutput.join("")}`);
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
		headers: {
			...(init.body ? { "content-type": "application/json" } : {}),
			...(init.headers ?? {}),
		},
	});
	const text = await response.text();
	return { status: response.status, body: text ? JSON.parse(text) : null };
}

try {
	server = spawn("npx", ["tsx", "src/index.ts"], {
		shell: process.platform === "win32",
		...SMOKE_SERVER_SPAWN_TREE_OPTIONS,
		cwd: webServerDir,
		env: {
			...process.env,
			HOME: tempHome,
			USERPROFILE: tempHome,
			PORT: String(port),
			...SMOKE_SERVER_AUTH_ENV,
			EXXETA_HOME: repoRoot,
			EXXPERTS_CODING_AGENT_DIR: tempAgentRuntimeRoot,
		},
	}) as ChildProcessWithoutNullStreams;
	server.stdout.on("data", (chunk) => serverOutput.push(String(chunk)));
	server.stderr.on("data", (chunk) => serverOutput.push(String(chunk)));
	await waitForServer(server);

	// --- login provider catalog -------------------------------------------
	const catalog = await requestJson("/api/auth/providers");
	assert(catalog.status === 200, `providers catalog should respond, got ${catalog.status}`);
	const providers: any[] = catalog.body?.providers ?? [];
	assert(providers.length > 10, `catalog should expose the full Pi provider surface, got ${providers.length}`);
	const byId = new Map(providers.map((provider) => [provider.id, provider]));
	assert(byId.get("anthropic")?.authTypes.includes("oauth") && byId.get("anthropic")?.authTypes.includes("api_key"), "anthropic should support oauth and api_key");
	assert(byId.get("openai-codex")?.authTypes.join(",") === "oauth", "openai-codex should be oauth-only");
	assert(byId.get("github-copilot")?.authTypes.join(",") === "oauth", "github-copilot should be oauth-only");
	assert(byId.get("groq")?.authTypes.join(",") === "api_key", "groq should be api_key-only");
	assert(byId.get("groq")?.configured === false, "groq should start unconfigured");
	assert(byId.get("anthropic")?.profileId === "anthropic", "anthropic should map to its built-in profile");
	assert(byId.get("groq")?.profileId === null, "groq should have no profile yet");

	// --- api-key sign-in ----------------------------------------------------
	const badProvider = await requestJson("/api/auth/api-key", { method: "POST", body: JSON.stringify({ provider: "openai-codex", key: "sk-test" }) });
	assert(badProvider.status === 400, "oauth-only provider must reject api-key sign-in");
	const missingKey = await requestJson("/api/auth/api-key", { method: "POST", body: JSON.stringify({ provider: "groq", key: "  " }) });
	assert(missingKey.status === 400, "empty key must be rejected");
	const saved = await requestJson("/api/auth/api-key", { method: "POST", body: JSON.stringify({ provider: "groq", key: "gsk-test-key" }) });
	assert(saved.status === 200 && saved.body?.ok === true, `api-key save should succeed, got ${saved.status}: ${JSON.stringify(saved.body)}`);
	assert(!JSON.stringify(saved.body).includes("gsk-test-key"), "api-key response must not echo the key");
	const authFile = path.join(tempAgentRuntimeRoot, "auth.json");
	assert(fs.existsSync(authFile), "auth.json should exist after api-key save");
	const afterSave = await requestJson("/api/auth/providers");
	assert(afterSave.body.providers.find((provider: any) => provider.id === "groq")?.configured === true, "groq should be configured after api-key save");
	const overview = await requestJson("/api/auth/status");
	assert(overview.body.providers.some((provider: any) => provider.id === "groq" && provider.configured), "auth overview should surface the newly configured provider");

	// --- model catalog for the configure step -------------------------------
	const noProvider = await requestJson("/api/persistent-agent-ai-profiles/model-catalog");
	assert(noProvider.status === 400, "model catalog should require a provider");
	const unknownProvider = await requestJson("/api/persistent-agent-ai-profiles/model-catalog?provider=not-a-provider");
	assert(unknownProvider.status === 404, "unknown provider should 404");
	const groqCatalog = await requestJson("/api/persistent-agent-ai-profiles/model-catalog?provider=groq");
	assert(groqCatalog.status === 200 && Array.isArray(groqCatalog.body?.models) && groqCatalog.body.models.length > 0, "groq model catalog should list models");
	const suggested = String(groqCatalog.body.suggested ?? "");
	assert(suggested, "model catalog should propose a suggested default");
	assert(groqCatalog.body.models.some((model: any) => model.id === suggested && model.suggestedDefault), "suggested default should be flagged in the model list");
	const groqModelIds: string[] = groqCatalog.body.models.map((model: any) => String(model.id));

	// --- custom profile CRUD -------------------------------------------------
	const reservedGateway = await requestJson("/api/persistent-agent-ai-profiles/custom", {
		method: "PUT",
		body: JSON.stringify({ providerId: "openai-compatible", roomModels: ["x"], learnModel: "x", reviewMemoryModel: "x" }),
	});
	assert(reservedGateway.status === 400, "gateway provider must be rejected for custom profiles");
	// Built-in providers take a catalog override instead: identity stays, models change, reset restores.
	const overridden = await requestJson("/api/persistent-agent-ai-profiles/custom", {
		method: "PUT",
		body: JSON.stringify({ providerId: "anthropic", roomModels: ["claude-opus-4-8"], learnModel: "claude-opus-4-8", reviewMemoryModel: "claude-opus-4-8" }),
	});
	assert(overridden.status === 200, `built-in override should be accepted, got ${overridden.status}: ${JSON.stringify(overridden.body)}`);
	const overriddenAnthropic = overridden.body.profiles.find((profile: any) => profile.id === "anthropic");
	assert(overriddenAnthropic?.overridden === true, "anthropic should report overridden");
	assert(overriddenAnthropic?.kind === "builtin", "override keeps builtin kind");
	assert(overriddenAnthropic?.processes?.persistentRoom?.models?.length === 1, "override should narrow the room catalog");
	assert(!overridden.body.profiles.some((profile: any) => profile.id === "custom-anthropic"), "override must not add a separate profile row");
	const resetOverride = await requestJson("/api/persistent-agent-ai-profiles/custom/custom-anthropic", { method: "DELETE" });
	assert(resetOverride.status === 200, `override reset should succeed, got ${resetOverride.status}`);
	const resetAnthropic = resetOverride.body.profiles.find((profile: any) => profile.id === "anthropic");
	assert(resetAnthropic?.overridden === false && resetAnthropic?.processes?.persistentRoom?.models?.length === 6, "reset should restore the curated catalog");
	const badModel = await requestJson("/api/persistent-agent-ai-profiles/custom", {
		method: "PUT",
		body: JSON.stringify({ providerId: "groq", roomModels: ["definitely-not-a-model"], learnModel: suggested, reviewMemoryModel: suggested }),
	});
	assert(badModel.status === 400, "unknown model ids must be rejected");
	const secondModel = groqModelIds.find((id) => id !== suggested) ?? suggested;
	const upserted = await requestJson("/api/persistent-agent-ai-profiles/custom", {
		method: "PUT",
		body: JSON.stringify({ providerId: "groq", label: "Groq", roomModels: [suggested, secondModel], learnModel: suggested, reviewMemoryModel: suggested }),
	});
	assert(upserted.status === 200, `custom profile upsert should succeed, got ${upserted.status}: ${JSON.stringify(upserted.body)}`);
	const customDiag = upserted.body.profiles.find((profile: any) => profile.id === "custom-groq");
	assert(customDiag, "custom-groq should appear in profile diagnostics");
	assert(customDiag.kind === "custom", "custom profile should be flagged custom");
	assert(customDiag.ready === true, `custom-groq should be ready with a stored key, issues: ${JSON.stringify(customDiag.issues)}`);
	const builtIn = upserted.body.profiles.find((profile: any) => profile.id === "anthropic");
	assert(builtIn && builtIn.kind === "builtin", "built-in profiles must not be flagged custom");
	assert(Array.isArray(upserted.body.customProfiles?.errors) && upserted.body.customProfiles.errors.length === 0, "custom profile load errors should be empty");

	// --- activate the custom profile and check room model gating -------------
	const activated = await requestJson("/api/persistent-agent-ai-profile", { method: "PUT", body: JSON.stringify({ profileId: "custom-groq" }) });
	assert(activated.status === 200 && activated.body.activeProfileId === "custom-groq", `custom profile should activate, got ${activated.status}`);
	const modelStatus = await requestJson("/api/persistent-agent-room/model-status");
	const roomModels: any[] = modelStatus.body?.roomModels ?? [];
	assert(roomModels.length === new Set([suggested, secondModel]).size, `room model options should mirror the approved catalog, got ${JSON.stringify(roomModels)}`);
	assert(roomModels.every((option) => option.provider === "groq"), "room model options should all come from the custom provider");
	const approve = await requestJson("/api/persistent-agent-room/model-selection", { method: "POST", body: JSON.stringify({ provider: "groq", model: suggested }) });
	assert(approve.status === 200, `approved model selection should succeed, got ${approve.status}: ${JSON.stringify(approve.body)}`);
	const unapprovedId = groqModelIds.find((id) => id !== suggested && id !== secondModel);
	if (unapprovedId) {
		const rejected = await requestJson("/api/persistent-agent-room/model-selection", { method: "POST", body: JSON.stringify({ provider: "groq", model: unapprovedId }) });
		assert(rejected.status === 400, `unapproved model must be rejected by the gate, got ${rejected.status}`);
	}

	// --- delete + logout ------------------------------------------------------
	const deleteMissing = await requestJson("/api/persistent-agent-ai-profiles/custom/custom-xai", { method: "DELETE" });
	assert(deleteMissing.status === 404, "deleting a missing custom profile should 404");
	const deleteBuiltIn = await requestJson("/api/persistent-agent-ai-profiles/custom/anthropic", { method: "DELETE" });
	assert(deleteBuiltIn.status === 400, "deleting a built-in profile must be rejected");
	// Sign-out works standalone for API-key providers before removal.
	const logout = await requestJson("/api/auth/logout", { method: "POST", body: JSON.stringify({ provider: "groq" }) });
	assert(logout.status === 200 && logout.body?.ok === true, `api-key provider logout should succeed, got ${logout.status}`);
	const afterLogout = await requestJson("/api/auth/providers");
	assert(afterLogout.body.providers.find((provider: any) => provider.id === "groq")?.configured === false, "groq should be unconfigured after logout");
	const resaved = await requestJson("/api/auth/api-key", { method: "POST", body: JSON.stringify({ provider: "groq", key: "gsk-test-key" }) });
	assert(resaved.status === 200, "re-saving the key should succeed");
	const deleted = await requestJson("/api/persistent-agent-ai-profiles/custom/custom-groq", { method: "DELETE" });
	assert(deleted.status === 200, `custom profile delete should succeed, got ${deleted.status}`);
	assert(deleted.body.activeProfileId !== "custom-groq", "active profile should fall back after deleting the active custom profile");
	assert(!deleted.body.profiles.some((profile: any) => profile.id === "custom-groq"), "deleted profile should disappear from diagnostics");
	// Removing the provider also drops its stored credential.
	const afterDelete = await requestJson("/api/auth/providers");
	assert(afterDelete.body.providers.find((provider: any) => provider.id === "groq")?.configured === false, "groq should be unconfigured after profile removal");

	console.log("provider login API smoke passed");
} finally {
	await stopSmokeServer(server);
	fs.rmSync(tempRoot, { recursive: true, force: true });
}
