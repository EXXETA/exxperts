import { isCustomAiProfileId, readCustomAiProfiles } from "./custom-ai-profiles.js";
import {
	GATEWAY_PROVIDER_ID_PREFIX,
	OPENAI_COMPATIBLE_AI_PROFILE_FILE,
	OPENAI_COMPATIBLE_AI_PROFILE_ID,
	OPENAI_COMPATIBLE_PROVIDER_ID,
	readOpenAiCompatibleGateways,
	type OpenAiCompatibleGateway,
} from "./openai-compatible-gateways.js";

export type BuiltInPersistentAgentAiProfileId = "chatgpt-codex" | "anthropic";
export type LocalPersistentAgentAiProfileId = "openai-compatible";
// Widened to string: besides the built-in profiles, users can save any number of
// OpenAI-compatible gateways (each its own profile) and create custom
// per-provider profiles ("custom-<providerId>"); membership is validated at
// runtime via isPersistentAgentAiProfileId / getPersistentAgentAiProfile.
export type PersistentAgentAiProfileId = string;

export { OPENAI_COMPATIBLE_AI_PROFILE_FILE, OPENAI_COMPATIBLE_AI_PROFILE_ID, OPENAI_COMPATIBLE_PROVIDER_ID };
export const SCHEDULED_ROOM_MODEL_POLICY_KEY = "scheduledRoom" as const;

export type PersistentAgentAiProcess =
	| "persistentRoom"
	| typeof SCHEDULED_ROOM_MODEL_POLICY_KEY
	| "checkpoint"
	| "absorb"
	| "structuralReview";

export type PersistentAgentModelLock = {
	provider: string;
	model: string;
};

export type PersistentAgentCheckpointModelPolicy =
	| { kind: "inheritPersistentRoom" }
	| { kind: "fixed"; model: PersistentAgentModelLock };

export type PersistentAgentAiProfile = {
	id: PersistentAgentAiProfileId;
	label: string;
	providerId: string;
	providerLabel: string;
	description: string;
	processes: {
		persistentRoom: PersistentAgentModelLock[];
		checkpoint: PersistentAgentCheckpointModelPolicy;
		absorb: PersistentAgentModelLock;
		structuralReview: PersistentAgentModelLock;
	};
};

// Internal fallback policy table only: used when no profile has been selected yet.
// Never present this as a user choice — the UI treats source "default" as "not configured".
export const DEFAULT_PERSISTENT_AGENT_AI_PROFILE_ID = "chatgpt-codex" satisfies PersistentAgentAiProfileId;

/**
 * Persistent-agent AI process routing source of truth.
 *
 * Update this file when a provider/profile changes model routing, for example
 * when a provider such as ChatGPT Plus/Pro exposes a newer approved model.
 *
 * Keep product-owned LLM process routing here instead of adding isolated model
 * constants in individual workflows. Future persistent-agent LLM processes such
 * as agent onboarding, specialized subagents, import/review workers, or other
 * maintenance operators should be added to this mapping first.
 *
 * This is global platform policy, not per-agent object state. Agent scaffolds
 * must not persist active profile/provider selection; runtime calls resolve it
 * from the global active profile plus these architect-owned process mappings.
 */
export const PERSISTENT_AGENT_AI_PROFILES = {
	"chatgpt-codex": {
		id: "chatgpt-codex",
		label: "ChatGPT Plus/Pro",
		providerId: "openai-codex",
		providerLabel: "ChatGPT Plus/Pro",
		description: "ChatGPT subscription profile for persistent-agent room and maintenance workflows.",
		processes: {
			persistentRoom: [
				{ provider: "openai-codex", model: "gpt-5.6-sol" },
				{ provider: "openai-codex", model: "gpt-5.6-luna" },
				{ provider: "openai-codex", model: "gpt-5.6-terra" },
				{ provider: "openai-codex", model: "gpt-5.5" },
			],
			checkpoint: { kind: "inheritPersistentRoom" },
			absorb: { provider: "openai-codex", model: "gpt-5.6-sol" },
			structuralReview: { provider: "openai-codex", model: "gpt-5.6-sol" },
		},
	},
	anthropic: {
		id: "anthropic",
		label: "Claude",
		providerId: "anthropic",
		providerLabel: "Anthropic / Claude",
		description: "Claude subscription profile for persistent-agent room and maintenance workflows.",
		processes: {
			persistentRoom: [
				{ provider: "anthropic", model: "claude-opus-5" },
				{ provider: "anthropic", model: "claude-opus-4-8" },
				{ provider: "anthropic", model: "claude-sonnet-5" },
				{ provider: "anthropic", model: "claude-fable-5" },
				{ provider: "anthropic", model: "claude-opus-4-6" },
				{ provider: "anthropic", model: "claude-opus-4-7" },
				{ provider: "anthropic", model: "claude-sonnet-4-6" },
			],
			checkpoint: { kind: "inheritPersistentRoom" },
			absorb: { provider: "anthropic", model: "claude-opus-5" },
			structuralReview: { provider: "anthropic", model: "claude-opus-5" },
		},
	},
} as const satisfies Record<BuiltInPersistentAgentAiProfileId, PersistentAgentAiProfile>;

function cloneModelLock(model: PersistentAgentModelLock): PersistentAgentModelLock {
	return { provider: model.provider, model: model.model };
}

export function persistentAgentModelLockKey(model: PersistentAgentModelLock): string {
	return `${model.provider}/${model.model}`;
}

export function persistentAgentModelLocksEqual(a: PersistentAgentModelLock, b: PersistentAgentModelLock): boolean {
	return a.provider === b.provider && a.model === b.model;
}

/**
 * A saved gateway seen as an AI profile: one profile per gateway, so several
 * gateways sit in the picker next to ChatGPT and Claude and switch the same
 * way. The gateway's provider id is the profile's provider id, which keeps the
 * provider-to-profile lookup one-to-one and keeps every room's stored
 * {provider, model} lock pointing at exactly the endpoint that answered it.
 */
export function persistentAgentAiProfileFromGateway(gateway: OpenAiCompatibleGateway): PersistentAgentAiProfile {
	const maintenanceLock = { provider: gateway.providerId, model: gateway.maintenanceModel };
	return {
		id: gateway.id,
		label: gateway.label,
		providerId: gateway.providerId,
		providerLabel: gateway.label,
		description: "Local OpenAI-compatible gateway profile for persistent-agent room and maintenance workflows.",
		processes: {
			persistentRoom: gateway.roomModels.map((model) => ({ provider: gateway.providerId, model: model.modelId })),
			checkpoint: { kind: "inheritPersistentRoom" },
			absorb: maintenanceLock,
			structuralReview: maintenanceLock,
		},
	};
}

function gatewayAiProfiles(): PersistentAgentAiProfile[] {
	return readOpenAiCompatibleGateways().gateways.map(persistentAgentAiProfileFromGateway);
}

function isBuiltInPersistentAgentAiProfileId(value: string): value is BuiltInPersistentAgentAiProfileId {
	return Object.prototype.hasOwnProperty.call(PERSISTENT_AGENT_AI_PROFILES, value);
}

// A user-approved catalog override swaps the built-in profile's model policy;
// identity (id, label, provider) stays the built-in's so nothing downstream
// changes. Removing the override returns the curated catalog.
function withBuiltInOverride(profile: PersistentAgentAiProfile, overrides: Record<string, { providerId: string; roomModels: string[]; learnModel: string; reviewMemoryModel: string }>): PersistentAgentAiProfile {
	const override = overrides[profile.id];
	if (!override) return { ...profile };
	return {
		...profile,
		processes: {
			persistentRoom: override.roomModels.map((model) => ({ provider: profile.providerId, model })),
			checkpoint: { kind: "inheritPersistentRoom" },
			absorb: { provider: profile.providerId, model: override.learnModel },
			structuralReview: { provider: profile.providerId, model: override.reviewMemoryModel },
		},
	};
}

export function getAvailablePersistentAgentAiProfiles(): PersistentAgentAiProfile[] {
	// Order matters: auto-follow picks the first signed-in profile, so built-ins
	// keep priority over saved gateways and user-created custom profiles.
	const customRead = readCustomAiProfiles();
	const profiles: PersistentAgentAiProfile[] = Object.values(PERSISTENT_AGENT_AI_PROFILES).map((profile) => withBuiltInOverride(profile, customRead.overridesByBuiltInProfileId));
	profiles.push(...gatewayAiProfiles());
	profiles.push(...customRead.profiles);
	return profiles;
}

export function isPersistentAgentAiProfileId(value: string): value is PersistentAgentAiProfileId {
	if (isBuiltInPersistentAgentAiProfileId(value)) return true;
	if (isCustomAiProfileId(value)) return readCustomAiProfiles().profiles.some((profile) => profile.id === value);
	return gatewayAiProfiles().some((profile) => profile.id === value);
}

export function getPersistentAgentAiProfile(profileId: PersistentAgentAiProfileId): PersistentAgentAiProfile {
	if (isBuiltInPersistentAgentAiProfileId(profileId)) {
		return withBuiltInOverride(PERSISTENT_AGENT_AI_PROFILES[profileId], readCustomAiProfiles().overridesByBuiltInProfileId);
	}
	const gatewayRead = readOpenAiCompatibleGateways();
	const gateway = gatewayRead.gateways.find((candidate) => candidate.id === profileId);
	if (gateway) return persistentAgentAiProfileFromGateway(gateway);
	const custom = readCustomAiProfiles().profiles.find((profile) => profile.id === profileId);
	if (custom) return custom;
	// A gateway file that exists but does not parse has to say what is wrong
	// with it. "Unknown profile" would blame the caller for the file's problem,
	// which is exactly the wrong direction to point someone in. The reverse
	// misattribution is just as bad, so this only speaks for ids that could
	// actually have been a gateway: a deleted custom profile is not the gateway
	// file's fault and must not be reported as though it were.
	const couldBeGateway = profileId === OPENAI_COMPATIBLE_AI_PROFILE_ID || profileId.startsWith(GATEWAY_PROVIDER_ID_PREFIX);
	if (couldBeGateway && gatewayRead.errors.length > 0) throw new Error(gatewayRead.errors[0]);
	throw new Error(`unknown persistent-agent AI profile: ${profileId}`);
}

export function getDefaultPersistentAgentAiProfile(): PersistentAgentAiProfile {
	return getPersistentAgentAiProfile(DEFAULT_PERSISTENT_AGENT_AI_PROFILE_ID);
}

export function getPersistentRoomModelLocks(profileId: PersistentAgentAiProfileId = DEFAULT_PERSISTENT_AGENT_AI_PROFILE_ID): PersistentAgentModelLock[] {
	return getPersistentAgentAiProfile(profileId).processes.persistentRoom.map(cloneModelLock);
}

export function getCheckpointModelPolicy(profileId: PersistentAgentAiProfileId = DEFAULT_PERSISTENT_AGENT_AI_PROFILE_ID): PersistentAgentCheckpointModelPolicy {
	const policy = getPersistentAgentAiProfile(profileId).processes.checkpoint;
	return policy.kind === "fixed"
		? { kind: "fixed", model: cloneModelLock(policy.model) }
		: { kind: "inheritPersistentRoom" };
}

export function resolveCheckpointModelLockForProfile(profileId: PersistentAgentAiProfileId, persistentRoomModel: PersistentAgentModelLock): PersistentAgentModelLock {
	const policy = getCheckpointModelPolicy(profileId);
	if (policy.kind === "inheritPersistentRoom") {
		assertPersistentRoomModelForActiveProfile(profileId, persistentRoomModel.provider, persistentRoomModel.model, "checkpoint compression inherited persistent-room model");
		return cloneModelLock(persistentRoomModel);
	}
	return cloneModelLock(policy.model);
}

export function resolveScheduledRoomModelLockForProfile(profileId: PersistentAgentAiProfileId): PersistentAgentModelLock {
	const model = getPersistentAgentAiProfile(profileId).processes.persistentRoom[0];
	if (!model) {
		throw new Error(`missing scheduledRoom model policy for active persistent-agent AI profile ${profileId}: no persistentRoom models configured`);
	}
	assertPersistentRoomModelForActiveProfile(profileId, model.provider, model.model, "scheduled-room background work");
	return cloneModelLock(model);
}

export function getAbsorbModelLock(profileId: PersistentAgentAiProfileId = DEFAULT_PERSISTENT_AGENT_AI_PROFILE_ID): PersistentAgentModelLock {
	return cloneModelLock(getPersistentAgentAiProfile(profileId).processes.absorb);
}

export function getStructuralReviewModelLock(profileId: PersistentAgentAiProfileId = DEFAULT_PERSISTENT_AGENT_AI_PROFILE_ID): PersistentAgentModelLock {
	return cloneModelLock(getPersistentAgentAiProfile(profileId).processes.structuralReview);
}

// Consult is a maintenance-class read-only worker; it rides the absorb process
// lock until profiles gain a dedicated consult policy entry.
export function getConsultModelLock(profileId: PersistentAgentAiProfileId = DEFAULT_PERSISTENT_AGENT_AI_PROFILE_ID): PersistentAgentModelLock {
	return cloneModelLock(getPersistentAgentAiProfile(profileId).processes.absorb);
}

export function isPersistentRoomModelForProfile(profileId: PersistentAgentAiProfileId, provider: string, model: string): boolean {
	return getPersistentAgentAiProfile(profileId).processes.persistentRoom.some((candidate) => candidate.provider === provider && candidate.model === model);
}

export function persistentRoomProfileIdsForModel(provider: string, model: string): PersistentAgentAiProfileId[] {
	return getAvailablePersistentAgentAiProfiles()
		.filter((profile) => isPersistentRoomModelForProfile(profile.id, provider, model))
		.map((profile) => profile.id);
}

export function isPersistentRoomModelKnown(provider: string, model: string): boolean {
	return persistentRoomProfileIdsForModel(provider, model).length > 0;
}

export function assertPersistentRoomModelForActiveProfile(profileId: PersistentAgentAiProfileId, provider: string, model: string, processLabel = "persistent-agent rooms"): void {
	if (isPersistentRoomModelForProfile(profileId, provider, model)) return;
	const knownProfiles = persistentRoomProfileIdsForModel(provider, model);
	if (knownProfiles.length > 0) throw new Error(`model is not approved for active persistent-agent AI profile ${profileId} for ${processLabel}: ${provider}/${model}`);
	throw new Error(`model is not approved for ${processLabel}: ${provider}/${model}`);
}
