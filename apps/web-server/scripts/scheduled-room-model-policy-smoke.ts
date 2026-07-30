import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import type {
	BuiltInPersistentAgentAiProfileId,
	PersistentAgentAiProfileId,
	PersistentAgentModelLock,
} from "../src/persistent-agent-ai-profiles.js";

function assert(condition: unknown, message: string): asserts condition {
	if (!condition) throw new Error(message);
}

function writeJson(file: string, value: unknown): void {
	fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
	fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
}

function assertModelLock(actual: PersistentAgentModelLock, expected: PersistentAgentModelLock, label: string): void {
	assert(actual.provider === expected.provider, `${label}: expected provider ${expected.provider}, got ${actual.provider}`);
	assert(actual.model === expected.model, `${label}: expected model ${expected.model}, got ${actual.model}`);
}

function expectThrowMessage(fn: () => unknown, expectedMessagePart: string, label: string): void {
	try {
		fn();
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		assert(message.includes(expectedMessagePart), `${label}: expected error to include ${expectedMessagePart}, got ${message}`);
		return;
	}
	throw new Error(`${label}: expected failure`);
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

	assert(profiles.SCHEDULED_ROOM_MODEL_POLICY_KEY === "scheduledRoom", "scheduledRoom policy key should be exported");

	const expectedBuiltInModels: Record<BuiltInPersistentAgentAiProfileId, PersistentAgentModelLock> = {
		"chatgpt-codex": { provider: "openai-codex", model: "gpt-5.6-sol" },
		anthropic: { provider: "anthropic", model: "claude-opus-5" },
	};

	for (const [profileId, expected] of Object.entries(expectedBuiltInModels) as Array<[BuiltInPersistentAgentAiProfileId, PersistentAgentModelLock]>) {
		const resolved = profiles.resolveScheduledRoomModelLockForProfile(profileId);
		assertModelLock(resolved, expected, `${profileId} scheduledRoom`);
	}

	const mutableLock = profiles.resolveScheduledRoomModelLockForProfile("chatgpt-codex");
	mutableLock.provider = "mutated-provider";
	mutableLock.model = "mutated-model";
	assertModelLock(
		profiles.resolveScheduledRoomModelLockForProfile("chatgpt-codex"),
		expectedBuiltInModels["chatgpt-codex"],
		"scheduledRoom resolver should return cloned built-in locks",
	);

	writeJson(path.join(tempAppRoot, "web-chat-model.json"), {
		provider: "anthropic",
		model: "claude-sonnet-5",
	});
	assertModelLock(
		profiles.resolveScheduledRoomModelLockForProfile("chatgpt-codex"),
		expectedBuiltInModels["chatgpt-codex"],
		"scheduledRoom should ignore UI-selected room model state",
	);

	const openAiCompatiblePolicyPath = path.join(tempAppRoot, "openai-compatible-ai-profile.json");
	writeJson(openAiCompatiblePolicyPath, {
		profileId: "openai-compatible",
		providerId: "openai-compatible",
		label: "OpenAI-compatible gateway",
		roomModels: [
			{ modelId: "primary-room-model", label: "Primary Room Model" },
			{ modelId: "secondary-room-model", label: "Secondary Room Model" },
		],
		maintenanceModel: "maintenance-model",
	});

	const openAiCompatibleId = "openai-compatible" satisfies PersistentAgentAiProfileId;
	assertModelLock(
		profiles.resolveScheduledRoomModelLockForProfile(openAiCompatibleId),
		{ provider: "openai-compatible", model: "primary-room-model" },
		"openai-compatible scheduledRoom should use first configured room model",
	);

	const mutableOpenAiCompatibleLock = profiles.resolveScheduledRoomModelLockForProfile(openAiCompatibleId);
	mutableOpenAiCompatibleLock.model = "mutated-local-model";
	assertModelLock(
		profiles.resolveScheduledRoomModelLockForProfile(openAiCompatibleId),
		{ provider: "openai-compatible", model: "primary-room-model" },
		"scheduledRoom resolver should return cloned openai-compatible locks",
	);

	assert(
		!profiles.isPersistentRoomModelForProfile(openAiCompatibleId, "openai-compatible", "maintenance-model"),
		"maintenance-only model should not automatically become a room model",
	);
	assertModelLock(
		profiles.resolveScheduledRoomModelLockForProfile(openAiCompatibleId),
		{ provider: "openai-compatible", model: "primary-room-model" },
		"openai-compatible scheduledRoom should not use maintenanceModel when it is not first room model",
	);

	writeJson(openAiCompatiblePolicyPath, {
		profileId: "openai-compatible",
		providerId: "openai-compatible",
		label: "OpenAI-compatible gateway",
		roomModels: [
			{ modelId: "maintenance-model", label: "Maintenance Also First Room Model" },
			{ modelId: "primary-room-model", label: "Primary Room Model" },
		],
		maintenanceModel: "maintenance-model",
	});
	assertModelLock(
		profiles.resolveScheduledRoomModelLockForProfile(openAiCompatibleId),
		{ provider: "openai-compatible", model: "maintenance-model" },
		"openai-compatible scheduledRoom may use maintenanceModel only when it is first room model",
	);

	writeJson(openAiCompatiblePolicyPath, {
		profileId: "openai-compatible",
		providerId: "openai-compatible",
		label: "OpenAI-compatible gateway",
		roomModels: [],
		maintenanceModel: "maintenance-model",
	});
	expectThrowMessage(
		() => profiles.resolveScheduledRoomModelLockForProfile(openAiCompatibleId),
		"must include at least one room model",
		"openai-compatible scheduledRoom with no room models",
	);

	assert(!fs.existsSync(path.join(tempAgentRuntimeRoot, "models.json")), "scheduledRoom smoke must not create runtime models.json");
	assert(!fs.existsSync(path.join(tempAgentRuntimeRoot, "auth.json")), "scheduledRoom smoke must not create runtime auth.json");
	assert(!fs.existsSync(path.join(tempHome, ".exxeta")), "scheduledRoom smoke must not write legacy ~/.exxeta state");

	console.log("scheduled-room model policy smoke passed");
} finally {
	fs.rmSync(tmp, { recursive: true, force: true });
}
