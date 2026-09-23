import fs from "node:fs";
import path from "node:path";
import { productAppStatePath } from "../../../pi-package/product-state-paths.js";

// The one thing a person may keep on a built-in profile: which curated model
// runs Memorize and which runs Review. The room list itself is never stored,
// it is the curated list of the release, so an update can never be hidden
// behind a saved copy of an older list.
//
// A file of its own rather than a second shape inside custom-ai-profiles.json:
// that file holds whole profiles for providers that have nothing else, while
// this is two optional fields on a profile that exists without any file. An
// older build never looks for this file and keeps parsing the other one.
export const BUILT_IN_AI_PROFILE_PREFERENCES_FILE = productAppStatePath("built-in-ai-profile-preferences.json");
const BUILT_IN_AI_PROFILE_PREFERENCES_VERSION = 1;

export type BuiltInAiProfilePreference = {
	learnModel?: string;
	reviewMemoryModel?: string;
};

export type BuiltInAiProfilePreferencesReadResult = {
	// Keyed by built-in profile id. A missing profile or field means the curated default.
	profiles: Record<string, BuiltInAiProfilePreference>;
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

function parsePreference(raw: unknown): BuiltInAiProfilePreference | null {
	if (!isObject(raw)) return null;
	const preference: BuiltInAiProfilePreference = {};
	const learnModel = nonEmptyString(raw.learnModel);
	if (learnModel) preference.learnModel = learnModel;
	const reviewMemoryModel = nonEmptyString(raw.reviewMemoryModel);
	if (reviewMemoryModel) preference.reviewMemoryModel = reviewMemoryModel;
	return preference;
}

export function readBuiltInAiProfilePreferences(filePath = BUILT_IN_AI_PROFILE_PREFERENCES_FILE): BuiltInAiProfilePreferencesReadResult {
	const result: BuiltInAiProfilePreferencesReadResult = { profiles: {}, errors: [], path: filePath };
	let raw: unknown;
	try {
		if (!fs.existsSync(filePath)) return result;
		raw = JSON.parse(fs.readFileSync(filePath, "utf-8"));
	} catch {
		result.errors.push("Built-in AI profile preferences file could not be read; using the curated defaults.");
		return result;
	}
	if (!isObject(raw) || raw.version !== BUILT_IN_AI_PROFILE_PREFERENCES_VERSION || !isObject(raw.profiles)) {
		result.errors.push("Built-in AI profile preferences file has an unsupported format; using the curated defaults.");
		return result;
	}
	for (const [profileId, value] of Object.entries(raw.profiles)) {
		const preference = parsePreference(value);
		if (preference && Object.keys(preference).length > 0) result.profiles[profileId] = preference;
	}
	return result;
}

function writeBuiltInAiProfilePreferencesFile(profiles: Record<string, BuiltInAiProfilePreference>, filePath: string): void {
	// Nothing left to keep: no file, which the read path treats as no preference.
	if (Object.keys(profiles).length === 0) {
		fs.rmSync(filePath, { force: true });
		return;
	}
	const payload = { version: BUILT_IN_AI_PROFILE_PREFERENCES_VERSION, profiles };
	fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
	const tmpPath = `${filePath}.${process.pid}.tmp`;
	fs.writeFileSync(tmpPath, `${JSON.stringify(payload, null, "\t")}\n`, { mode: 0o600 });
	fs.renameSync(tmpPath, filePath);
}

/**
 * Save the Memorize and Review choice for one built-in profile. Schema-level
 * only: the caller checks that both models are on the profile's curated list.
 */
export function writeBuiltInAiProfilePreference(profileId: string, preference: BuiltInAiProfilePreference, filePath = BUILT_IN_AI_PROFILE_PREFERENCES_FILE): BuiltInAiProfilePreference {
	const id = nonEmptyString(profileId);
	if (!id) throw new Error("profileId is required");
	const next: BuiltInAiProfilePreference = {};
	const learnModel = nonEmptyString(preference.learnModel);
	if (learnModel) next.learnModel = learnModel;
	const reviewMemoryModel = nonEmptyString(preference.reviewMemoryModel);
	if (reviewMemoryModel) next.reviewMemoryModel = reviewMemoryModel;
	const profiles = { ...readBuiltInAiProfilePreferences(filePath).profiles };
	if (Object.keys(next).length === 0) delete profiles[id];
	else profiles[id] = next;
	writeBuiltInAiProfilePreferencesFile(profiles, filePath);
	return next;
}

export function clearBuiltInAiProfilePreference(profileId: string, filePath = BUILT_IN_AI_PROFILE_PREFERENCES_FILE): boolean {
	const profiles = { ...readBuiltInAiProfilePreferences(filePath).profiles };
	if (!(profileId in profiles)) return false;
	delete profiles[profileId];
	writeBuiltInAiProfilePreferencesFile(profiles, filePath);
	return true;
}
