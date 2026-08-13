import fs from "node:fs";
import path from "node:path";
import { productAppStatePath } from "../../../pi-package/product-state-paths.js";
import { PERSISTENT_AGENT_AI_PROFILES } from "./persistent-agent-ai-profiles.js";
import type { PersistentAgentAiProfile } from "./persistent-agent-ai-profiles.js";
import { OPENAI_COMPATIBLE_PROVIDER_ID, readOpenAiCompatibleGateways } from "./openai-compatible-gateways.js";

export const CUSTOM_AI_PROFILES_FILE = productAppStatePath("custom-ai-profiles.json");
export const CUSTOM_AI_PROFILE_ID_PREFIX = "custom-";
const CUSTOM_AI_PROFILES_VERSION = 1;

// A gateway's model policy is owned by the gateway store, which already gives
// it a profile of its own; everything else may carry a custom entry. For
// built-in providers the entry acts as an OVERRIDE of the curated catalog (the
// built-in profile keeps its id/label), for any other provider it creates a
// standalone custom profile. Lazy because this module and the profiles module
// import each other; bindings resolve by call time.
export function isReservedCustomProfileProvider(providerId: string, gatewayProviderIds?: ReadonlySet<string>): boolean {
	// The default gateway's provider id is reserved even before any gateway is
	// saved, so a custom profile can never claim the name a later gateway setup
	// needs back.
	if (providerId === OPENAI_COMPATIBLE_PROVIDER_ID) return true;
	// The set is passed in by callers that check many providers at once; reading
	// the gateway store once per provider is a file read per row of a list.
	const gateways = gatewayProviderIds ?? savedGatewayProviderIds();
	return gateways.has(providerId);
}

function savedGatewayProviderIds(): ReadonlySet<string> {
	return new Set(readOpenAiCompatibleGateways().gateways.map((gateway) => gateway.providerId));
}

// The built-in profile id a provider belongs to, or null for regular providers.
export function builtInProfileIdForProvider(providerId: string): string | null {
	for (const profile of Object.values(PERSISTENT_AGENT_AI_PROFILES)) {
		if (profile.providerId === providerId) return profile.id;
	}
	return null;
}

export type CustomAiProfileEntry = {
	id: string;
	providerId: string;
	label: string;
	roomModels: string[];
	learnModel: string;
	reviewMemoryModel: string;
};

export type CustomAiProfilesReadResult = {
	profiles: PersistentAgentAiProfile[];
	entries: CustomAiProfileEntry[];
	// Built-in catalog overrides, keyed by the built-in profile id.
	overridesByBuiltInProfileId: Record<string, CustomAiProfileEntry>;
	errors: string[];
	path: string;
};

function isObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nonEmptyString(value: unknown): string | undefined {
	if (typeof value !== "string") return undefined;
	const trimmed = value.trim();
	return trimmed || undefined;
}

export function customAiProfileIdForProvider(providerId: string): string {
	return `${CUSTOM_AI_PROFILE_ID_PREFIX}${providerId}`;
}

export function isCustomAiProfileId(profileId: string): boolean {
	return profileId.startsWith(CUSTOM_AI_PROFILE_ID_PREFIX);
}

function parseEntry(raw: unknown, index: number, gatewayProviderIds: ReadonlySet<string>): { entry?: CustomAiProfileEntry; error?: string } {
	if (!isObject(raw)) return { error: `profiles[${index}] must be a JSON object.` };
	const providerId = nonEmptyString(raw.providerId);
	if (!providerId) return { error: `profiles[${index}].providerId is required.` };
	const id = nonEmptyString(raw.id);
	if (id !== customAiProfileIdForProvider(providerId)) {
		return { error: `profiles[${index}].id must be "${customAiProfileIdForProvider(providerId)}".` };
	}
	if (isReservedCustomProfileProvider(providerId, gatewayProviderIds)) {
		return { error: `profiles[${index}] provider "${providerId}" is managed by a built-in profile.` };
	}
	if (!Array.isArray(raw.roomModels) || raw.roomModels.length === 0) {
		return { error: `profiles[${index}].roomModels must include at least one model.` };
	}
	const roomModels: string[] = [];
	const seen = new Set<string>();
	for (const [modelIndex, value] of raw.roomModels.entries()) {
		const modelId = nonEmptyString(value);
		if (!modelId) return { error: `profiles[${index}].roomModels[${modelIndex}] must be a non-empty string.` };
		if (seen.has(modelId)) continue;
		seen.add(modelId);
		roomModels.push(modelId);
	}
	const learnModel = nonEmptyString(raw.learnModel);
	if (!learnModel) return { error: `profiles[${index}].learnModel is required.` };
	const reviewMemoryModel = nonEmptyString(raw.reviewMemoryModel);
	if (!reviewMemoryModel) return { error: `profiles[${index}].reviewMemoryModel is required.` };
	const label = nonEmptyString(raw.label) ?? providerId;
	return { entry: { id, providerId, label, roomModels, learnModel, reviewMemoryModel } };
}

export function customAiProfileFromEntry(entry: CustomAiProfileEntry): PersistentAgentAiProfile {
	return {
		id: entry.id,
		label: entry.label,
		providerId: entry.providerId,
		providerLabel: entry.label,
		description: "User-configured provider profile for persistent-agent room and maintenance workflows.",
		processes: {
			persistentRoom: entry.roomModels.map((modelId) => ({ provider: entry.providerId, model: modelId })),
			checkpoint: { kind: "inheritPersistentRoom" },
			absorb: { provider: entry.providerId, model: entry.learnModel },
			structuralReview: { provider: entry.providerId, model: entry.reviewMemoryModel },
		},
	};
}

export function readCustomAiProfiles(filePath = CUSTOM_AI_PROFILES_FILE): CustomAiProfilesReadResult {
	const result: CustomAiProfilesReadResult = { profiles: [], entries: [], overridesByBuiltInProfileId: {}, errors: [], path: filePath };
	let raw: unknown;
	try {
		if (!fs.existsSync(filePath)) return result;
		raw = JSON.parse(fs.readFileSync(filePath, "utf-8"));
	} catch {
		result.errors.push("Custom AI profiles file could not be read; ignoring it.");
		return result;
	}
	if (!isObject(raw) || raw.version !== CUSTOM_AI_PROFILES_VERSION || !Array.isArray(raw.profiles)) {
		result.errors.push("Custom AI profiles file has an unsupported format; ignoring it.");
		return result;
	}
	const seenProviders = new Set<string>();
	// One gateway-store read for the whole file, not one per entry.
	const gatewayProviderIds = savedGatewayProviderIds();
	for (const [index, value] of raw.profiles.entries()) {
		const { entry, error } = parseEntry(value, index, gatewayProviderIds);
		if (!entry) {
			if (error) result.errors.push(error);
			continue;
		}
		if (seenProviders.has(entry.providerId)) {
			result.errors.push(`profiles[${index}] duplicates provider "${entry.providerId}"; keeping the first entry.`);
			continue;
		}
		seenProviders.add(entry.providerId);
		result.entries.push(entry);
	}
	result.entries.sort((a, b) => a.id.localeCompare(b.id));
	for (const entry of result.entries) {
		const builtInProfileId = builtInProfileIdForProvider(entry.providerId);
		if (builtInProfileId) result.overridesByBuiltInProfileId[builtInProfileId] = entry;
		else result.profiles.push(customAiProfileFromEntry(entry));
	}
	return result;
}

function writeCustomAiProfilesFile(entries: CustomAiProfileEntry[], filePath: string): void {
	const payload = { version: CUSTOM_AI_PROFILES_VERSION, profiles: entries };
	fs.mkdirSync(path.dirname(filePath), { recursive: true });
	const tmpPath = `${filePath}.${process.pid}.tmp`;
	fs.writeFileSync(tmpPath, `${JSON.stringify(payload, null, "\t")}\n`, { mode: 0o600 });
	fs.renameSync(tmpPath, filePath);
}

export type CustomAiProfileInput = {
	providerId: string;
	label?: string;
	roomModels: string[];
	learnModel: string;
	reviewMemoryModel: string;
};

/**
 * Upsert the custom profile for a provider. Schema-level validation only;
 * callers are responsible for registry-level checks (provider is a login
 * provider, models exist) before persisting user input.
 */
export function writeCustomAiProfile(input: CustomAiProfileInput, filePath = CUSTOM_AI_PROFILES_FILE): CustomAiProfileEntry {
	const providerId = nonEmptyString(input.providerId);
	if (!providerId) throw new Error("providerId is required");
	if (isReservedCustomProfileProvider(providerId)) {
		throw new Error(`provider "${providerId}" is managed by a built-in profile`);
	}
	const roomModels: string[] = [];
	const seen = new Set<string>();
	for (const value of input.roomModels ?? []) {
		const modelId = nonEmptyString(value);
		if (!modelId) throw new Error("roomModels entries must be non-empty strings");
		if (seen.has(modelId)) continue;
		seen.add(modelId);
		roomModels.push(modelId);
	}
	if (roomModels.length === 0) throw new Error("at least one room model is required");
	const learnModel = nonEmptyString(input.learnModel);
	if (!learnModel) throw new Error("learnModel is required");
	const reviewMemoryModel = nonEmptyString(input.reviewMemoryModel);
	if (!reviewMemoryModel) throw new Error("reviewMemoryModel is required");
	const entry: CustomAiProfileEntry = {
		id: customAiProfileIdForProvider(providerId),
		providerId,
		label: nonEmptyString(input.label) ?? providerId,
		roomModels,
		learnModel,
		reviewMemoryModel,
	};
	const existing = readCustomAiProfiles(filePath).entries.filter((candidate) => candidate.providerId !== providerId);
	existing.push(entry);
	existing.sort((a, b) => a.id.localeCompare(b.id));
	writeCustomAiProfilesFile(existing, filePath);
	return entry;
}

export function deleteCustomAiProfile(profileId: string, filePath = CUSTOM_AI_PROFILES_FILE): boolean {
	const existing = readCustomAiProfiles(filePath).entries;
	const remaining = existing.filter((candidate) => candidate.id !== profileId);
	if (remaining.length === existing.length) return false;
	writeCustomAiProfilesFile(remaining, filePath);
	return true;
}
