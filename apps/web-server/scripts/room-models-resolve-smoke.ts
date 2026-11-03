// Which model a room runs on, for talking and for memory work.
//
// A room keeps its own picks in runtime/models.json; a row it has not set
// inherits the default; a chosen model that cannot run (its provider is
// signed out, or its model is no longer offered), the room's own or the
// default, is kept and nothing runs in its place: the row has no effective
// model and says why. Only when nothing was ever chosen does the first model
// of the first ready provider serve, and it is stored as the default. Offered
// means the list AI setup gives rooms for that provider; the memory row may
// also use a provider's Memorize and Review models. This smoke pins the store,
// every branch of the resolution, the refusal's sentence, and that a model no
// list offers is never available, whatever it is called.
//
// Offline: real profile files, real auth store and model registry in a temp
// home; no server, no provider, no network.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), "room-models-resolve-home-"));
process.env.HOME = tempHome;
process.env.USERPROFILE = tempHome;
const agentDir = path.join(tempHome, ".exxperts", "agent");
const appDir = path.join(tempHome, ".exxperts", "app");
fs.mkdirSync(agentDir, { recursive: true });
fs.mkdirSync(appDir, { recursive: true });
process.env.EXXPERTS_CODING_AGENT_DIR = agentDir;
const root = path.join(appDir, "personalized-agents");
process.env.EXXETA_PERSISTENT_AGENTS_ROOT = root;

// Two ready providers: Claude (built in) and a gateway whose maintenance model
// is not one of its room models. ChatGPT is known to AI setup but signed out.
fs.writeFileSync(path.join(agentDir, "models.json"), JSON.stringify({
	providers: {
		"openai-compatible": {
			name: "Synthetic Gateway",
			baseUrl: "http://127.0.0.1:9/v1",
			api: "openai-completions",
			models: [
				{ id: "room-model", name: "Room Model", contextWindow: 128000, maxTokens: 16384 },
				{ id: "maint-model", name: "Maintenance Model", contextWindow: 200000, maxTokens: 32000 },
				{ id: "vendor/model-with-slash", name: "Slash Model", contextWindow: 64000, maxTokens: 8192 },
			],
		},
	},
}, null, 2));
function writeAuth(providers: string[]): void {
	fs.writeFileSync(path.join(agentDir, "auth.json"), JSON.stringify(Object.fromEntries(providers.map((provider) => [provider, { type: "api_key", key: `synthetic-${provider}` }])), null, 2), { mode: 0o600 });
}
writeAuth(["anthropic", "openai-compatible"]);
fs.writeFileSync(path.join(appDir, "openai-compatible-ai-profile.json"), JSON.stringify({
	profileId: "openai-compatible",
	providerId: "openai-compatible",
	label: "Synthetic Gateway",
	roomModels: [{ modelId: "room-model" }, { modelId: "vendor/model-with-slash" }],
	maintenanceModel: "maint-model",
}, null, 2));
fs.writeFileSync(path.join(appDir, "persistent-agent-ai-profile.json"), JSON.stringify({ profileId: "anthropic" }, null, 2));

const { createPersistentAgentFromScaffoldInput } = await import("../src/persistent-agents.js");
const {
	createRoomModelCatalog,
	readRoomModels,
	catalogModelNames,
	readStoredAiDefaults,
	resolveAiDefault,
	resolveRoomModel,
	roomModelsPath,
	roomModelUnavailableError,
	writeAiDefaults,
	writeRoomModels,
} = await import("../src/room-models.js");

function assert(condition: unknown, message: string): asserts condition {
	if (!condition) throw new Error(message);
}

function pass(label: string): void {
	console.log(`  ok  ${label}`);
}

const key = (lock: { provider: string; model: string } | null | undefined) => (lock ? `${lock.provider}/${lock.model}` : "none");
const OPUS = { provider: "anthropic", model: "claude-opus-5-5" };
const SONNET = { provider: "anthropic", model: "claude-sonnet-5" };
const SOL = { provider: "openai-codex", model: "gpt-6-sol" };
const ROOM_MODEL = { provider: "openai-compatible", model: "room-model" };
const MAINT_MODEL = { provider: "openai-compatible", model: "maint-model" };
const SLASH_MODEL = { provider: "openai-compatible", model: "vendor/model-with-slash" };

try {
	const agentId = createPersistentAgentFromScaffoldInput({ displayName: "Room Models Resolve", userName: "Synthetic User", preferredUserAddress: "Synthetic User" }).agent.agentId;

	// --- The store ---------------------------------------------------------------------
	assert(readRoomModels(agentId) === null, "a room with no picks reads as none");
	assert(!fs.existsSync(roomModelsPath(agentId)), "reading never creates the file");
	writeRoomModels(agentId, { conversation: SLASH_MODEL }, {}, new Date("2026-09-25T10:00:00.000Z"));
	const stored = readRoomModels(agentId);
	assert(key(stored?.conversation) === key(SLASH_MODEL) && !stored?.memory && stored?.updatedAt === "2026-09-25T10:00:00.000Z", `a pick is stored as written, a model id with a slash included, got ${JSON.stringify(stored)}`);
	writeRoomModels(agentId, { memory: MAINT_MODEL });
	assert(key(readRoomModels(agentId)?.conversation) === key(SLASH_MODEL) && key(readRoomModels(agentId)?.memory) === key(MAINT_MODEL), "setting one row keeps the other");
	writeRoomModels(agentId, { conversation: null, memory: null });
	assert(!readRoomModels(agentId)?.conversation && !readRoomModels(agentId)?.memory, "null clears a row back to the default");
	fs.writeFileSync(roomModelsPath(agentId), "not json");
	assert(readRoomModels(agentId) === null, "an unreadable file reads as no picks");
	let refused = false;
	try { roomModelsPath("../escape"); } catch { refused = true; }
	assert(refused, "a room id with a path in it is refused");
	pass("the store keeps each row on its own, clears with null, reads a bad file as none, and refuses a path in a room id");

	// --- The defaults ------------------------------------------------------------------
	let catalog = createRoomModelCatalog();
	const derived = resolveAiDefault("conversation", catalog);
	assert(derived.derived && key(derived.effective) === key(OPUS) && derived.source === "default", `with no stored default the conversation default is the saved profile's recommended room model, got ${JSON.stringify(derived)}`);
	assert(key(resolveAiDefault("memory", catalog).effective) === key(OPUS), "with no stored default the memory default is the saved profile's Memorize model");
	fs.writeFileSync(path.join(appDir, "web-chat-model.json"), JSON.stringify(SONNET));
	assert(key(resolveAiDefault("conversation", createRoomModelCatalog()).effective) === key(SONNET), "the app's last pick for new rooms is the derived default when the saved profile offers it");
	fs.writeFileSync(path.join(appDir, "web-chat-model.json"), JSON.stringify(ROOM_MODEL));
	assert(key(resolveAiDefault("conversation", createRoomModelCatalog()).effective) === key(OPUS), "a last pick the saved profile does not offer is ignored");
	fs.rmSync(path.join(appDir, "web-chat-model.json"));
	writeAiDefaults({ conversation: ROOM_MODEL, memory: MAINT_MODEL });
	catalog = createRoomModelCatalog();
	const explicit = resolveAiDefault("memory", catalog);
	assert(!explicit.derived && key(explicit.effective) === key(MAINT_MODEL), `a stored default wins over the derived one, got ${JSON.stringify(explicit)}`);
	assert(JSON.parse(fs.readFileSync(path.join(appDir, "persistent-agent-ai-profile.json"), "utf-8")).profileId === "anthropic", "writing the defaults keeps the saved profile pointer");
	pass("the defaults derive from the saved profile (its last pick, else its recommendation, and its Memorize model) until they are stored");

	// --- Which recommendation is real ---------------------------------------------------
	const byProvider = (id: string) => catalog.providers.find((provider) => provider.providerId === id);
	assert(byProvider("anthropic")?.curated === true, "a built-in provider's list is curated, so its recommendation is one the pickers tag");
	assert(byProvider("openai-compatible")?.curated === false && byProvider("openai-compatible")?.recommended.conversation, "a gateway keeps a first model for the fallback order, but it is not curated, so no picker tags it");
	pass("only a curated provider's recommendation is tagged; a gateway's first model is only first");

	// --- A room ------------------------------------------------------------------------
	let row = resolveRoomModel(agentId, "conversation", catalog);
	assert(row.stored === null && key(row.effective) === key(ROOM_MODEL) && row.source === "default", `a row the room has not set runs the default, got ${JSON.stringify(row)}`);
	writeRoomModels(agentId, { conversation: SONNET });
	row = resolveRoomModel(agentId, "conversation", catalog);
	assert(key(row.effective) === key(SONNET) && row.source === "room" && !row.reason, `a room's own pick runs, got ${JSON.stringify(row)}`);
	writeRoomModels(agentId, { conversation: SOL });
	row = resolveRoomModel(agentId, "conversation", catalog);
	assert(key(row.stored) === key(SOL) && key(row.chosen) === key(SOL) && row.effective === null && row.source === "room" && row.reason === "signed-out", `a pick on a signed-out provider is kept and nothing runs in its place, got ${JSON.stringify(row)}`);
	const names = catalogModelNames(catalog);
	const signedOutRefusal = roomModelUnavailableError(row, "conversation", names);
	assert(signedOutRefusal?.code === "provider_signed_out" && signedOutRefusal.provider === "openai-codex" && signedOutRefusal.statusCode === 409, `a signed-out pick refuses with the code the room's socket stands down on, got ${JSON.stringify(signedOutRefusal)}`);
	assert(/^This room's model, .+ on .+, is signed out\. Sign in again in Settings, AI setup, or choose another model in Room settings, Model\.$/.test(signedOutRefusal.message) && signedOutRefusal.message.includes("gpt-6-sol") === false, `the refusal names the model and its provider by name, and the way out, got ${signedOutRefusal.message}`);
	const consultRefusal = roomModelUnavailableError(row, "memory", names, { room: "Client Brief" });
	assert(consultRefusal?.message.startsWith("The memory model of Client Brief, ") && consultRefusal.message.endsWith("choose another model in its Room settings, Model."), `a consult names the consulted room, got ${consultRefusal?.message}`);
	writeRoomModels(agentId, { conversation: { provider: "anthropic", model: "claude-3-opus-20240229" } });
	row = resolveRoomModel(agentId, "conversation", catalog);
	assert(row.reason === "not-offered" && row.effective === null && row.source === "room", `a pick that left the list is kept and nothing runs in its place, got ${JSON.stringify(row)}`);
	const notOffered = roomModelUnavailableError(row, "conversation", names);
	assert(notOffered?.code === "room_model_unavailable" && / is no longer offered\. Choose another model in Room settings, Model\.$/.test(notOffered.message), `a delisted pick refuses with its own code and the one way out, got ${notOffered?.message}`);
	writeRoomModels(agentId, { conversation: { provider: "anthropic", model: "claude-made-up-9" } });
	assert(resolveRoomModel(agentId, "conversation", catalog).reason === "not-offered", "a model id no list offers never runs");
	writeRoomModels(agentId, { conversation: SONNET });
	assert(roomModelUnavailableError(resolveRoomModel(agentId, "conversation", catalog), "conversation", names) === null, "a pick that runs is never refused");
	pass("a room runs its own pick, keeps a signed-out or delisted pick with no model in its place and a refusal that names it, and never runs a model no list offers");

	// --- The memory row --------------------------------------------------------------------
	assert(catalog.availability(MAINT_MODEL, "memory").ok, "the gateway's Memorize model is offered for memory work");
	assert(!catalog.availability(MAINT_MODEL, "conversation").ok, "the gateway's Memorize model is not a room model");
	writeRoomModels(agentId, { memory: OPUS });
	assert(key(resolveRoomModel(agentId, "memory", catalog).effective) === key(OPUS), "the memory row may pick any listed model, whatever the conversation runs on");
	pass("the memory row may use a provider's Memorize model, and any listed model");

	// --- A default that cannot run ------------------------------------------------------------
	writeAiDefaults({ conversation: SOL });
	writeRoomModels(agentId, { conversation: null });
	catalog = createRoomModelCatalog();
	row = resolveRoomModel(agentId, "conversation", catalog);
	assert(row.effective === null && row.stored === null && key(row.chosen) === key(SOL) && row.source === "default" && row.reason === "signed-out", `a row on a default that cannot run has no model in its place and says why, got ${JSON.stringify(row)}`);
	assert(roomModelUnavailableError(row, "conversation", catalogModelNames(catalog))?.message.startsWith("This room's model, "), "and the room refuses with the default's name");
	const defaultRow = resolveAiDefault("conversation", catalog);
	assert(key(defaultRow.stored) === key(SOL) && defaultRow.effective === null && defaultRow.reason === "signed-out", "the default row says why it does not run, and runs nothing in its place");
	assert(roomModelUnavailableError(defaultRow, "conversation", catalogModelNames(catalog), "defaults")?.message.endsWith("Sign in again, or choose another default, in Settings, AI setup."), "the default's own refusal points to AI setup");
	pass("a default that cannot run is not replaced: rooms on it wait, and it says why");

	// --- Sign-ins move with the auth store ------------------------------------------------------
	writeAuth(["anthropic", "openai-compatible", "openai-codex"]);
	catalog = createRoomModelCatalog();
	assert(key(resolveRoomModel(agentId, "conversation", catalog).effective) === key(SOL), "once the provider signs in again the stored default runs again");
	writeAuth([]);
	catalog = createRoomModelCatalog();
	row = resolveRoomModel(agentId, "memory", catalog);
	assert(row.effective === null && row.source === "room" && row.reason === "signed-out", `with no provider ready the room's pick waits, got ${JSON.stringify(row)}`);
	assert(key(row.stored) === key(OPUS), "and the room's pick is still there");
	pass("a pick comes back when its provider signs in again, and with no provider ready nothing runs");

	// --- A saved profile is a choice, signed in or not ------------------------------------------
	// Before any default is stored, the saved profile names it: a saved gateway
	// whose sign-in lapsed while Claude is signed in stays the default, and the
	// rooms on it wait; they never move to Claude.
	fs.writeFileSync(path.join(appDir, "persistent-agent-ai-profile.json"), JSON.stringify({ profileId: "openai-compatible" }, null, 2));
	writeAuth(["anthropic"]);
	catalog = createRoomModelCatalog();
	const savedGateway = resolveAiDefault("conversation", catalog);
	assert(savedGateway.derived && key(savedGateway.chosen) === key(ROOM_MODEL) && savedGateway.effective === null && savedGateway.reason === "signed-out", `a saved profile whose provider is signed out is still the default, and nothing runs in its place, got ${JSON.stringify(savedGateway)}`);
	assert(!readStoredAiDefaults().conversation, "a derived default is not written by reading it");
	pass("a saved profile whose provider is signed out stays the default: its rooms wait instead of moving to a signed-in provider");

	// --- Nothing ever chosen ------------------------------------------------------------------
	// A first run: no saved profile and no default. Nothing signed in: nothing
	// runs and nothing is named. Then a sign-in: its first model serves, and is
	// stored as the default on the spot, so a later sign-in moves nothing.
	fs.rmSync(path.join(appDir, "persistent-agent-ai-profile.json"));
	writeRoomModels(agentId, { conversation: null, memory: null });
	writeAuth([]);
	catalog = createRoomModelCatalog();
	row = resolveRoomModel(agentId, "conversation", catalog);
	assert(row.effective === null && row.chosen === null && row.source === "none" && !row.reason, `with nothing chosen and nothing signed in nothing runs and no model is named, got ${JSON.stringify(row)}`);
	assert(roomModelUnavailableError(row, "conversation", catalogModelNames(catalog)) === null, "so the caller keeps its own \"no provider is signed in\" line");
	assert(!fs.existsSync(path.join(appDir, "persistent-agent-ai-profile.json")), "and nothing is written");
	writeAuth(["anthropic"]);
	catalog = createRoomModelCatalog();
	row = resolveRoomModel(agentId, "conversation", catalog);
	assert(key(row.effective) === key(OPUS) && row.source === "fallback" && row.chosen === null && !row.reason, `with nothing chosen the first ready model serves, got ${JSON.stringify(row)}`);
	assert(key(readStoredAiDefaults().conversation) === key(OPUS), "and it is stored as the default");
	writeAuth(["anthropic", "openai-compatible", "openai-codex"]);
	catalog = createRoomModelCatalog();
	row = resolveRoomModel(agentId, "conversation", catalog);
	assert(key(row.effective) === key(OPUS) && row.source === "default", `a later sign-in moves nothing: the stored default runs, got ${JSON.stringify(row)}`);
	pass("with nothing ever chosen the first ready model serves and becomes the default; with nothing signed in nothing runs");

	console.log("room models resolve smoke passed");
} finally {
	fs.rmSync(tempHome, { recursive: true, force: true });
}
