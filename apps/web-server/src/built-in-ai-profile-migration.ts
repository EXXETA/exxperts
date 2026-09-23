import fs from "node:fs";
import path from "node:path";
import { builtInProfileIdForProvider, CUSTOM_AI_PROFILES_FILE, isCustomAiProfileId, readCustomAiProfiles } from "./custom-ai-profiles.js";
import { GATEWAY_PROVIDER_ID_PREFIX, OPENAI_COMPATIBLE_AI_PROFILE_ID, readOpenAiCompatibleGateways } from "./openai-compatible-gateways.js";
import { clearSavedPersistentAgentAiProfileState, readSavedPersistentAgentAiProfileId } from "./persistent-agent-ai-profile-state.js";
import { isBuiltInPersistentAgentAiProfileId } from "./persistent-agent-ai-profiles.js";

/**
 * First start after the update (0.13.2): the Claude and ChatGPT profiles no
 * longer carry a custom model list, so a list saved earlier for one of them
 * in custom-ai-profiles.json is dropped and nothing is carried over; Memorize
 * and Review move to the current defaults with the list. A saved
 * active-profile pointer that names a profile which no longer exists is
 * cleared, so the state follows the signed-in provider instead of reporting
 * an unknown profile on every visit.
 *
 * Runs at server start before the first status read. Idempotent, every step
 * guarded: a failure is logged and never blocks the start, and nothing is
 * shown in the UI. Rooms whose conversation runs on a delisted model are not
 * touched; a saved conversation keeps its model.
 */
export type BuiltInAiProfileMigrationResult = {
	overridesDropped: string[];
	pointerCleared: string | null;
	errors: string[];
};

export type BuiltInAiProfileMigrationOptions = {
	customProfilesPath?: string;
	log?: (message: string) => void;
};

function isObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

// Removes every entry whose provider belongs to a built-in profile and passes
// the other entries through as they were. The file is rewritten only when an
// entry was removed; a file that does not parse or has another shape is left
// alone and keeps being reported by the read path as today.
function dropBuiltInOverrides(filePath: string): string[] {
	if (!fs.existsSync(filePath)) return [];
	let raw: unknown;
	try {
		raw = JSON.parse(fs.readFileSync(filePath, "utf-8"));
	} catch {
		return [];
	}
	if (!isObject(raw) || raw.version !== 1 || !Array.isArray(raw.profiles)) return [];
	const dropped: string[] = [];
	const kept = raw.profiles.filter((entry) => {
		const providerId = isObject(entry) && typeof entry.providerId === "string" ? entry.providerId.trim() : "";
		const builtInProfileId = providerId ? builtInProfileIdForProvider(providerId) : null;
		if (!builtInProfileId) return true;
		dropped.push(builtInProfileId);
		return false;
	});
	if (dropped.length === 0) return [];
	const payload = { ...raw, profiles: kept };
	fs.mkdirSync(path.dirname(filePath), { recursive: true });
	const tmpPath = `${filePath}.${process.pid}.tmp`;
	fs.writeFileSync(tmpPath, `${JSON.stringify(payload, null, "\t")}\n`, { mode: 0o600 });
	fs.renameSync(tmpPath, filePath);
	return dropped;
}

// A pointer is stale when it names a custom profile with no entry in a cleanly
// read custom-profiles file, or a gateway absent from a gateway store that read
// without errors. A built-in id is always valid. An unreadable store keeps the
// pointer: the profile may be in there.
function pointerIsStale(profileId: string, customProfilesPath: string): boolean {
	if (isBuiltInPersistentAgentAiProfileId(profileId)) return false;
	if (isCustomAiProfileId(profileId)) {
		const customRead = readCustomAiProfiles(customProfilesPath);
		if (customRead.errors.length > 0) return false;
		return !customRead.profiles.some((profile) => profile.id === profileId);
	}
	const couldBeGateway = profileId === OPENAI_COMPATIBLE_AI_PROFILE_ID || profileId.startsWith(GATEWAY_PROVIDER_ID_PREFIX);
	if (!couldBeGateway) return true;
	const gatewayRead = readOpenAiCompatibleGateways();
	if (gatewayRead.unreadable || gatewayRead.errors.length > 0) return false;
	return !gatewayRead.gateways.some((gateway) => gateway.id === profileId);
}

export function migrateBuiltInAiProfiles(options: BuiltInAiProfileMigrationOptions = {}): BuiltInAiProfileMigrationResult {
	const customProfilesPath = options.customProfilesPath ?? CUSTOM_AI_PROFILES_FILE;
	const log = options.log ?? (() => {});
	const result: BuiltInAiProfileMigrationResult = { overridesDropped: [], pointerCleared: null, errors: [] };
	try {
		result.overridesDropped = dropBuiltInOverrides(customProfilesPath);
		for (const profileId of result.overridesDropped) log(`built-in AI profile migration: dropped the custom model list saved for the ${profileId} profile; the curated list applies`);
	} catch (e) {
		result.errors.push(`custom model lists: ${(e as Error).message}`);
	}
	try {
		const savedProfileId = readSavedPersistentAgentAiProfileId();
		if (savedProfileId && pointerIsStale(savedProfileId, customProfilesPath) && clearSavedPersistentAgentAiProfileState()) {
			result.pointerCleared = savedProfileId;
			log(`built-in AI profile migration: cleared the saved AI profile choice ${savedProfileId}, a profile that no longer exists; the signed-in profile applies`);
		}
	} catch (e) {
		result.errors.push(`saved AI profile choice: ${(e as Error).message}`);
	}
	for (const error of result.errors) log(`built-in AI profile migration: ${error}`);
	return result;
}
