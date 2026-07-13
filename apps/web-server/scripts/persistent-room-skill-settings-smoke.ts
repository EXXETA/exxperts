import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "exxeta-skill-settings-"));
process.env.EXXETA_PERSISTENT_AGENTS_ROOT = root;

const {
	persistentRoomSkillSettingsPath,
	readPersistentRoomSkillSettings,
	enablePersistentRoomSkill,
	disablePersistentRoomSkill,
	computeSkillStatuses,
	effectiveEnabledSkills,
} = await import("../src/persistent-room-skill-settings.js");
const { sha256 } = await import("../src/skills-store.js");

const agentId = "skill-settings-smoke-room";

function assert(condition: unknown, message: string): asserts condition {
	if (!condition) throw new Error(message);
}

// A mutable stand-in for the canonical library: the injected resolver reads
// CURRENT bodies from it, so mutating a body simulates an upstream/local edit
// and deleting one simulates a library removal — exactly the seam the API's
// `skillLibraryBody` resolver plugs into.
const library = new Map<string, string>([
	["cite-sources", "Always cite your sources before answering."],
	["summarize-first", "Open with a one-line summary, then details."],
]);
const resolveBody = (name: string): string | null => (library.has(name) ? library.get(name)! : null);

try {
	// Default: empty enabled set, no file created by reading.
	const initial = readPersistentRoomSkillSettings(agentId);
	assert(initial.schemaVersion === 1, "default schemaVersion must be 1");
	assert(Array.isArray(initial.enabledSkills) && initial.enabledSkills.length === 0, "default enabled set must be empty");
	assert(!fs.existsSync(persistentRoomSkillSettingsPath(agentId)), "read must not create the settings file");

	// Enable pins sha256(current body), computed server-side from the resolver.
	const enabled = enablePersistentRoomSkill(agentId, "cite-sources", resolveBody, {}, new Date("2026-07-11T09:00:00.000Z"));
	assert(enabled.ok, "enabling a library skill should succeed");
	assert(enabled.settings.enabledSkills.length === 1, "one skill should be enabled");
	assert(enabled.settings.enabledSkills[0].name === "cite-sources", "the enabled skill name should be recorded");
	assert(enabled.settings.enabledSkills[0].sha256 === sha256(library.get("cite-sources")!), "enable should pin sha256 of the CURRENT body");
	assert(enabled.settings.updatedAt === "2026-07-11T09:00:00.000Z", "enable should stamp updatedAt");

	// Settings survive a reload; file lives under the room runtime dir at 0600.
	const settingsPath = persistentRoomSkillSettingsPath(agentId);
	assert(settingsPath === path.join(root, agentId, "runtime", "skill-settings.json"), "settings file should live under the room runtime dir");
	const reread = readPersistentRoomSkillSettings(agentId);
	assert(reread.enabledSkills.length === 1 && reread.enabledSkills[0].name === "cite-sources", "reread should see the persisted enablement");
	assert(reread.enabledSkills[0].sha256 === enabled.settings.enabledSkills[0].sha256, "reread should preserve the pinned hash");
	if (process.platform !== "win32") {
		const mode = fs.statSync(settingsPath).mode & 0o777;
		assert(mode === 0o600, `settings file should be 0600, got ${mode.toString(8)}`);
	}

	// A second enable adds, does not duplicate; the set is deduped + sorted.
	enablePersistentRoomSkill(agentId, "summarize-first", resolveBody);
	const both = readPersistentRoomSkillSettings(agentId);
	assert(both.enabledSkills.length === 2, "enabling a second skill should add it");
	assert(both.enabledSkills.map((s) => s.name).join(",") === "cite-sources,summarize-first", "enabled skills should be sorted by name");

	// All ok → both are in the effective set.
	const okStatuses = computeSkillStatuses(both.enabledSkills, resolveBody);
	assert(okStatuses.every((s) => s.status === "ok"), "unchanged skills should report ok");
	assert(effectiveEnabledSkills(both.enabledSkills, resolveBody).length === 2, "the effective set should hold both ok skills");

	// Body change flips state to hash-mismatch and drops the skill from the effective set.
	library.set("cite-sources", "Always cite sources AND provide a confidence level.");
	const drifted = computeSkillStatuses(readPersistentRoomSkillSettings(agentId).enabledSkills, resolveBody);
	const citeDrift = drifted.find((s) => s.name === "cite-sources");
	assert(citeDrift?.status === "hash-mismatch", "a changed body should report hash-mismatch");
	assert(citeDrift?.currentSha256 === sha256(library.get("cite-sources")!), "hash-mismatch should surface the current body hash");
	const effectiveAfterDrift = effectiveEnabledSkills(readPersistentRoomSkillSettings(agentId).enabledSkills, resolveBody);
	assert(effectiveAfterDrift.length === 1 && effectiveAfterDrift[0].name === "summarize-first", "a mismatched skill must be dropped from the effective set");

	// Re-enabling (re-review) re-pins the new hash and clears the mismatch.
	const repinned = enablePersistentRoomSkill(agentId, "cite-sources", resolveBody);
	assert(repinned.ok, "re-enabling should succeed");
	const cleared = computeSkillStatuses(readPersistentRoomSkillSettings(agentId).enabledSkills, resolveBody);
	assert(cleared.find((s) => s.name === "cite-sources")?.status === "ok", "re-enabling should re-pin the new hash and clear the mismatch");
	assert(effectiveEnabledSkills(readPersistentRoomSkillSettings(agentId).enabledSkills, resolveBody).length === 2, "re-pinned skill returns to the effective set");

	// Delete from the library → the enabled skill reports missing and is excluded.
	library.delete("summarize-first");
	const afterDelete = computeSkillStatuses(readPersistentRoomSkillSettings(agentId).enabledSkills, resolveBody);
	const gone = afterDelete.find((s) => s.name === "summarize-first");
	assert(gone?.status === "missing" && gone.currentSha256 === null, "a deleted library skill should report missing");
	assert(effectiveEnabledSkills(readPersistentRoomSkillSettings(agentId).enabledSkills, resolveBody).length === 1, "a missing skill must be excluded from the effective set");

	// Disable removes the skill; disabling an absent one is an idempotent no-op.
	const disabled = disablePersistentRoomSkill(agentId, "summarize-first");
	assert(disabled.ok && disabled.settings.enabledSkills.every((s) => s.name !== "summarize-first"), "disable should remove the skill");
	const noop = disablePersistentRoomSkill(agentId, "summarize-first");
	assert(noop.ok && noop.settings.enabledSkills.length === disabled.settings.enabledSkills.length, "disabling an absent skill should be a no-op");

	// Validation: unknown skill and invalid names are rejected (the API maps these to 4xx).
	const unknown = enablePersistentRoomSkill(agentId, "does-not-exist", resolveBody);
	assert(!unknown.ok && unknown.reason === "unknown-skill", "enabling an unknown library skill must be rejected");
	const badName = enablePersistentRoomSkill(agentId, "Not A Valid Name", resolveBody);
	assert(!badName.ok && badName.reason === "invalid-name", "an invalid skill name must be rejected before any library lookup");
	assert(!disablePersistentRoomSkill(agentId, "../escape").ok, "a path-escaping name must be rejected");
	let threwId = false;
	try {
		readPersistentRoomSkillSettings("../escape");
	} catch (error) {
		threwId = /invalid persistent-room agent id/.test((error as Error).message);
	}
	assert(threwId, "path-escaping agent ids should be rejected");

	// Malformed settings file falls back safely to an empty enabled set.
	fs.writeFileSync(persistentRoomSkillSettingsPath(agentId), "not json", "utf-8");
	assert(readPersistentRoomSkillSettings(agentId).enabledSkills.length === 0, "corrupt settings should fall back to an empty enabled set");
	// A file with a foreign schemaVersion or malformed entries also degrades safely.
	fs.writeFileSync(
		persistentRoomSkillSettingsPath(agentId),
		JSON.stringify({ schemaVersion: 1, enabledSkills: [{ name: "cite-sources", sha256: "short" }, { name: "Bad Name", sha256: sha256("x") }, "junk"], updatedAt: "" }),
		"utf-8",
	);
	assert(readPersistentRoomSkillSettings(agentId).enabledSkills.length === 0, "malformed enabled-skill entries should be dropped on read");

	fs.rmSync(root, { recursive: true, force: true });
	console.log("persistent-room-skill-settings-smoke: OK");
} catch (error) {
	console.error(error instanceof Error ? error.stack || error.message : error);
	console.error(`temp root preserved for inspection: ${root}`);
	process.exitCode = 1;
}
