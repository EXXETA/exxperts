// The model a scheduled run starts a fresh conversation on: the room's
// conversation model, resolved like any other new conversation (the room's
// own pick, else the default), and never another. A chosen model whose
// provider is signed out is named, so the run's readiness check blocks it as
// not connected, even while another provider is signed in; one no longer
// offered is refused with the room's sentence. With no provider signed in it
// names the default's model for the same check; resolving never creates
// runtime auth or model state. A gateway's Memorize-only model is never a
// conversation model. Each call hands back its own copy of the lock.
//
// Offline: no server, no provider, no network.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import type { PersistentAgentModelLock } from "../src/persistent-agent-ai-profiles.js";

function assert(condition: unknown, message: string): asserts condition {
	if (!condition) throw new Error(message);
}

function writeJson(file: string, value: unknown): void {
	fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
	fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
}

function assertModelLock(actual: PersistentAgentModelLock, expected: PersistentAgentModelLock, label: string): void {
	assert(actual.provider === expected.provider && actual.model === expected.model, `${label}: expected ${expected.provider}/${expected.model}, got ${actual.provider}/${actual.model}`);
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "exxperts-scheduled-room-model-policy-"));
const tempHome = path.join(tmp, "home");
const tempAgentRuntimeRoot = path.join(tempHome, ".exxperts", "agent");
const tempAgentsRoot = path.join(tempHome, ".exxperts", "app", "personalized-agents");
const tempAppRoot = path.join(tempHome, ".exxperts", "app");
fs.mkdirSync(tempHome, { recursive: true, mode: 0o700 });

process.env.HOME = tempHome;
process.env.USERPROFILE = tempHome;
process.env.EXXPERTS_CODING_AGENT_DIR = tempAgentRuntimeRoot;
process.env.EXXETA_PERSISTENT_AGENTS_ROOT = tempAgentsRoot;

try {
	const profiles = await import("../src/persistent-agent-ai-profiles.js");
	const roomModels = await import("../src/room-models.js");
	const { createPersistentAgentFromScaffoldInput } = await import("../src/persistent-agents.js");

	assert(profiles.SCHEDULED_ROOM_MODEL_POLICY_KEY === "scheduledRoom", "scheduledRoom policy key should be exported");
	const agentId = createPersistentAgentFromScaffoldInput({ displayName: "Scheduled Model Room", userName: "Synthetic User", preferredUserAddress: "Synthetic User" }).agent.agentId;

	// Nothing signed in: the run names the model the room would run on (the
	// default), so its readiness check blocks it as not connected; resolving
	// creates no state.
	assertModelLock(roomModels.resolveScheduledRoomModel(agentId), { provider: "openai-codex", model: "gpt-6-sol" }, "with nothing signed in a scheduled run names the default's model");
	assert(!fs.existsSync(path.join(tempAgentRuntimeRoot, "models.json")), "resolving must not create runtime models.json");
	assert(!fs.existsSync(path.join(tempAgentRuntimeRoot, "auth.json")), "resolving must not create runtime auth.json");
	console.log("  ok  with nothing signed in a scheduled run names the default's model for the readiness check to block, and nothing is created");

	// A signed-in gateway whose Memorize model is not one of its room models.
	writeJson(path.join(tempAgentRuntimeRoot, "models.json"), {
		providers: {
			"openai-compatible": {
				name: "Synthetic Gateway",
				baseUrl: "http://127.0.0.1:9/v1",
				api: "openai-completions",
				models: [
					{ id: "primary-room-model", name: "Primary Room Model", contextWindow: 128000, maxTokens: 16384 },
					{ id: "secondary-room-model", name: "Secondary Room Model", contextWindow: 128000, maxTokens: 16384 },
					{ id: "maintenance-model", name: "Maintenance Model", contextWindow: 128000, maxTokens: 16384 },
				],
			},
		},
	});
	writeJson(path.join(tempAgentRuntimeRoot, "auth.json"), { "openai-compatible": { type: "api_key", key: "synthetic-scheduled-key" } });
	writeJson(path.join(tempAppRoot, "openai-compatible-ai-profile.json"), {
		profileId: "openai-compatible",
		providerId: "openai-compatible",
		label: "OpenAI-compatible gateway",
		roomModels: [{ modelId: "primary-room-model" }, { modelId: "secondary-room-model" }],
		maintenanceModel: "maintenance-model",
	});
	writeJson(path.join(tempAppRoot, "persistent-agent-ai-profile.json"), { profileId: "openai-compatible" });

	const primary = { provider: "openai-compatible", model: "primary-room-model" };
	const secondary = { provider: "openai-compatible", model: "secondary-room-model" };
	assertModelLock(roomModels.resolveScheduledRoomModel(agentId), primary, "a room without its own pick runs on the default, the first room model");
	const copy = roomModels.resolveScheduledRoomModel(agentId);
	copy.model = "mutated-model";
	assertModelLock(roomModels.resolveScheduledRoomModel(agentId), primary, "each call hands back its own copy");
	console.log("  ok  a room without its own pick runs a scheduled conversation on the default, and each call hands back a copy");

	roomModels.writeRoomModels(agentId, { conversation: secondary });
	assertModelLock(roomModels.resolveScheduledRoomModel(agentId), secondary, "the room's own pick wins");
	roomModels.writeRoomModels(agentId, { conversation: { provider: "openai-compatible", model: "maintenance-model" } });
	assert(!profiles.isPersistentRoomModelForProfile("openai-compatible", "openai-compatible", "maintenance-model"), "the Memorize-only model is not a room model");
	let refusal: unknown = null;
	try { roomModels.resolveScheduledRoomModel(agentId); } catch (error) { refusal = error; }
	assert(refusal instanceof roomModels.RoomModelUnavailableError && refusal.code === "room_model_unavailable" && /^This room's model, Maintenance Model on .+, is no longer offered\. Choose another model in Room settings, Model\.$/.test(refusal.message), `a pick on the Memorize-only model is not a conversation model: the run is refused with the sentence, nothing else runs, got ${String(refusal)}`);
	console.log("  ok  the room's own pick wins, and a Memorize-only model never runs a conversation, nor does anything in its place");

	// The gateway signs out while Claude is signed in: the run names the
	// room's pick for the readiness check to block, never a Claude model.
	roomModels.writeRoomModels(agentId, { conversation: secondary });
	writeJson(path.join(tempAgentRuntimeRoot, "auth.json"), { anthropic: { type: "api_key", key: "synthetic-anthropic-key" } });
	assertModelLock(roomModels.resolveScheduledRoomModel(agentId), secondary, "a pick on a signed-out provider is named for the readiness check, whatever else is signed in");
	roomModels.writeRoomModels(agentId, { conversation: null });
	assertModelLock(roomModels.resolveScheduledRoomModel(agentId), primary, "a room on a default whose provider is signed out names the default, whatever else is signed in");
	console.log("  ok  with the room's provider signed out a scheduled run names the room's model to be blocked, never a model of another signed-in provider");

	assert(!fs.existsSync(path.join(tempHome, ".exxeta")), "scheduledRoom smoke must not write legacy ~/.exxeta state");
	console.log("scheduled-room model policy smoke passed");
} finally {
	fs.rmSync(tmp, { recursive: true, force: true });
}
