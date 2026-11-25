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

	// Enable stores the name and nothing of the skill's text.
	const enabled = enablePersistentRoomSkill(agentId, "cite-sources", resolveBody, {}, new Date("2026-07-11T09:00:00.000Z"));
	assert(enabled.ok, "enabling a library skill should succeed");
	assert(enabled.settings.enabledSkills.length === 1, "one skill should be enabled");
	assert(JSON.stringify(enabled.settings.enabledSkills[0]) === JSON.stringify({ name: "cite-sources" }), `enable should store the name alone, got ${JSON.stringify(enabled.settings.enabledSkills[0])}`);
	assert(enabled.settings.updatedAt === "2026-07-11T09:00:00.000Z", "enable should stamp updatedAt");

	// Settings survive a reload; file lives under the room runtime dir at 0600.
	const settingsPath = persistentRoomSkillSettingsPath(agentId);
	assert(settingsPath === path.join(root, agentId, "runtime", "skill-settings.json"), "settings file should live under the room runtime dir");
	const reread = readPersistentRoomSkillSettings(agentId);
	assert(reread.enabledSkills.length === 1 && reread.enabledSkills[0].name === "cite-sources", "reread should see the persisted enablement");
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

	// A changed body stays on, as it now is: no state of its own, and still in the effective set.
	library.set("cite-sources", "Always cite sources AND provide a confidence level.");
	const changed = computeSkillStatuses(readPersistentRoomSkillSettings(agentId).enabledSkills, resolveBody);
	assert(JSON.stringify(changed.find((s) => s.name === "cite-sources")) === JSON.stringify({ name: "cite-sources", status: "ok" }), `a changed body should read ok and carry nothing else, got ${JSON.stringify(changed)}`);
	assert(effectiveEnabledSkills(readPersistentRoomSkillSettings(agentId).enabledSkills, resolveBody).length === 2, "a changed skill must stay in the effective set");

	// Delete from the library → the enabled skill has left the room: no row, not used.
	library.delete("summarize-first");
	const afterDelete = computeSkillStatuses(readPersistentRoomSkillSettings(agentId).enabledSkills, resolveBody);
	assert(!afterDelete.some((s) => s.name === "summarize-first"), `a deleted library skill should have no row, got ${JSON.stringify(afterDelete)}`);
	assert(effectiveEnabledSkills(readPersistentRoomSkillSettings(agentId).enabledSkills, resolveBody).length === 1, "a deleted skill must be excluded from the effective set");

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
	// Malformed entries degrade safely; a damaged hash, no longer read, keeps its entry.
	fs.writeFileSync(
		persistentRoomSkillSettingsPath(agentId),
		JSON.stringify({ schemaVersion: 1, enabledSkills: [{ name: "cite-sources", sha256: "short" }, { name: "Bad Name", sha256: sha256("x") }, "junk"], updatedAt: "" }),
		"utf-8",
	);
	const kept = readPersistentRoomSkillSettings(agentId).enabledSkills;
	assert(kept.map((s) => s.name).join(",") === "cite-sources", `only the entry with a good name should be kept, got ${JSON.stringify(kept)}`);

	// --- Which skill an entry is: its name and the identity the skill was added with ---
	// Every check runs, so one run names each answer that is wrong.
	const failed: string[] = [];
	const check = (condition: unknown, message: string): void => {
		if (!condition) failed.push(message);
	};
	const idRoom = "skill-settings-identity-room";
	const idFile = persistentRoomSkillSettingsPath(idRoom);
	const firstId = "6f1c1d1e-2b1a-4c5d-9e8f-0a1b2c3d4e5f";
	const secondId = "0b9a8c7d-6e5f-4a3b-8c2d-1e0f9a8b7c6d";
	const reportText = "---\nname: weekly-report\ndescription: Writes the weekly report\n---\n\nWrite it.\n";
	const approvedAt = "2026-11-18T10:00:00.000Z";
	const filesSha256 = sha256("weekly-report files");
	const otherText = sha256("the text the skill had when it was switched on");
	let current: { manifest: string; identity?: string | null } | { unreadable: true } | null = { manifest: reportText, identity: firstId };
	const readCurrent = () => current;
	const statusOf = () => computeSkillStatuses(readPersistentRoomSkillSettings(idRoom).enabledSkills, readCurrent).find((s) => s.name === "weekly-report");
	const storedEntry = () => JSON.parse(fs.readFileSync(idFile, "utf-8")).enabledSkills.find((s: { name: string }) => s.name === "weekly-report");

	const switchedOn = enablePersistentRoomSkill(idRoom, "weekly-report", readCurrent);
	check(switchedOn.ok && storedEntry()?.identity === firstId, `switching on copies the skill's identity, got ${JSON.stringify(fs.existsSync(idFile) ? storedEntry() : null)}`);
	check(statusOf()?.status === "ok", `same name and same identity is on, got ${JSON.stringify(statusOf())}`);
	check(effectiveEnabledSkills(readPersistentRoomSkillSettings(idRoom).enabledSkills, readCurrent).length === 1, "same name and same identity is in the effective set");

	// Deleted and added again with byte-identical text: another identity, so it has left the room.
	current = { manifest: reportText, identity: secondId };
	check(statusOf() === undefined, `another identity is gone even with byte-identical text, got ${JSON.stringify(statusOf())}`);
	check(effectiveEnabledSkills(readPersistentRoomSkillSettings(idRoom).enabledSkills, readCurrent).length === 0, "another identity is not in the effective set");
	current = { manifest: reportText };
	check(statusOf() === undefined, `a skill with no identity is not the one switched on with one, got ${JSON.stringify(statusOf())}`);

	// A read that fails is unreadable, never gone: the row stays, and the skill is not used.
	current = { unreadable: true };
	check(statusOf()?.status === "unreadable", `a failed read gives unreadable, got ${JSON.stringify(statusOf())}`);
	check(effectiveEnabledSkills(readPersistentRoomSkillSettings(idRoom).enabledSkills, readCurrent).length === 0, "an unreadable skill is not in the effective set");

	// None matches none: the entry and the skill both without an identity. An old
	// entry's hash, no longer the text's, and its run approval are ignored, and
	// reading writes nothing.
	const oldShape = `${JSON.stringify({ schemaVersion: 1, enabledSkills: [{ name: "weekly-report", sha256: otherText, executeApproval: { filesSha256, approvedAt } }], updatedAt: approvedAt }, null, 2)}\n`;
	fs.writeFileSync(idFile, oldShape);
	current = { manifest: reportText };
	const oldStatus = computeSkillStatuses(readPersistentRoomSkillSettings(idRoom).enabledSkills, readCurrent).find((s) => s.name === "weekly-report");
	check(oldStatus?.status === "ok", `an old entry with a stale hash and an approval is on, got ${JSON.stringify(oldStatus)}`);
	check(effectiveEnabledSkills(readPersistentRoomSkillSettings(idRoom).enabledSkills, readCurrent).length === 1, "an old entry with a stale hash is in the effective set");
	check(fs.readFileSync(idFile, "utf-8") === oldShape, "a read leaves the room's file byte for byte as it was");
	current = { manifest: reportText, identity: firstId };
	check(statusOf() === undefined, `an entry with no identity is not a skill added with one, got ${JSON.stringify(statusOf())}`);
	check(fs.readFileSync(idFile, "utf-8") === oldShape, "a gone entry stays stored: a read writes nothing");

	// Switching on over an entry of another identity replaces it; the next write drops the old fields.
	const replaced = enablePersistentRoomSkill(idRoom, "weekly-report", readCurrent);
	check(replaced.ok && JSON.stringify(storedEntry()) === JSON.stringify({ name: "weekly-report", identity: firstId }), `switching on over another identity stores the new one alone, got ${JSON.stringify(storedEntry())}`);
	fs.writeFileSync(idFile, JSON.stringify({ schemaVersion: 1, enabledSkills: [{ name: "weekly-report", sha256: otherText, identity: firstId, executeApproval: { filesSha256, approvedAt } }, { name: "other-skill", sha256: otherText, executeApproval: { filesSha256, approvedAt } }], updatedAt: approvedAt }));
	disablePersistentRoomSkill(idRoom, "weekly-report");
	check(JSON.stringify(JSON.parse(fs.readFileSync(idFile, "utf-8")).enabledSkills) === JSON.stringify([{ name: "other-skill" }]), `a write drops the old hash and approval of the entries it keeps, got ${fs.readFileSync(idFile, "utf-8")}`);

	// A damaged stored identity reads as none: it never matches a skill that has one.
	for (const damaged of ["not-an-identity", 42, firstId.toUpperCase()]) {
		fs.writeFileSync(idFile, JSON.stringify({ schemaVersion: 1, enabledSkills: [{ name: "weekly-report", sha256: sha256(reportText), identity: damaged }], updatedAt: approvedAt }));
		current = { manifest: reportText, identity: firstId };
		check(statusOf() === undefined, `a damaged stored identity (${JSON.stringify(damaged)}) never matches a skill that has one, got ${JSON.stringify(statusOf())}`);
		current = { manifest: reportText };
		check(statusOf()?.status === "ok", `a damaged stored identity (${JSON.stringify(damaged)}) reads as none, got ${JSON.stringify(statusOf())}`);
	}
	assert(failed.length === 0, failed.join("\n"));

	fs.rmSync(root, { recursive: true, force: true });
	console.log("persistent-room-skill-settings-smoke: OK");
} catch (error) {
	console.error(error instanceof Error ? error.stack || error.message : error);
	console.error(`temp root preserved for inspection: ${root}`);
	process.exitCode = 1;
}
