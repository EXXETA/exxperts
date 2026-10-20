import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { enablePersistentRoomSkill, enablePersistentRoomSource, readPersistentRoomSkillSettings, updatePersistentRoomLibrary, type EnabledSkillSource } from "../src/persistent-room-skill-settings.js";
import { describeRoomLibraryChanges, libraryRoomsReviewHash, roomNeedsLibraryUpdate } from "../src/skill-library-room-updates.js";
import type { LibraryMaterialsManifest } from "../src/skills-library-materials.js";
import { normalizeRepositoryFilePolicy } from "../src/skills-file-policy.js";

const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "exxperts-bulk-room-updates-"));
const storage = { persistentAgentsRoot: temporary };
const hash = (letter: string) => letter.repeat(64);
const old: EnabledSkillSource = { libraryId: "brand", materialsSha256: hash("a"), skills: ["alpha", "bravo"].map((name) => ({ name, sha256: hash("b"), packageSha256: hash("c") })), excludedSkills: ["bravo"] };
const current: EnabledSkillSource = { ...old, materialsSha256: hash("d"), skills: [...old.skills.map((pin) => ({ ...pin, packageSha256: hash("e") })), { name: "charlie", sha256: hash("a"), packageSha256: hash("f") }], excludedSkills: [] };
try {
	const roomIds = ["one", "two", ...Array.from({ length: 18 }, (_, index) => `bulk-${index}`)];
	for (const room of roomIds) {
		assert(enablePersistentRoomSource(room, old, storage).ok);
		assert(enablePersistentRoomSkill(room, "alpha", () => "Independent alpha", storage, undefined, () => hash("c")).ok);
		assert(enablePersistentRoomSkill(room, "other", () => "Unrelated independent skill", storage).ok);
	}
	const before = readPersistentRoomSkillSettings("one", storage);
	const material = (path: string, digest: string) => ({ path, kind: "markdown" as const, sha256: hash(digest), size: 10, mimeType: "text/markdown" });
	const previousMaterials: LibraryMaterialsManifest = { schemaVersion: 1, libraryId: "brand", materialsSha256: old.materialsSha256, source: "https://example.invalid/brand", revision: "a".repeat(40), policy: normalizeRepositoryFilePolicy({}), files: [material("same.md", "a"), material("changed.md", "b"), material("removed.md", "c")] };
	const materials = { ...previousMaterials, materialsSha256: current.materialsSha256, files: [material("same.md", "a"), material("changed.md", "d"), material("added.md", "e")] };
	const changes = describeRoomLibraryChanges(before, current, previousMaterials, materials);
	assert.equal(changes.total, 6, "three skill and three file changes, without counting unchanged objects");
	assert.deepEqual(changes.references.map((file) => [file.path, file.status]), [["added.md", "added"], ["changed.md", "changed"], ["removed.md", "removed"]]);
	assert.equal(changes.references.find((file) => file.path === "changed.md")?.beforeVersion, old.materialsSha256);
	assert.equal(changes.skills.find((skill) => skill.name === "charlie")?.enabled, false, "new skills stay off in the change preview");
	assert.equal(changes.skills.find((skill) => skill.name === "bravo")?.enabled, false, "excluded skills stay off in the preview");
	const removedSkill = describeRoomLibraryChanges({ ...before, enabledSources: [{ ...old, skills: [...old.skills, { name: "removed", sha256: hash("a"), packageSha256: hash("b") }] }] }, current, previousMaterials, materials);
	assert.equal(removedSkill.skills.find((skill) => skill.name === "removed")?.status, "removed");
	assert.equal(describeRoomLibraryChanges({ ...before, enabledSources: [] }, current, null, materials).references.length, 0, "individual assignments never imply source-material access");
	const unavailable = describeRoomLibraryChanges(before, current, null, materials);
	assert(unavailable.previousReferencesUnavailable);
	assert(unavailable.references.every((file) => file.status === "review"), "missing history is not mislabelled as new files");
	const versionOnly = describeRoomLibraryChanges({ ...before, enabledSkills: [], enabledSources: [{ ...current, materialsSha256: old.materialsSha256 }] }, current, materials, materials);
	assert.equal(versionOnly.total, 1);
	assert(versionOnly.referenceVersionChanged);
	const otherRoom = readPersistentRoomSkillSettings("two", storage);
	assert(roomNeedsLibraryUpdate(before, current));
	const review = [{ id: "one", name: "One", busy: false, settings: before }];
	const digest = libraryRoomsReviewHash(current, review);
	assert.notEqual(libraryRoomsReviewHash({ ...current, materialsSha256: hash("f") }, review), digest);
	assert.notEqual(libraryRoomsReviewHash(current, [{ ...review[0], settings: { ...before, updatedAt: "changed" } }]), digest);
	const saved = updatePersistentRoomLibrary("one", "brand", current, before, storage);
	assert.deepEqual(saved.enabledSources![0].excludedSkills, ["bravo", "charlie"], "existing exceptions and new skills stay off");
	assert.deepEqual(saved.enabledSkills.find((pin) => pin.name === "other"), before.enabledSkills.find((pin) => pin.name === "other"));
	assert.equal(saved.enabledSkills.find((pin) => pin.name === "alpha")?.packageSha256, hash("e"), "independent library assignments update in the same room write");
	assert(!roomNeedsLibraryUpdate(saved, current));
	assert.throws(() => updatePersistentRoomLibrary("one", "brand", current, before, storage), /changed since/);
	assert.deepEqual(readPersistentRoomSkillSettings("one", storage), saved, "stale room review writes nothing");
	assert.deepEqual(readPersistentRoomSkillSettings("two", storage), otherRoom, "other rooms remain independent");
	for (const id of roomIds.slice(1)) {
		const updated = updatePersistentRoomLibrary(id, "brand", current, readPersistentRoomSkillSettings(id, storage), storage);
		assert(!roomNeedsLibraryUpdate(updated, current), "all twenty existing room assignments can adopt the reviewed local version");
		assert.deepEqual(updated.enabledSources![0].excludedSkills, ["bravo", "charlie"]);
	}
	const independent = { ...before, enabledSources: [] };
	assert(roomNeedsLibraryUpdate(independent, current), "individually assigned repository skills are also noticed");
	console.log("skill-library-room-updates-smoke: OK");
} finally { fs.rmSync(temporary, { recursive: true, force: true }); }
