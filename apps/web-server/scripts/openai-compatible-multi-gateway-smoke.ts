import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { authedFetch, type AuthedFetchInit, SMOKE_SERVER_AUTH_ENV, SMOKE_SERVER_SPAWN_TREE_OPTIONS, stopSmokeServer } from "./smoke-server-process.js";

/**
 * Several saved gateways, side by side.
 *
 * The single gateway used to be the literal "openai-compatible" in four places
 * at once, one of them the {provider, model} lock every room thread stores
 * forever. So the load-bearing claim here is not that a second gateway can be
 * added, it is that adding one leaves the first exactly where it was: same
 * profile id, same provider id, same approved models, same key, same rooms
 * still able to resume.
 *
 * Proven end to end against stub gateways that answer the plain model list,
 * LiteLLM's richer /model/info, and the restricted case where that route is
 * refused:
 *   a) two gateways coexist with distinct provider ids, models and keys,
 *   b) a legacy single-gateway setup is read as the first gateway, keeping the
 *      id "openai-compatible", and a room model lock against it still validates,
 *   c) the image flag and the context window reach models.json and the runtime
 *      model registry,
 *   d) deleting the second gateway leaves the first one's models and key intact,
 *   e) all three capability shapes are parsed into pre-filled form values, in
 *      the right order of precedence, including the company case where a
 *      restricted virtual key gets 403 from /model/info and the window is only
 *      ever visible on the /models rows.
 */

const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), "exxperts-multi-gateway-home-"));
const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const webServerDir = path.resolve(scriptDir, "..");
const repoRoot = path.resolve(webServerDir, "..", "..");
const port = 24000 + Math.floor(Math.random() * 10000);
const stubPort = port + 1;
const baseUrl = `http://127.0.0.1:${port}`;
const stubGatewayBaseUrl = `http://127.0.0.1:${stubPort}/v1`;
const restrictedGatewayBaseUrl = `http://127.0.0.1:${stubPort}/restricted/v1`;
const agentDir = path.join(tempHome, ".exxperts", "agent");
const productAppRoot = path.join(tempHome, ".exxperts", "app");
const modelsPath = path.join(agentDir, "models.json");
const authPath = path.join(agentDir, "auth.json");

const legacyGatewayKey = "synthetic-legacy-gateway-key-do-not-print";
const projectGatewayKey = "synthetic-project-gateway-key-do-not-print";

function assert(condition: unknown, message: string): asserts condition {
	if (!condition) throw new Error(message);
}

/**
 * Two gateways behind one stub.
 *
 * /v1 is the generous one: its /models list carries OpenRouter's
 * architecture/context_length shape and its /model/info answers LiteLLM's. Real
 * gateways speak one or the other, so serving both proves each parser without a
 * second server and lets the LiteLLM override be observed where they disagree.
 *
 * /restricted/v1 is the one most company users actually have: a LiteLLM whose
 * virtual key is scoped to the llm_api_routes group, so /model/info answers 403
 * with LiteLLM's own wording. Its /models rows still carry max_input_tokens,
 * which is the only place the window is available to such a key.
 */
function startStubGateway(): Promise<http.Server> {
	const server = http.createServer((req, res) => {
		const url = req.url ?? "";
		if (!(req.headers.authorization ?? "").startsWith("Bearer ")) {
			res.writeHead(401, { "content-type": "application/json" });
			res.end(JSON.stringify({ error: "missing key" }));
			return;
		}
		if (url === "/v1/models") {
			res.writeHead(200, { "content-type": "application/json" });
			res.end(JSON.stringify({
				data: [
					{ id: "vision-model", architecture: { input_modalities: ["text", "image"] }, context_length: 64000 },
					{ id: "plain-model", architecture: { modality: "text->text" }, context_length: 32000 },
					// Both dialects on one row, disagreeing on purpose, and absent from
					// /model/info so the row is the only source: OpenRouter's field is
					// the more specific of the two and must be the one that is read.
					{ id: "dual-shape-model", context_length: 64000, max_input_tokens: 999999 },
					{ id: "silent-model" },
				],
			}));
			return;
		}
		if (url === "/v1/model/info") {
			res.writeHead(200, { "content-type": "application/json" });
			res.end(JSON.stringify({
				data: [
					// Overrides the /models context_length: LiteLLM answers about the
					// deployment, the catalog row only about the family.
					{ model_name: "vision-model", model_info: { supports_vision: true, max_input_tokens: 200000, max_output_tokens: 8192 } },
					{ model_name: "plain-model", model_info: { supports_vision: false, max_tokens: 32000 } },
				],
			}));
			return;
		}
		if (url === "/restricted/v1/models") {
			res.writeHead(200, { "content-type": "application/json" });
			res.end(JSON.stringify({
				data: [
					{ id: "claude-opus-5", object: "model", owned_by: "openai", max_input_tokens: 1000000, max_output_tokens: 128000 },
					{ id: "small-model", object: "model", owned_by: "openai", max_input_tokens: 32000, max_output_tokens: 8192 },
				],
			}));
			return;
		}
		if (url === "/restricted/v1/model/info") {
			res.writeHead(403, { "content-type": "application/json" });
			res.end(JSON.stringify({
				error: { message: "Virtual key is not allowed to call this route. Only allowed to call routes: ['llm_api_routes']" },
			}));
			return;
		}
		res.writeHead(404, { "content-type": "application/json" });
		res.end(JSON.stringify({ error: "not found" }));
	});
	return new Promise((resolve, reject) => {
		server.once("error", reject);
		server.listen(stubPort, "127.0.0.1", () => resolve(server));
	});
}

async function waitForServer(server: ChildProcessWithoutNullStreams): Promise<void> {
	const deadline = Date.now() + 20000;
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

function assertStatusOk(response: { status: number; body: any }, label: string): void {
	assert(response.status === 200, `${label} should return 200, got ${response.status}: ${JSON.stringify(response.body)}`);
}

function readJsonFile(filePath: string): any {
	return JSON.parse(fs.readFileSync(filePath, "utf-8"));
}

function profileStatus(status: any, profileId: string): any {
	return status?.profiles?.find((profile: any) => profile?.id === profileId);
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
	env.EXXPERTS_AUTH_TOKEN = SMOKE_SERVER_AUTH_ENV.EXXPERTS_AUTH_TOKEN;
	env.EXXETA_HOME = repoRoot;
	env.EXXPERTS_CODING_AGENT_DIR = agentDir;
	return env;
}

let server: ChildProcessWithoutNullStreams | null = null;
let stub: http.Server | null = null;
const serverOutput: string[] = [];

try {
	fs.mkdirSync(agentDir, { recursive: true, mode: 0o700 });
	fs.mkdirSync(productAppRoot, { recursive: true, mode: 0o700 });
	// The world as an older version left it: one gateway, described only by the
	// legacy policy file, with no gateways store anywhere.
	fs.writeFileSync(modelsPath, JSON.stringify({
		providers: {
			"openai-compatible": {
				name: "OpenAI-compatible gateway",
				baseUrl: stubGatewayBaseUrl,
				api: "openai-completions",
				models: [
					{ id: "legacy-primary", name: "Legacy Primary" },
					{ id: "legacy-maintenance", name: "Legacy Maintenance" },
				],
			},
		},
	}, null, 2), { mode: 0o600 });
	fs.writeFileSync(authPath, JSON.stringify({
		"openai-compatible": { type: "api_key", key: legacyGatewayKey },
	}, null, 2), { mode: 0o600 });
	fs.writeFileSync(path.join(productAppRoot, "openai-compatible-ai-profile.json"), JSON.stringify({
		profileId: "openai-compatible",
		providerId: "openai-compatible",
		label: "OpenAI-compatible gateway",
		roomModels: [{ modelId: "legacy-primary", label: "Legacy Primary" }],
		maintenanceModel: "legacy-maintenance",
	}, null, 2), { mode: 0o600 });

	stub = await startStubGateway();
	server = spawn("npx", ["tsx", "src/index.ts"], {
		shell: process.platform === "win32",
		...SMOKE_SERVER_SPAWN_TREE_OPTIONS,
		cwd: webServerDir,
		env: smokeEnv(),
	});
	server.stdout.on("data", (chunk) => serverOutput.push(String(chunk)));
	server.stderr.on("data", (chunk) => serverOutput.push(String(chunk)));
	await waitForServer(server);

	// (b) The legacy file alone is enough to be the first gateway, with both ids
	// exactly as every existing room lock spells them.
	const listed = await requestJson("/api/persistent-agent-ai-profiles/gateways");
	assertStatusOk(listed, "gateway list");
	assert(listed.body.gateways.length === 1, `only the legacy gateway should be listed, got ${JSON.stringify(listed.body.gateways)}`);
	const legacy = listed.body.gateways[0];
	assert(legacy.id === "openai-compatible" && legacy.providerId === "openai-compatible", `legacy gateway must keep both ids, got ${JSON.stringify(legacy)}`);
	assert(legacy.baseUrl === stubGatewayBaseUrl, `legacy base URL should come from models.json, got ${JSON.stringify(legacy)}`);
	assert(!fs.existsSync(path.join(productAppRoot, "openai-compatible-gateways.json")), "reading a legacy setup must not rewrite anything");

	const selectLegacy = await requestJson("/api/persistent-agent-ai-profile", {
		method: "PUT",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ profileId: "openai-compatible" }),
	});
	assertStatusOk(selectLegacy, "select legacy gateway profile");
	// A room thread locked to {provider: "openai-compatible", model: "legacy-primary"}
	// still validates against the active profile, which is the whole invariant.
	const legacyLock = await requestJson("/api/persistent-agent-room/model-selection", {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ provider: "openai-compatible", model: "legacy-primary" }),
	});
	assertStatusOk(legacyLock, "legacy room model lock");

	// (e) Detection: the LiteLLM shape is parsed, and it wins over the catalog
	// row's smaller window. A model neither source describes stays undecided.
	const discovered = await requestJson("/api/persistent-agent-ai-profiles/gateways/discover", {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ baseUrl: stubGatewayBaseUrl, key: projectGatewayKey }),
	});
	assertStatusOk(discovered, "gateway discovery");
	const detected = new Map<string, any>((discovered.body.detected ?? []).map((entry: any) => [entry.id, entry]));
	assert(discovered.body.models.join(",") === "dual-shape-model,plain-model,silent-model,vision-model", `discovery should list every model id, got ${JSON.stringify(discovered.body.models)}`);
	assert(detected.get("vision-model")?.vision === true, `vision should be detected, got ${JSON.stringify(detected.get("vision-model"))}`);
	assert(detected.get("vision-model")?.contextWindow === 200000, `LiteLLM max_input_tokens should win, got ${JSON.stringify(detected.get("vision-model"))}`);
	assert(detected.get("plain-model")?.vision === false, `a model declared text-only should read as text-only, got ${JSON.stringify(detected.get("plain-model"))}`);
	assert(detected.get("silent-model")?.vision === null && detected.get("silent-model")?.contextWindow === null, `an undescribed model should stay undecided, got ${JSON.stringify(detected.get("silent-model"))}`);

	// The company case: a LiteLLM virtual key scoped to llm_api_routes, so the
	// rich probe is refused outright. The window is still declared, on the rows
	// the key IS allowed to fetch, and reading it there is what stops a
	// million-token model from arriving as the 128k default.
	const restricted = await requestJson("/api/persistent-agent-ai-profiles/gateways/discover", {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ baseUrl: restrictedGatewayBaseUrl, key: projectGatewayKey }),
	});
	assertStatusOk(restricted, "discovery against a restricted LiteLLM key");
	const restrictedDetected = new Map<string, any>((restricted.body.detected ?? []).map((entry: any) => [entry.id, entry]));
	assert(restrictedDetected.get("claude-opus-5")?.contextWindow === 1000000, `max_input_tokens on the /models row should be read, got ${JSON.stringify(restrictedDetected.get("claude-opus-5"))}`);
	assert(restrictedDetected.get("small-model")?.contextWindow === 32000, `every row's declared window should be read, got ${JSON.stringify(restrictedDetected.get("small-model"))}`);
	// The LiteLLM row shape says nothing about images, so neither do we: the
	// checkbox opens unticked and the person decides.
	assert(restrictedDetected.get("claude-opus-5")?.vision === null, `a shape that carries no image field must not imply one, got ${JSON.stringify(restrictedDetected.get("claude-opus-5"))}`);
	// A 403 from the rich probe is a correctly configured gateway, not a failure.
	assert(restricted.body.models.join(",") === "claude-opus-5,small-model", `a refused /model/info must not fail discovery, got ${JSON.stringify(restricted.body.models)}`);

	// Precedence holds where the two /models dialects meet on one row: the
	// OpenRouter field is the more specific and is not displaced by the
	// max_input_tokens sitting beside it.
	assert(detected.get("dual-shape-model")?.contextWindow === 64000, `OpenRouter context_length should win inside a row, got ${JSON.stringify(detected.get("dual-shape-model"))}`);

	// (a) A second gateway, with its own name, key and approved models.
	const created = await requestJson("/api/persistent-agent-ai-profiles/gateways", {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({
			label: "Project gateway",
			baseUrl: stubGatewayBaseUrl,
			key: projectGatewayKey,
			roomModels: [
				{ modelId: "vision-model", vision: true, contextWindow: 200000 },
				{ modelId: "plain-model", vision: false, contextWindow: 32000 },
			],
			maintenanceModel: "plain-model",
		}),
	});
	assertStatusOk(created, "create second gateway");
	const projectProviderId = created.body.gateway.providerId;
	assert(projectProviderId === "gateway-project-gateway", `second gateway should mint its own provider id, got ${projectProviderId}`);
	assert(created.body.gateway.id === projectProviderId, `gateway profile id and provider id should agree, got ${JSON.stringify(created.body.gateway)}`);

	const bothListed = await requestJson("/api/persistent-agent-ai-profiles/gateways");
	assertStatusOk(bothListed, "gateway list after adding");
	assert(bothListed.body.gateways.length === 2, `both gateways should be listed, got ${JSON.stringify(bothListed.body.gateways.map((g: any) => g.id))}`);
	assert(bothListed.body.gateways.some((g: any) => g.id === "openai-compatible"), "the legacy gateway must survive the second one being added");

	const profilesAfterAdd = await requestJson("/api/persistent-agent-ai-profile");
	assertStatusOk(profilesAfterAdd, "profile status after adding");
	const legacyProfile = profileStatus(profilesAfterAdd.body, "openai-compatible");
	const projectProfile = profileStatus(profilesAfterAdd.body, projectProviderId);
	assert(legacyProfile && projectProfile, `both gateways should appear as profiles, got ${JSON.stringify(profilesAfterAdd.body.profiles?.map((p: any) => p.id))}`);
	assert(legacyProfile.kind === "gateway" && projectProfile.kind === "gateway", "both gateway profiles should be typed as gateways");
	assert(projectProfile.provider?.configured === true, `the second gateway's own key should make it connected, got ${JSON.stringify(projectProfile.provider)}`);
	assert(projectProfile.ready === true, `the second gateway should be ready, got ${JSON.stringify(projectProfile.issues)}`);

	// Distinct keys, one per gateway.
	const auth = readJsonFile(authPath);
	assert(auth["openai-compatible"]?.key === legacyGatewayKey, "the legacy gateway must keep its own key");
	assert(auth[projectProviderId]?.key === projectGatewayKey, `the second gateway should store its own key, got ${JSON.stringify(Object.keys(auth))}`);

	// (c) The two capability facts reach models.json.
	const models = readJsonFile(modelsPath);
	const projectProvider = models.providers[projectProviderId];
	assert(projectProvider, `models.json should carry the second gateway, got ${JSON.stringify(Object.keys(models.providers))}`);
	const visionEntry = projectProvider.models.find((model: any) => model.id === "vision-model");
	const plainEntry = projectProvider.models.find((model: any) => model.id === "plain-model");
	assert(JSON.stringify(visionEntry.input) === JSON.stringify(["text", "image"]), `an image-capable model should be registered as such, got ${JSON.stringify(visionEntry)}`);
	assert(visionEntry.contextWindow === 200000, `the chosen context window should be written, got ${JSON.stringify(visionEntry)}`);
	assert(plainEntry.input === undefined, `a text-only model should not claim image input, got ${JSON.stringify(plainEntry)}`);
	assert(plainEntry.contextWindow === 32000, `the chosen context window should be written, got ${JSON.stringify(plainEntry)}`);

	// The plural store now exists, and the legacy file is still a faithful
	// mirror of the first gateway rather than a stale second opinion.
	const store = readJsonFile(path.join(productAppRoot, "openai-compatible-gateways.json"));
	assert(store.gateways.some((gateway: any) => gateway.id === "openai-compatible"), `the store should carry the migrated first gateway, got ${JSON.stringify(store)}`);
	const legacyFile = readJsonFile(path.join(productAppRoot, "openai-compatible-ai-profile.json"));
	assert(legacyFile.profileId === "openai-compatible" && legacyFile.providerId === "openai-compatible", `the legacy file must keep saying what it always said, got ${JSON.stringify(legacyFile)}`);

	// A context window nobody could have meant is refused rather than coerced.
	// parseInt would have read "1e9" as 1, and a room whose window is 1 token
	// compacts itself on every message.
	for (const badWindow of ["1e9", 12, 99999999999999]) {
		const rejected = await requestJson(`/api/persistent-agent-ai-profiles/gateways/${projectProviderId}`, {
			method: "PUT",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				label: "Project gateway",
				baseUrl: stubGatewayBaseUrl,
				roomModels: [{ modelId: "vision-model", vision: true, contextWindow: badWindow }],
				maintenanceModel: "vision-model",
			}),
		});
		assert(rejected.status === 400, `context window ${JSON.stringify(badWindow)} should be refused, got ${rejected.status}: ${JSON.stringify(rejected.body)}`);
	}
	const stillIntact = await requestJson(`/api/persistent-agent-ai-profiles/gateways/${projectProviderId}`);
	assert(stillIntact.body.roomModels.length === 2, `a refused save must change nothing, got ${JSON.stringify(stillIntact.body.roomModels)}`);

	// Approve-models sends no base URL, because that screen does not ask for one.
	// Requiring it there refused the save over a field nobody could see.
	const modelsOnlySave = await requestJson(`/api/persistent-agent-ai-profiles/gateways/${projectProviderId}`, {
		method: "PUT",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({
			label: "Project gateway",
			roomModels: [{ modelId: "vision-model", vision: true, contextWindow: 200000, label: "Vision Model" }],
			maintenanceModel: "vision-model",
		}),
	});
	assertStatusOk(modelsOnlySave, "approve-models save without a base URL");
	const afterModelsOnly = await requestJson(`/api/persistent-agent-ai-profiles/gateways/${projectProviderId}`);
	assert(afterModelsOnly.body.baseUrl === stubGatewayBaseUrl, `the stored base URL must survive a models-only save, got ${JSON.stringify(afterModelsOnly.body)}`);
	assert(afterModelsOnly.body.roomModels[0].label === "Vision Model", `a model's display name must round-trip, got ${JSON.stringify(afterModelsOnly.body.roomModels[0])}`);

	// (d) Removing the second gateway takes only the second gateway.
	const removed = await requestJson(`/api/persistent-agent-ai-profiles/gateways/${projectProviderId}`, { method: "DELETE" });
	assertStatusOk(removed, "delete second gateway");
	const modelsAfterDelete = readJsonFile(modelsPath);
	assert(!modelsAfterDelete.providers[projectProviderId], "the removed gateway should be gone from models.json");
	assert(modelsAfterDelete.providers["openai-compatible"]?.models?.length === 2, `the first gateway's models must survive, got ${JSON.stringify(modelsAfterDelete.providers["openai-compatible"])}`);
	const authAfterDelete = readJsonFile(authPath);
	assert(authAfterDelete["openai-compatible"]?.key === legacyGatewayKey, "the first gateway must stay signed in");
	assert(!authAfterDelete[projectProviderId], "the removed gateway's key should be gone");
	const listedAfterDelete = await requestJson("/api/persistent-agent-ai-profiles/gateways");
	assert(listedAfterDelete.body.gateways.length === 1 && listedAfterDelete.body.gateways[0].id === "openai-compatible", `only the first gateway should remain, got ${JSON.stringify(listedAfterDelete.body.gateways)}`);
	const lockAfterDelete = await requestJson("/api/persistent-agent-room/model-selection", {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ provider: "openai-compatible", model: "legacy-primary" }),
	});
	assertStatusOk(lockAfterDelete, "legacy room model lock after deleting the other gateway");

	// A gateway added again under the same name must not inherit the deleted
	// one's id: rooms still locked to it would silently re-attach to whatever
	// endpoint this new gateway points at.
	const readded = await requestJson("/api/persistent-agent-ai-profiles/gateways", {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({
			label: "Project gateway",
			baseUrl: stubGatewayBaseUrl,
			key: projectGatewayKey,
			roomModels: [{ modelId: "plain-model" }],
			maintenanceModel: "plain-model",
		}),
	});
	assertStatusOk(readded, "re-adding a gateway with the removed one's name");
	assert(readded.body.gateway.providerId !== projectProviderId, `a retired provider id must not come back, got ${readded.body.gateway.providerId}`);

	console.log("openai-compatible multi-gateway smoke passed");
} catch (error) {
	const output = serverOutput.join("").trim();
	if (output) console.error(output.split("\n").slice(-80).join("\n"));
	console.error(error instanceof Error ? error.stack || error.message : error);
	console.error(`temp HOME preserved for inspection: ${tempHome}`);
	process.exitCode = 1;
} finally {
	await stopSmokeServer(server);
	if (stub) await new Promise<void>((resolve) => stub!.close(() => resolve()));
	if (process.exitCode == null || process.exitCode === 0) {
		fs.rmSync(tempHome, { recursive: true, force: true });
	}
}
