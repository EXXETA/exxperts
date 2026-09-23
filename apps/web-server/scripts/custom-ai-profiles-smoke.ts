import fs from "node:fs";
import os from "node:os";
import path from "node:path";

function assert(condition: unknown, message: string): asserts condition {
	if (!condition) throw new Error(message);
}

const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), "exxperts-custom-ai-profiles-"));
process.env.HOME = tempHome;
process.env.USERPROFILE = tempHome;
process.env.EXXPERTS_CODING_AGENT_DIR = path.join(tempHome, ".exxperts", "agent");

try {
	const custom = await import("../src/custom-ai-profiles.js");
	const profiles = await import("../src/persistent-agent-ai-profiles.js");
	const profileState = await import("../src/persistent-agent-ai-profile-state.js");

	const filePath = path.join(tempHome, ".exxperts", "app", "custom-ai-profiles.json");

	// Absent file: no custom profiles, no errors, built-ins unaffected.
	const empty = custom.readCustomAiProfiles(filePath);
	assert(empty.profiles.length === 0 && empty.errors.length === 0, "absent file should yield no profiles and no errors");
	assert(!profiles.isPersistentAgentAiProfileId("custom-groq"), "custom profile id should not validate before the file exists");
	assert(profiles.getAvailablePersistentAgentAiProfiles().length === 2, "only built-ins should be available before any local profile exists");

	// Write/read roundtrip via the upsert API.
	custom.writeCustomAiProfile(
		{ providerId: "groq", label: "Groq", roomModels: ["model-a", "model-b", "model-a"], learnModel: "model-a", reviewMemoryModel: "model-b" },
		filePath,
	);
	custom.writeCustomAiProfile({ providerId: "mistral", roomModels: ["m-1"], learnModel: "m-1", reviewMemoryModel: "m-1" }, filePath);
	const loaded = custom.readCustomAiProfiles(filePath);
	assert(loaded.errors.length === 0, `roundtrip should load cleanly, got: ${loaded.errors.join(" | ")}`);
	assert(loaded.profiles.length === 2, "both custom profiles should load");
	const groq = loaded.profiles.find((profile) => profile.id === "custom-groq");
	assert(groq, "custom-groq should exist");
	assert(groq.processes.persistentRoom.length === 2, "duplicate room models should be deduped");
	assert(groq.processes.absorb.model === "model-a" && groq.processes.absorb.provider === "groq", "absorb lock should come from learnModel");
	assert(groq.processes.structuralReview.model === "model-b", "structural review lock should come from reviewMemoryModel");
	assert(groq.processes.checkpoint.kind === "inheritPersistentRoom", "checkpoint should inherit the room model");
	const mistral = loaded.profiles.find((profile) => profile.id === "custom-mistral");
	assert(mistral && mistral.label === "mistral", "label should default to the provider id");

	// Registered through the profile system + assert gate.
	assert(profiles.isPersistentAgentAiProfileId("custom-groq"), "custom profile id should validate once persisted");
	assert(
		profiles.getAvailablePersistentAgentAiProfiles().filter((profile) => profile.id.startsWith("custom-")).length === 2,
		"available profiles should include both custom profiles",
	);
	assert(profiles.isPersistentRoomModelForProfile("custom-groq", "groq", "model-b"), "approved room model should pass the profile check");
	let threw = false;
	try {
		profiles.assertPersistentRoomModelForActiveProfile("custom-groq", "groq", "model-c");
	} catch {
		threw = true;
	}
	assert(threw, "unapproved model should be rejected by the assert gate");
	assert(profiles.getAbsorbModelLock("custom-groq").model === "model-a", "absorb lock resolution should work for custom profiles");
	assert(profiles.getStructuralReviewModelLock("custom-groq").model === "model-b", "structural review lock resolution should work for custom profiles");
	assert(
		profiles.resolveCheckpointModelLockForProfile("custom-groq", { provider: "groq", model: "model-b" }).model === "model-b",
		"checkpoint should inherit an approved room model",
	);

	// Active-profile state accepts a custom profile.
	profileState.writePersistentAgentAiProfileState("custom-groq");
	const active = profileState.readPersistentAgentAiProfileState();
	assert(active.profileId === "custom-groq", "active profile state should accept a custom profile");

	// The gateway provider stays reserved (its policy file owns it)...
	let rejected = false;
	try {
		custom.writeCustomAiProfile({ providerId: "openai-compatible", roomModels: ["x"], learnModel: "x", reviewMemoryModel: "x" }, filePath);
	} catch {
		rejected = true;
	}
	assert(rejected, "reserved provider openai-compatible should be rejected on write");

	// ...and so do the built-in providers: the Claude and ChatGPT profiles have
	// no custom model list, their room list is the curated one of the release.
	rejected = false;
	try {
		custom.writeCustomAiProfile({ providerId: "anthropic", roomModels: ["claude-haiku-4-5"], learnModel: "claude-haiku-4-5", reviewMemoryModel: "claude-haiku-4-5" }, filePath);
	} catch {
		rejected = true;
	}
	assert(rejected, "built-in provider anthropic should be rejected on write");
	const curated = profiles.getPersistentAgentAiProfile("anthropic");
	const curatedRoomModels = curated.processes.persistentRoom.length;
	assert(curatedRoomModels === 10 && curated.processes.persistentRoom[0].model === "claude-opus-5-5", "the curated Claude list has ten rows with Opus 5.5 first");
	assert(curated.processes.persistentRoom.some((lock) => lock.model === "claude-haiku-4-5"), "the curated Claude list carries Haiku 4.5");
	const curatedCodex = profiles.getPersistentAgentAiProfile("chatgpt-codex");
	assert(curatedCodex.processes.persistentRoom.length === 6 && curatedCodex.processes.persistentRoom[0].model === "gpt-6-sol", "the curated ChatGPT list has six rows with GPT-6 Sol first");
	assert(!curatedCodex.processes.persistentRoom.some((lock) => lock.model === "gpt-5.5"), "gpt-5.5 has left the ChatGPT picker");

	// First start after the update: a custom list saved earlier for a built-in
	// provider is dropped, the other entries pass through untouched, nothing is
	// carried into the preference file, and the migration is idempotent.
	const migration = await import("../src/built-in-ai-profile-migration.js");
	const preferences = await import("../src/built-in-ai-profile-preferences.js");
	const preferencesPath = path.join(tempHome, ".exxperts", "app", "built-in-ai-profile-preferences.json");
	const migrationLog: string[] = [];
	fs.writeFileSync(
		filePath,
		JSON.stringify({
			version: 1,
			profiles: [
				{ id: "custom-anthropic", providerId: "anthropic", label: "Claude", roomModels: ["claude-opus-5", "claude-sonnet-5"], learnModel: "claude-sonnet-5", reviewMemoryModel: "claude-opus-5" },
				{ id: "custom-groq", providerId: "groq", label: "Groq", roomModels: ["model-a", "model-b"], learnModel: "model-a", reviewMemoryModel: "model-b", extra: "kept as written" },
			],
		}),
	);
	const migrated = migration.migrateBuiltInAiProfiles({ customProfilesPath: filePath, log: (message) => migrationLog.push(message) });
	assert(JSON.stringify(migrated.overridesDropped) === JSON.stringify(["anthropic"]) && migrated.errors.length === 0, `the anthropic override should be dropped, got ${JSON.stringify(migrated)}`);
	const afterMigration = JSON.parse(fs.readFileSync(filePath, "utf-8"));
	assert(afterMigration.version === 1 && afterMigration.profiles.length === 1 && afterMigration.profiles[0].id === "custom-groq" && afterMigration.profiles[0].extra === "kept as written", "the groq entry passes through unchanged and the anthropic entry is gone");
	assert(!fs.existsSync(preferencesPath), "nothing is carried into the preference file");
	assert(migrationLog.length === 1 && /dropped the custom model list saved for the anthropic profile/.test(migrationLog[0]), `one info line per action, got ${JSON.stringify(migrationLog)}`);
	const afterDrop = profiles.getPersistentAgentAiProfile("anthropic");
	assert(afterDrop.processes.persistentRoom.length === curatedRoomModels && afterDrop.processes.persistentRoom[0].model === "claude-opus-5-5", "after the migration the room list is the curated one");
	assert(afterDrop.processes.absorb.model === "claude-opus-5-5" && afterDrop.processes.structuralReview.model === "claude-opus-5-5", "Memorize and Review move to the curated defaults");
	const second = migration.migrateBuiltInAiProfiles({ customProfilesPath: filePath, log: (message) => migrationLog.push(message) });
	assert(second.overridesDropped.length === 0 && second.pointerCleared === null && migrationLog.length === 1, "a second run changes nothing");
	assert(JSON.stringify(JSON.parse(fs.readFileSync(filePath, "utf-8"))) === JSON.stringify(afterMigration), "a second run leaves the file as it is");
	// A built-in entry written directly into the file after the migration reads
	// back as one error and never touches the built-in profile.
	fs.writeFileSync(
		filePath,
		JSON.stringify({ version: 1, profiles: [{ id: "custom-anthropic", providerId: "anthropic", roomModels: ["claude-haiku-4-5"], learnModel: "claude-haiku-4-5", reviewMemoryModel: "claude-haiku-4-5" }] }),
	);
	const leftover = custom.readCustomAiProfiles(filePath);
	assert(leftover.profiles.length === 0 && leftover.errors.length === 1 && /managed by a built-in profile/.test(leftover.errors[0]), `a leftover built-in entry reads as one error, got ${JSON.stringify(leftover.errors)}`);
	assert(profiles.getPersistentAgentAiProfile("anthropic").processes.persistentRoom.length === curatedRoomModels, "a leftover built-in entry does not override the curated list");
	fs.rmSync(filePath, { force: true });

	// The one preference that survives: which curated model runs Memorize and Review.
	preferences.writeBuiltInAiProfilePreference("anthropic", { learnModel: "claude-sonnet-5", reviewMemoryModel: "claude-opus-5-5" });
	assert(fs.existsSync(preferencesPath), "the preference file is written");
	// Windows has no POSIX file modes, so the mode check runs where modes exist.
	if (process.platform !== "win32") assert((fs.statSync(preferencesPath).mode & 0o777) === 0o600, "the preference file is written with mode 0600");
	const preferred = profiles.getPersistentAgentAiProfile("anthropic");
	assert(preferred.processes.absorb.model === "claude-sonnet-5" && preferred.processes.structuralReview.model === "claude-opus-5-5", "the preference picks Memorize and Review");
	assert(preferred.processes.persistentRoom.length === curatedRoomModels && preferred.id === "anthropic" && preferred.label === "Claude", "the preference leaves the room list and the identity alone");
	assert(profiles.getAbsorbModelLock("anthropic").model === "claude-sonnet-5", "absorb lock resolution follows the preference");
	preferences.writeBuiltInAiProfilePreference("anthropic", { learnModel: "claude-nowhere", reviewMemoryModel: "claude-sonnet-5" });
	const partlyStale = profiles.getPersistentAgentAiProfile("anthropic");
	assert(partlyStale.processes.absorb.model === "claude-opus-5-5" && partlyStale.processes.structuralReview.model === "claude-sonnet-5", "a chosen model outside the curated list falls back to the curated default silently");
	assert(preferences.readBuiltInAiProfilePreferences(preferencesPath).errors.length === 0, "a stale choice is not an error");
	assert(preferences.clearBuiltInAiProfilePreference("anthropic") && !preferences.clearBuiltInAiProfilePreference("anthropic"), "clear reports what it removed");
	assert(profiles.getPersistentAgentAiProfile("anthropic").processes.absorb.model === "claude-opus-5-5", "clearing the preference returns the curated default");
	assert(!fs.existsSync(preferencesPath), "clearing the last preference removes the file");
	preferences.writeBuiltInAiProfilePreference("anthropic", { learnModel: "claude-sonnet-5" });
	assert(fs.existsSync(preferencesPath), "a preference writes the file");
	preferences.writeBuiltInAiProfilePreference("anthropic", {});
	assert(!fs.existsSync(preferencesPath), "a write that empties the map removes the file");
	fs.writeFileSync(preferencesPath, "{not json");
	const unreadable = preferences.readBuiltInAiProfilePreferences(preferencesPath);
	assert(Object.keys(unreadable.profiles).length === 0 && unreadable.errors.length === 1, "an unreadable preference file reads as empty with one error");
	fs.writeFileSync(preferencesPath, JSON.stringify({ version: 2, profiles: {} }));
	assert(preferences.readBuiltInAiProfilePreferences(preferencesPath).errors.length === 1, "a wrongly versioned preference file reads as empty with one error");
	assert(profiles.getPersistentAgentAiProfile("anthropic").processes.absorb.model === "claude-opus-5-5", "a broken preference file leaves the curated defaults in force");
	fs.rmSync(preferencesPath, { force: true });

	// A saved active-profile pointer that names a profile which no longer exists is cleared.
	const pointerPath = path.join(tempHome, ".exxperts", "app", "persistent-agent-ai-profile.json");
	const gatewaysPath = path.join(tempHome, ".exxperts", "app", "openai-compatible-gateways.json");
	const pointerCase = (profileId: string) => {
		fs.writeFileSync(pointerPath, JSON.stringify({ profileId }));
		return migration.migrateBuiltInAiProfiles({ customProfilesPath: filePath, log: () => {} });
	};
	assert(pointerCase("custom-x").pointerCleared === "custom-x" && !fs.existsSync(pointerPath), "a custom id with no entry is cleared");
	assert(pointerCase("anthropic").pointerCleared === null && fs.existsSync(pointerPath), "a built-in id is kept");
	assert(pointerCase("custom-github-copilot").pointerCleared === "custom-github-copilot" && !fs.existsSync(pointerPath), "the stale copilot pointer is cleared");
	custom.writeCustomAiProfile({ providerId: "groq", roomModels: ["model-a"], learnModel: "model-a", reviewMemoryModel: "model-a" }, filePath);
	assert(pointerCase("custom-groq").pointerCleared === null && fs.existsSync(pointerPath), "a custom id with an entry is kept");
	fs.writeFileSync(filePath, "{not json");
	assert(pointerCase("custom-groq").pointerCleared === null && fs.existsSync(pointerPath), "an unreadable custom-profiles file keeps the pointer");
	fs.rmSync(filePath, { force: true });
	const gateways = await import("../src/openai-compatible-gateways.js");
	const savedGateway = gateways.writeOpenAiCompatibleGateway({ id: "gateway-synthetic", providerId: "gateway-synthetic", label: "Synthetic Gateway", baseUrl: "http://127.0.0.1:9/v1", roomModels: [{ modelId: "m" }], maintenanceModel: "m" });
	assert(pointerCase(savedGateway.id).pointerCleared === null && fs.existsSync(pointerPath), "a gateway id present in the store is kept");
	assert(pointerCase("gateway-nowhere").pointerCleared === "gateway-nowhere" && !fs.existsSync(pointerPath), "a gateway id absent from a clean store is cleared");
	const gatewayJson = fs.readFileSync(gatewaysPath, "utf-8");
	fs.writeFileSync(gatewaysPath, "{not json");
	assert(pointerCase("gateway-nowhere").pointerCleared === null && fs.existsSync(pointerPath), "an unreadable gateway store keeps the pointer");
	fs.writeFileSync(gatewaysPath, gatewayJson);
	fs.rmSync(pointerPath, { force: true });
	fs.rmSync(gatewaysPath, { force: true });

	// Hand-crafted bad entries: skipped with errors, good entries survive.
	fs.writeFileSync(
		filePath,
		JSON.stringify({
			version: 1,
			profiles: [
				{ id: "custom-groq", providerId: "groq", roomModels: ["model-a"], learnModel: "model-a", reviewMemoryModel: "model-a" },
				{ id: "anthropic", providerId: "anthropic", roomModels: ["claude-x"], learnModel: "claude-x", reviewMemoryModel: "claude-x" },
				{ id: "wrong-id", providerId: "xai", roomModels: ["grok"], learnModel: "grok", reviewMemoryModel: "grok" },
				{ id: "custom-groq", providerId: "groq", roomModels: ["model-z"], learnModel: "model-z", reviewMemoryModel: "model-z" },
				{ id: "custom-deepseek", providerId: "deepseek", roomModels: [], learnModel: "d", reviewMemoryModel: "d" },
			],
		}),
	);
	const mixed = custom.readCustomAiProfiles(filePath);
	assert(mixed.profiles.length === 1 && mixed.profiles[0].id === "custom-groq", "only the valid entry should survive");
	assert(mixed.errors.length === 4, `each invalid entry should produce an error, got ${mixed.errors.length}`);
	assert(profiles.getPersistentAgentAiProfile("anthropic").processes.persistentRoom.length === curatedRoomModels, "built-in anthropic profile must be unaffected by file contents");

	// Corrupt JSON: no throw, surfaced as error, built-ins unaffected.
	fs.writeFileSync(filePath, "{not json");
	const corrupt = custom.readCustomAiProfiles(filePath);
	assert(corrupt.profiles.length === 0 && corrupt.errors.length === 1, "corrupt file should be ignored with one error");
	assert(profiles.getAvailablePersistentAgentAiProfiles().length === 2, "built-ins should remain with a corrupt custom file");
	const fallback = profileState.readPersistentAgentAiProfileState();
	assert(fallback.profileId !== "custom-groq", "active state must fall back when the custom profile disappears");

	// Delete removes only the targeted profile.
	custom.writeCustomAiProfile({ providerId: "groq", roomModels: ["model-a"], learnModel: "model-a", reviewMemoryModel: "model-a" }, filePath);
	custom.writeCustomAiProfile({ providerId: "xai", roomModels: ["grok"], learnModel: "grok", reviewMemoryModel: "grok" }, filePath);
	assert(custom.deleteCustomAiProfile("custom-groq", filePath), "delete should report success for an existing profile");
	assert(!custom.deleteCustomAiProfile("custom-groq", filePath), "delete should report false for a missing profile");
	const afterDelete = custom.readCustomAiProfiles(filePath);
	assert(afterDelete.profiles.length === 1 && afterDelete.profiles[0].id === "custom-xai", "delete should keep the other profile");

	console.log("custom AI profiles smoke passed");
} finally {
	fs.rmSync(tempHome, { recursive: true, force: true });
}
