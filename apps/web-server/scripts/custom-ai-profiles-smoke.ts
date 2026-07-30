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

	// ...while built-in providers take a catalog OVERRIDE: identity stays the
	// built-in's, only the model policy changes, and deleting restores curated.
	custom.writeCustomAiProfile({ providerId: "anthropic", roomModels: ["claude-haiku-4-5"], learnModel: "claude-haiku-4-5", reviewMemoryModel: "claude-haiku-4-5" }, filePath);
	const overrideRead = custom.readCustomAiProfiles(filePath);
	assert(overrideRead.overridesByBuiltInProfileId["anthropic"], "anthropic entry should register as a built-in override");
	assert(!overrideRead.profiles.some((profile) => profile.providerId === "anthropic"), "an override must not create a separate profile");
	const overridden = profiles.getPersistentAgentAiProfile("anthropic");
	assert(overridden.id === "anthropic" && overridden.label === "Claude", "override keeps the built-in identity");
	assert(overridden.processes.persistentRoom.length === 1 && overridden.processes.persistentRoom[0].model === "claude-haiku-4-5", "override replaces the room catalog");
	assert(overridden.processes.absorb.model === "claude-haiku-4-5", "override replaces the absorb lock");
	assert(!profiles.isPersistentAgentAiProfileId("custom-anthropic"), "override ids must not become selectable profiles");
	assert(custom.deleteCustomAiProfile("custom-anthropic", filePath), "override delete should succeed");
	assert(profiles.getPersistentAgentAiProfile("anthropic").processes.persistentRoom.length === 7, "deleting the override restores the curated catalog");

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
	assert(profiles.getPersistentAgentAiProfile("anthropic").processes.persistentRoom.length === 7, "built-in anthropic profile must be unaffected by file contents");

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
