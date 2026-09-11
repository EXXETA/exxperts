import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { SMOKE_SERVER_AUTH_ENV, SMOKE_SERVER_SPAWN_TREE_OPTIONS, stopSmokeServer } from "./smoke-server-process.js";

/**
 * Saved gateways re-read their declarations on their own.
 *
 * The snapshot of what a gateway declares about each approved model used to
 * move only when somebody pressed reload and save in the panel, so a price
 * change or a withdrawn thinking rung went unnoticed for weeks. The server now
 * refreshes every saved gateway shortly after it starts and once a day. Proven
 * here in three layers:
 *
 *   1. the pure core: a discovery that changes a price and an effort flag
 *      moves exactly those snapshot fields and touches no override; a field
 *      the gateway went silent about keeps its previous value, the price
 *      included, because a background run must never lose a fact over one
 *      blank answer; a model the gateway stopped listing keeps its row and
 *      its old snapshot; the maintenance model's own snapshot follows the
 *      same rules; and a discovery that adds nothing hands back the very
 *      same gateway object,
 *   2. the runner over fake seams: no key skips without probing, a gateway
 *      that answers 500 writes nothing and warns once, an unchanged gateway
 *      writes nothing, a changed one saves once, and a throwing seam never
 *      escapes,
 *   3. one real boot: a stub gateway changes its answers between three short
 *      refresh ticks, and the store and models.json move exactly when they
 *      should, never when the gateway is down or unchanged.
 *
 * Run: node scripts/run-smokes.mjs openai-compatible-gateway-refresh
 */

const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), "exxperts-gateway-refresh-home-"));
process.env.HOME = tempHome;
process.env.USERPROFILE = tempHome;
process.env.EXXPERTS_CODING_AGENT_DIR = path.join(tempHome, ".exxperts", "agent");

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const webServerDir = path.resolve(scriptDir, "..");
const repoRoot = path.resolve(webServerDir, "..", "..");
const port = 24000 + Math.floor(Math.random() * 10000);
const stubPort = port + 1;
const serverBaseUrl = `http://127.0.0.1:${port}`;
const stubGatewayBaseUrl = `http://127.0.0.1:${stubPort}/v1`;
const keylessGatewayBaseUrl = `http://127.0.0.1:${stubPort}/keyless/v1`;
const agentDir = path.join(tempHome, ".exxperts", "agent");
const productAppRoot = path.join(tempHome, ".exxperts", "app");
const modelsPath = path.join(agentDir, "models.json");
const authPath = path.join(agentDir, "auth.json");
const storePath = path.join(productAppRoot, "openai-compatible-gateways.json");
const gatewayKey = "synthetic-refresh-gateway-key-do-not-print";

function assert(condition: unknown, message: string): asserts condition {
	if (!condition) throw new Error(message);
}

function readJsonFile(filePath: string): any {
	return JSON.parse(fs.readFileSync(filePath, "utf-8"));
}

const oldCost = { input: 1, output: 2, cacheRead: 0.1, cacheWrite: 1 };
const newCost = { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 };

type StubPhase = "changed" | "down" | "same" | "priceless";
let stubPhase: StubPhase = "changed";
const stubHits: string[] = [];

/**
 * One gateway whose answers the smoke changes between ticks. In "changed" and
 * "same" it declares a new price and a flipped effort flag for priced-model,
 * says nothing at all about vanished-model, and declares a window for the
 * maintenance model. In "priceless" it answers the same facts with the price
 * and the effort flags left out, the blank answer a live gateway gave for one
 * fetch. In "down" it answers 500 to everything, which is a gateway having a
 * bad night. The keyless path is never supposed to be reached, and every hit
 * is recorded so that can be proven.
 */
function startStubGateway(): Promise<http.Server> {
	const server = http.createServer((req, res) => {
		const url = req.url ?? "";
		stubHits.push(url);
		if (stubPhase === "down") {
			res.writeHead(500, { "content-type": "application/json" });
			res.end(JSON.stringify({ error: "maintenance window" }));
			return;
		}
		if (!(req.headers.authorization ?? "").startsWith("Bearer ")) {
			res.writeHead(401, { "content-type": "application/json" });
			res.end(JSON.stringify({ error: "missing key" }));
			return;
		}
		if (url === "/v1/models") {
			res.writeHead(200, { "content-type": "application/json" });
			res.end(JSON.stringify({ data: [{ id: "priced-model" }, { id: "maint-model" }, { id: "newcomer-model" }] }));
			return;
		}
		if (url === "/v1/model/info") {
			res.writeHead(200, { "content-type": "application/json" });
			res.end(JSON.stringify({
				data: [
					{
						model_name: "priced-model",
						model_info: {
							supports_vision: true,
							supports_reasoning: true,
							max_input_tokens: 200000,
							...(stubPhase === "priceless" ? { input_cost_per_token: null, output_cost_per_token: null } : {
								supports_low_reasoning_effort: true,
								// The flag that flipped since the snapshot was taken.
								supports_high_reasoning_effort: true,
								input_cost_per_token: 3e-6,
								output_cost_per_token: 1.5e-5,
								cache_read_input_token_cost: 3e-7,
								cache_creation_input_token_cost: 3.75e-6,
							}),
						},
					},
					{ model_name: "maint-model", model_info: { max_input_tokens: 16000 } },
				],
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
			const response = await fetch(`${serverBaseUrl}/healthz`);
			if (response.ok) return;
			lastError = `healthz returned ${response.status}`;
		} catch (error) {
			lastError = (error as Error).message;
		}
		await new Promise((resolve) => setTimeout(resolve, 150));
	}
	throw new Error(`server did not become ready: ${lastError}`);
}

const serverOutput: string[] = [];

function countLogLines(needle: string): number {
	return serverOutput.join("").split("\n").filter((line) => line.includes(needle)).length;
}

/** Wait until the server has logged `needle` at least `count` times; the ticks are short, so this is a few seconds at most. */
async function waitForLogLine(needle: string, count: number, timeoutMs = 15000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (countLogLines(needle) >= count) return;
		await new Promise((resolve) => setTimeout(resolve, 100));
	}
	throw new Error(`server never logged "${needle}" ${count} time(s); output tail:\n${serverOutput.join("").split("\n").slice(-30).join("\n")}`);
}

/** Wait until the stub has seen at least `count` requests, which is how the smoke knows a tick started after a phase switch. */
async function waitForHits(count: number, timeoutMs = 15000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (stubHits.length >= count) return;
		await new Promise((resolve) => setTimeout(resolve, 50));
	}
	throw new Error(`the stub never saw ${count} requests, saw ${stubHits.length}`);
}

function smokeEnv(): NodeJS.ProcessEnv {
	const env: NodeJS.ProcessEnv = { ...process.env };
	for (const key of ["ANTHROPIC_API_KEY", "ANTHROPIC_OAUTH_TOKEN", "OPENAI_API_KEY", "AZURE_OPENAI_API_KEY", "EXXETA_AI_API_KEY", "COPILOT_GITHUB_TOKEN", "GH_TOKEN", "GITHUB_TOKEN", "GEMINI_API_KEY", "GOOGLE_CLOUD_API_KEY", "OPENROUTER_API_KEY"]) {
		delete env[key];
	}
	env.HOME = tempHome;
	env.USERPROFILE = tempHome;
	env.PORT = String(port);
	env.EXXPERTS_AUTH_TOKEN = SMOKE_SERVER_AUTH_ENV.EXXPERTS_AUTH_TOKEN;
	env.EXXETA_HOME = repoRoot;
	env.EXXPERTS_CODING_AGENT_DIR = agentDir;
	// The real schedule is seconds after boot and then daily; the smoke needs
	// three ticks inside a few seconds.
	env.EXXPERTS_GATEWAY_REFRESH_INITIAL_DELAY_MS = "300";
	env.EXXPERTS_GATEWAY_REFRESH_INTERVAL_MS = "1000";
	return env;
}

let server: ChildProcessWithoutNullStreams | null = null;
let stub: http.Server | null = null;

try {
	const refresh = await import("../src/openai-compatible-gateway-refresh.js");
	const { applyGatewayDeclarations, refreshGatewayDeclarations, resolveGatewayDeclarationsRefreshOptionsFromEnv, startGatewayDeclarationsRefreshLoop } = refresh;
	type Gateway = import("../src/openai-compatible-gateways.js").OpenAiCompatibleGateway;
	type Discovery = import("../src/openai-compatible-gateway-detect.js").GatewayDiscovery;

	// ---- 1. the pure core --------------------------------------------------
	const saved: Gateway = {
		id: "gateway-acme",
		providerId: "gateway-acme",
		label: "Acme",
		baseUrl: stubGatewayBaseUrl,
		roomModels: [
			// Overrides on every field a person can set, all of which must survive.
			{ modelId: "priced-model", vision: false, reasoning: true, contextWindow: 150000, maxTokens: 4096, webSearch: true, detected: { vision: true, reasoning: true, contextWindow: 200000, thinkingLevels: { low: true, high: false }, cost: oldCost } },
			{ modelId: "vanished-model", detected: { contextWindow: 32000 } },
		],
		maintenanceModel: "maint-model",
		maintenanceModelDetected: { contextWindow: 8000 },
	};
	const freshDiscovery: Discovery = {
		models: [
			{ id: "priced-model", vision: true, reasoning: true, contextWindow: 200000, thinkingLevels: { low: true, high: true }, cost: newCost },
			{ id: "maint-model", contextWindow: 16000 },
			{ id: "newcomer-model" },
		],
	};
	const update = applyGatewayDeclarations(saved, freshDiscovery);
	assert(update.changed.length === 2 && update.changed.includes("priced-model") && update.changed.includes("maintenanceModel"), `the price, the flag and the maintenance window changed, got ${JSON.stringify(update.changed)}`);
	assert(update.unlisted.length === 1 && update.unlisted[0] === "vanished-model", `the vanished model must be reported unlisted, got ${JSON.stringify(update.unlisted)}`);
	const priced = update.gateway.roomModels[0];
	assert(priced.vision === false && priced.reasoning === true && priced.contextWindow === 150000 && priced.maxTokens === 4096 && priced.webSearch === true, `every override must survive a refresh, got ${JSON.stringify(priced)}`);
	assert(JSON.stringify(priced.detected?.cost) === JSON.stringify(newCost), `the snapshot must carry the new price, got ${JSON.stringify(priced.detected)}`);
	assert(priced.detected?.thinkingLevels?.high === true && priced.detected?.thinkingLevels?.low === true, `the flipped effort flag must land in the snapshot, got ${JSON.stringify(priced.detected)}`);
	assert(update.gateway.roomModels[1] === saved.roomModels[1], "a model the gateway no longer lists must keep its row and snapshot untouched");
	assert(update.gateway.maintenanceModelDetected?.contextWindow === 16000, `the maintenance model's own snapshot must move too, got ${JSON.stringify(update.gateway.maintenanceModelDetected)}`);
	assert(saved.roomModels[0].detected?.cost === oldCost && saved.maintenanceModelDetected?.contextWindow === 8000, "the core must not mutate the gateway it was given");
	assert(update.gateway.roomModels.length === 2, "a newcomer the gateway lists is not approved behind anybody's back");

	// The same discovery again agrees with everything held: the very same
	// object comes back, which is what lets the runner skip the write.
	const again = applyGatewayDeclarations(update.gateway, freshDiscovery);
	assert(again.changed.length === 0 && again.gateway === update.gateway, `an unchanged discovery must hand back the same gateway, got ${JSON.stringify(again.changed)}`);

	// A pre-detection entry (no snapshot at all) and a gateway that has gone
	// silent about it: nothing to say equals nothing held, so no change.
	const silent = applyGatewayDeclarations({ ...saved, roomModels: [{ modelId: "priced-model", vision: true }] }, { models: [{ id: "priced-model" }] });
	assert(silent.changed.length === 0, "a silent gateway and an absent snapshot are the same declaration");
	// (f) The gateway answers everything it did before except the price, the
	// way a live one did for a single fetch. The price it published last time
	// stays, and since nothing else moved there is nothing to write.
	const priceless = applyGatewayDeclarations(update.gateway, { models: [{ id: "priced-model", vision: true, reasoning: true, contextWindow: 200000, thinkingLevels: { low: true, high: true } }, { id: "maint-model", contextWindow: 16000 }] });
	assert(priceless.changed.length === 0 && priceless.gateway === update.gateway, `a blank price must keep the previous one and cause no write, got ${JSON.stringify(priceless.changed)}`);
	// A gateway silent about everything keeps every field it had declared,
	// the maintenance model's window included.
	const allSilent = applyGatewayDeclarations(update.gateway, { models: [{ id: "priced-model" }, { id: "maint-model" }] });
	assert(allSilent.changed.length === 0, `a gateway that answers nothing changes nothing, got ${JSON.stringify(allSilent.changed)}`);
	// (g) A different price this time overwrites, and only the price moves.
	const repriced = applyGatewayDeclarations(update.gateway, { models: [{ id: "priced-model", cost: oldCost }] });
	assert(repriced.changed.length === 1 && repriced.changed[0] === "priced-model", `a new price is a change, got ${JSON.stringify(repriced.changed)}`);
	const repricedRow = repriced.gateway.roomModels[0].detected;
	assert(JSON.stringify(repricedRow?.cost) === JSON.stringify(oldCost) && repricedRow?.contextWindow === 200000 && repricedRow?.thinkingLevels?.high === true && repricedRow?.vision === true, `only the price moves, every unanswered field stays, got ${JSON.stringify(repricedRow)}`);
	// A single answered flag replaces the ladder as a block: the ladder is one
	// declaration, and half of one is not a merge anybody can reason about.
	const reladdered = applyGatewayDeclarations(update.gateway, { models: [{ id: "priced-model", thinkingLevels: { max: false } }] });
	assert(JSON.stringify(reladdered.gateway.roomModels[0].detected?.thinkingLevels) === JSON.stringify({ max: false }), `an answered ladder replaces the old one whole, got ${JSON.stringify(reladdered.gateway.roomModels[0].detected?.thinkingLevels)}`);
	// The caching declaration merges like every other field: an answer the
	// gateway leaves out keeps the declared true, and an explicit false
	// overwrites it, which is what pulls the cache marker out of the catalog
	// on the next save.
	const cachingGateway: Gateway = { id: "gateway-cache", providerId: "gateway-cache", label: "Cache", baseUrl: stubGatewayBaseUrl, roomModels: [{ modelId: "priced-model", detected: { promptCaching: true, contextWindow: 200000 } }], maintenanceModel: "priced-model" };
	const cachingSilent = applyGatewayDeclarations(cachingGateway, { models: [{ id: "priced-model", contextWindow: 200000 }] });
	assert(cachingSilent.changed.length === 0 && cachingSilent.gateway.roomModels[0].detected?.promptCaching === true, `silence about caching keeps the declared true, got ${JSON.stringify(cachingSilent.gateway.roomModels[0].detected)}`);
	const cachingRevoked = applyGatewayDeclarations(cachingGateway, { models: [{ id: "priced-model", promptCaching: false, contextWindow: 200000 }] });
	assert(cachingRevoked.changed.length === 1 && cachingRevoked.gateway.roomModels[0].detected?.promptCaching === false, `a declared false overwrites the caching flag, got ${JSON.stringify(cachingRevoked.gateway.roomModels[0].detected)}`);
	// The maintenance model's snapshot merges the same way: silence keeps the
	// window it had, and a new window moves it.
	const silentMaintenance = applyGatewayDeclarations(saved, { models: [{ id: "maint-model" }] });
	assert(silentMaintenance.changed.length === 0 && silentMaintenance.gateway.maintenanceModelDetected?.contextWindow === 8000, `a maintenance snapshot the gateway is silent about stays, got ${JSON.stringify(silentMaintenance.gateway.maintenanceModelDetected)}`);
	// A maintenance model with its own row is covered by that row, never twice.
	const ownRow = applyGatewayDeclarations({ ...saved, maintenanceModel: "priced-model", maintenanceModelDetected: undefined }, freshDiscovery);
	assert(!ownRow.changed.includes("maintenanceModel"), "a maintenance model with a room row is refreshed through that row only");

	// ---- 2. the runner over fake seams ---------------------------------------
	const keyless: Gateway = { id: "gateway-keyless", providerId: "gateway-keyless", label: "Keyless", baseUrl: keylessGatewayBaseUrl, roomModels: [{ modelId: "m", detected: {} }], maintenanceModel: "m" };
	const down: Gateway = { id: "gateway-down", providerId: "gateway-down", label: "Down", baseUrl: "http://127.0.0.1:9/v1", roomModels: [{ modelId: "m", detected: { contextWindow: 1000 } }], maintenanceModel: "m" };
	const addressless: Gateway = { id: "gateway-nowhere", providerId: "gateway-nowhere", label: "Nowhere", roomModels: [{ modelId: "m", detected: {} }], maintenanceModel: "m" };
	const throwing: Gateway = { id: "gateway-throws", providerId: "gateway-throws", label: "Throws", baseUrl: "http://127.0.0.1:9/v1", roomModels: [{ modelId: "m", detected: {} }], maintenanceModel: "m" };
	let store: Gateway[] = [saved, keyless, down, addressless, throwing];
	const probed: string[] = [];
	const savedGateways: Gateway[] = [];
	const warned: string[] = [];
	const informed: string[] = [];
	const run = await refreshGatewayDeclarations({
		readGateways: () => store,
		findGateway: (id) => store.find((gateway) => gateway.id === id),
		resolveBaseUrl: (gateway) => gateway.baseUrl ?? "",
		readKey: async (providerId) => {
			if (providerId === "gateway-throws") throw new Error("key storage exploded");
			return providerId === "gateway-keyless" ? undefined : "k";
		},
		discover: async (baseUrl) => {
			probed.push(baseUrl);
			if (baseUrl.startsWith("http://127.0.0.1:9/")) throw new Error("The gateway answered 500 for the model list.");
			return freshDiscovery;
		},
		save: (gateway) => {
			savedGateways.push(gateway);
			store = store.map((candidate) => (candidate.id === gateway.id ? gateway : candidate));
		},
		logger: {
			warn: (_value, message) => warned.push(message ?? ""),
			info: (_value, message) => informed.push(message ?? ""),
		},
	});
	const outcomeOf = (id: string) => run.outcomes.find((outcome) => outcome.gatewayId === id);
	assert(outcomeOf("gateway-keyless")?.status === "skipped" && !probed.includes(keylessGatewayBaseUrl), `a gateway with no stored key is skipped without a probe, got ${JSON.stringify(outcomeOf("gateway-keyless"))}`);
	assert(outcomeOf("gateway-nowhere")?.status === "skipped", `a gateway with no address anywhere is skipped, got ${JSON.stringify(outcomeOf("gateway-nowhere"))}`);
	assert(outcomeOf("gateway-down")?.status === "unreachable", `a gateway answering 500 is reported unreachable, got ${JSON.stringify(outcomeOf("gateway-down"))}`);
	assert(warned.some((line) => line.includes("could not reach Down") && line.includes("answered 500")), `one warn line names the gateway and the reason, got ${JSON.stringify(warned)}`);
	assert(outcomeOf("gateway-throws")?.status === "failed", `a seam that throws is recorded as failed and the run continues, got ${JSON.stringify(outcomeOf("gateway-throws"))}`);
	assert(outcomeOf("gateway-acme")?.status === "refreshed", `the changed gateway is refreshed, got ${JSON.stringify(outcomeOf("gateway-acme"))}`);
	assert(savedGateways.length === 1 && savedGateways[0].id === "gateway-acme", `exactly one save, for the changed gateway, got ${savedGateways.map((gateway) => gateway.id).join(",")}`);
	assert(informed.some((line) => line === "refreshed 2 model declarations for Acme"), `the info line counts the refreshed declarations, got ${JSON.stringify(informed)}`);
	assert(store.find((gateway) => gateway.id === "gateway-down")?.roomModels[0].detected?.contextWindow === 1000, "a gateway that was down keeps its old snapshot");

	// The same run again: nothing changed anywhere, so nothing is written.
	const secondRun = await refreshGatewayDeclarations({
		readGateways: () => store,
		findGateway: (id) => store.find((gateway) => gateway.id === id),
		resolveBaseUrl: (gateway) => gateway.baseUrl ?? "",
		readKey: async () => "k",
		discover: async () => freshDiscovery,
		save: () => { throw new Error("nothing should be written when nothing changed"); },
		logger: { info: (_value, message) => informed.push(message ?? "") },
	});
	assert(secondRun.outcomes.every((outcome) => outcome.status === "unchanged" || (outcome.gatewayId === "gateway-nowhere" && outcome.status === "skipped")), `every reachable gateway is unchanged on the second run, got ${JSON.stringify(secondRun.outcomes)}`);
	assert(informed.some((line) => line === "gateway declarations unchanged for Acme"), `the info line says unchanged, got ${JSON.stringify(informed)}`);

	// (f, g) through the runner: a blank price writes nothing; a new price
	// writes once and leaves every other field where it was.
	const runnerSaves: Gateway[] = [];
	const runnerDeps = (discovery: Discovery) => ({
		readGateways: () => store,
		findGateway: (id: string) => store.find((gateway) => gateway.id === id),
		resolveBaseUrl: (gateway: Gateway) => gateway.baseUrl ?? "",
		readKey: async () => "k",
		discover: async () => discovery,
		save: (gateway: Gateway) => {
			runnerSaves.push(gateway);
			store = store.map((candidate) => (candidate.id === gateway.id ? gateway : candidate));
		},
	});
	const blankPriceRun = await refreshGatewayDeclarations(runnerDeps({ models: [{ id: "priced-model", vision: true, reasoning: true, contextWindow: 200000, thinkingLevels: { low: true, high: true } }, { id: "maint-model", contextWindow: 16000 }] }));
	assert(blankPriceRun.outcomes.find((outcome) => outcome.gatewayId === "gateway-acme")?.status === "unchanged" && runnerSaves.length === 0, `a blank price must not write, got ${JSON.stringify(blankPriceRun.outcomes)}`);
	assert(JSON.stringify(store.find((gateway) => gateway.id === "gateway-acme")?.roomModels[0].detected?.cost) === JSON.stringify(newCost), "the previous price is still on file after a blank answer");
	const newPriceRun = await refreshGatewayDeclarations(runnerDeps({ models: [{ id: "priced-model", cost: oldCost }, { id: "maint-model", contextWindow: 16000 }] }));
	assert(newPriceRun.outcomes.find((outcome) => outcome.gatewayId === "gateway-acme")?.status === "refreshed" && runnerSaves.map((gateway) => gateway.id).join(",") === "gateway-acme", `a new price writes once, got ${JSON.stringify(newPriceRun.outcomes)}`);
	const repricedOnFile = store.find((gateway) => gateway.id === "gateway-acme")?.roomModels[0].detected;
	assert(JSON.stringify(repricedOnFile?.cost) === JSON.stringify(oldCost) && repricedOnFile?.contextWindow === 200000 && repricedOnFile?.thinkingLevels?.high === true, `the new price lands and the rest stays, got ${JSON.stringify(repricedOnFile)}`);

	// A save in the middle of a probe wins over the copy the probe started from.
	let midProbeStore: Gateway[] = [saved];
	const edited: Gateway = { ...saved, label: "Acme renamed", roomModels: [saved.roomModels[0]] };
	const raced = await refreshGatewayDeclarations({
		readGateways: () => midProbeStore,
		findGateway: (id) => midProbeStore.find((gateway) => gateway.id === id),
		resolveBaseUrl: (gateway) => gateway.baseUrl ?? "",
		readKey: async () => "k",
		discover: async () => {
			midProbeStore = [edited];
			return freshDiscovery;
		},
		save: (gateway) => { midProbeStore = [gateway]; },
	});
	assert(raced.outcomes[0]?.status === "refreshed" && midProbeStore[0].label === "Acme renamed" && midProbeStore[0].roomModels.length === 1, `a save during the probe must not be overwritten with the stale copy, got ${JSON.stringify(midProbeStore[0])}`);

	// The env switch and the loop's own guarantees.
	const off = resolveGatewayDeclarationsRefreshOptionsFromEnv({ EXXPERTS_GATEWAY_REFRESH_ENABLED: "off" });
	assert(off.enabled === false, "EXXPERTS_GATEWAY_REFRESH_ENABLED=off switches the refresh off");
	const defaults = resolveGatewayDeclarationsRefreshOptionsFromEnv({});
	assert(defaults.enabled === true && defaults.initialDelayMs === 5000 && defaults.intervalMs === 86_400_000, `the defaults are five seconds and a day, got ${JSON.stringify(defaults)}`);
	const badWarnings: string[] = [];
	const bad = resolveGatewayDeclarationsRefreshOptionsFromEnv({ EXXPERTS_GATEWAY_REFRESH_INTERVAL_MS: "soon" }, { warn: (_value, message) => badWarnings.push(message ?? "") });
	assert(bad.intervalMs === 86_400_000 && badWarnings.length === 1, "an unparseable interval falls back to the default and says so");
	let disabledReads = 0;
	const disabledLoop = startGatewayDeclarationsRefreshLoop({
		readGateways: () => { disabledReads++; return []; },
		findGateway: () => undefined,
		resolveBaseUrl: () => "",
		readKey: async () => undefined,
		discover: async () => ({ models: [] }),
		save: () => {},
	}, { enabled: false, initialDelayMs: 0, intervalMs: 1000 });
	await new Promise((resolve) => setTimeout(resolve, 50));
	assert(disabledReads === 0, "a disabled loop never reads the store");
	disabledLoop.stop();
	let overlapping = 0;
	let concurrent = 0;
	const serialLoop = startGatewayDeclarationsRefreshLoop({
		readGateways: () => {
			concurrent++;
			overlapping = Math.max(overlapping, concurrent);
			return [saved];
		},
		findGateway: () => saved,
		resolveBaseUrl: (gateway) => gateway.baseUrl ?? "",
		readKey: async () => "k",
		discover: async () => {
			await new Promise((resolve) => setTimeout(resolve, 60));
			concurrent--;
			throw new Error("slow and then down");
		},
		save: () => {},
	}, { enabled: true, initialDelayMs: 0, intervalMs: 10 });
	const first = serialLoop.runNow();
	const second = serialLoop.runNow();
	assert(first === second, "a run asked for while one is in flight joins it");
	await new Promise((resolve) => setTimeout(resolve, 150));
	serialLoop.stop();
	await first;
	assert(overlapping === 1, `runs never overlap, saw ${overlapping} at once`);
	const crashingLoop = startGatewayDeclarationsRefreshLoop({
		readGateways: () => { throw new Error("store exploded"); },
		findGateway: () => undefined,
		resolveBaseUrl: () => "",
		readKey: async () => undefined,
		discover: async () => ({ models: [] }),
		save: () => {},
	}, { enabled: true, initialDelayMs: 0, intervalMs: 1000 });
	const crashed = await crashingLoop.runNow();
	crashingLoop.stop();
	assert(crashed.outcomes.length === 0, "a store that cannot be read yields an empty run, not an exception");

	// ---- 3. one real boot ----------------------------------------------------
	fs.mkdirSync(agentDir, { recursive: true, mode: 0o700 });
	fs.mkdirSync(productAppRoot, { recursive: true, mode: 0o700 });
	fs.writeFileSync(storePath, JSON.stringify({
		version: 1,
		gateways: [
			saved,
			// A gateway whose key was never stored: the stub must never see it.
			{ ...keyless, baseUrl: keylessGatewayBaseUrl },
		],
		retiredProviderIds: [],
	}, null, 2), { mode: 0o600 });
	fs.writeFileSync(modelsPath, JSON.stringify({
		providers: {
			"gateway-acme": {
				name: "Acme",
				baseUrl: stubGatewayBaseUrl,
				api: "openai-completions",
				// A transport detail somebody added by hand, which every save keeps.
				headers: { "x-team": "research" },
				models: [
					{ id: "priced-model", name: "priced-model", reasoning: true, contextWindow: 150000, maxTokens: 4096, cost: oldCost, compat: { supportsWebSearch: true, handTuned: true } },
					{ id: "vanished-model", name: "vanished-model", contextWindow: 32000 },
					{ id: "maint-model", name: "maint-model", contextWindow: 8000 },
				],
			},
			"gateway-keyless": { name: "Keyless", baseUrl: keylessGatewayBaseUrl, api: "openai-completions", models: [{ id: "m", name: "m", contextWindow: 128000 }] },
		},
	}, null, 2), { mode: 0o600 });
	fs.writeFileSync(authPath, JSON.stringify({ "gateway-acme": { type: "api_key", key: gatewayKey } }, null, 2), { mode: 0o600 });

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

	// (a) The first tick sees the new price and the flipped flag.
	await waitForLogLine("refreshed 2 model declarations for Acme", 1);
	const storeAfter = readJsonFile(storePath);
	const acme = storeAfter.gateways.find((gateway: any) => gateway.id === "gateway-acme");
	const pricedRow = acme.roomModels.find((model: any) => model.modelId === "priced-model");
	assert(JSON.stringify(pricedRow.detected.cost) === JSON.stringify(newCost), `the store must carry the new price, got ${JSON.stringify(pricedRow.detected)}`);
	assert(pricedRow.detected.thinkingLevels.high === true, `the store must carry the flipped flag, got ${JSON.stringify(pricedRow.detected)}`);
	assert(pricedRow.vision === false && pricedRow.reasoning === true && pricedRow.contextWindow === 150000 && pricedRow.maxTokens === 4096 && pricedRow.webSearch === true, `overrides must survive on disk, got ${JSON.stringify(pricedRow)}`);
	const vanishedRow = acme.roomModels.find((model: any) => model.modelId === "vanished-model");
	assert(vanishedRow && vanishedRow.detected.contextWindow === 32000, `the vanished model keeps its row and snapshot, got ${JSON.stringify(vanishedRow)}`);
	assert(acme.maintenanceModelDetected?.contextWindow === 16000, `the maintenance snapshot moved, got ${JSON.stringify(acme.maintenanceModelDetected)}`);
	assert(storeAfter.gateways.some((gateway: any) => gateway.id === "gateway-keyless"), "the keyless gateway is still in the store");
	const catalogAfter = readJsonFile(modelsPath);
	const acmeProvider = catalogAfter.providers["gateway-acme"];
	const pricedEntry = acmeProvider.models.find((model: any) => model.id === "priced-model");
	assert(JSON.stringify(pricedEntry.cost) === JSON.stringify(newCost), `models.json must carry the new price, got ${JSON.stringify(pricedEntry)}`);
	assert(pricedEntry.contextWindow === 150000 && pricedEntry.maxTokens === 4096 && pricedEntry.reasoning === true && !pricedEntry.input, `models.json must reflect the overrides, got ${JSON.stringify(pricedEntry)}`);
	assert(pricedEntry.thinkingLevelMap === undefined || pricedEntry.thinkingLevelMap.high === undefined, `a declared-true high rung needs no map entry, got ${JSON.stringify(pricedEntry.thinkingLevelMap)}`);
	assert(pricedEntry.compat?.supportsWebSearch === true && pricedEntry.compat?.handTuned === true, `the hand-tuned compat block survives, got ${JSON.stringify(pricedEntry.compat)}`);
	assert(acmeProvider.headers?.["x-team"] === "research", "hand-added provider transport details survive");
	assert(acmeProvider.models.find((model: any) => model.id === "vanished-model")?.contextWindow === 32000, "the vanished model keeps its catalog entry");
	assert(acmeProvider.models.find((model: any) => model.id === "maint-model")?.contextWindow === 16000, `the maintenance entry follows its snapshot, got ${JSON.stringify(acmeProvider.models)}`);
	assert(catalogAfter.providers["gateway-keyless"].models[0].contextWindow === 128000, "the keyless gateway's catalog entry is untouched");
	assert(!stubHits.some((url) => url.startsWith("/keyless/")), `the keyless gateway must never be probed, stub saw ${JSON.stringify(stubHits)}`);
	const storeMtime = fs.statSync(storePath).mtimeMs;
	const catalogMtime = fs.statSync(modelsPath).mtimeMs;
	const backupsAfterRefresh = fs.readdirSync(agentDir).filter((name) => name.startsWith("models.json.bak-")).length;
	assert(backupsAfterRefresh === 1, `one catalog write means one backup, got ${backupsAfterRefresh}`);

	// (b) The gateway goes down: one warn line, nothing written.
	stubPhase = "down";
	await waitForLogLine("could not reach Acme", 1);
	assert(fs.statSync(storePath).mtimeMs === storeMtime && fs.statSync(modelsPath).mtimeMs === catalogMtime, "a gateway that is down must not cause a write");
	assert(JSON.stringify(readJsonFile(storePath)) === JSON.stringify(storeAfter), "a gateway that is down must not change the store");

	// (c, d) The gateway is back and says the same thing: nothing written.
	stubPhase = "same";
	await waitForLogLine("gateway declarations unchanged for Acme", 1);
	assert(fs.statSync(storePath).mtimeMs === storeMtime && fs.statSync(modelsPath).mtimeMs === catalogMtime, "an unchanged gateway must not cause a write");
	assert(fs.readdirSync(agentDir).filter((name) => name.startsWith("models.json.bak-")).length === 1, "no write means no new backup");
	// (f) The gateway blanks the price and the flags for one tick: the price
	// and the ladder on file stay, and nothing is written.
	stubPhase = "priceless";
	const hitsBeforeBlank = stubHits.length;
	await waitForHits(hitsBeforeBlank + 2);
	const unchangedBeforeBlankTick = countLogLines("gateway declarations unchanged for Acme");
	await waitForLogLine("gateway declarations unchanged for Acme", unchangedBeforeBlankTick + 1);
	assert(fs.statSync(storePath).mtimeMs === storeMtime && fs.statSync(modelsPath).mtimeMs === catalogMtime, "a blank price must not cause a write");
	const blankRow = readJsonFile(storePath).gateways.find((gateway: any) => gateway.id === "gateway-acme").roomModels.find((model: any) => model.modelId === "priced-model");
	assert(JSON.stringify(blankRow.detected.cost) === JSON.stringify(newCost) && blankRow.detected.thinkingLevels.high === true, `the price and the ladder survive a blank answer on disk, got ${JSON.stringify(blankRow.detected)}`);
	assert(countLogLines("refreshed 2 model declarations for Acme") === 1, "the refresh that changed things happened exactly once");

	console.log("openai-compatible-gateway-refresh smoke passed");
} finally {
	await stopSmokeServer(server);
	stub?.close();
	fs.rmSync(tempHome, { recursive: true, force: true });
}
