import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { configuredRoomSkillPins, computeRoomSkillStatuses, disablePersistentRoomSkill, disablePersistentRoomSource, effectiveRoomEnabledSkills, enablePersistentRoomSkill, enablePersistentRoomSource, persistentRoomSkillSettingsPath, readPersistentRoomSkillSettings, setPersistentRoomSourceSkillExcluded, type EnabledSkillSource } from "../src/persistent-room-skill-settings.js";
import { buildEnabledSourcesIndexSection, createReadLibraryReferenceTool, createReadSkillTool } from "../src/persistent-room-skill-tool.js";
import { sha256 } from "../src/skills-store.js";

const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "exxperts-room-sources-"));
const storage = { persistentAgentsRoot: temporary };
const room = "source-room";
const bodies = new Map([["alpha", "Alpha original"], ["bravo", "Bravo original"]]);
const packages = new Map([["alpha", "a".repeat(64)], ["bravo", "b".repeat(64)]]);
const body = (name: string) => bodies.get(name) ?? null;
const digest = (name: string) => packages.get(name) ?? null;
const pins = () => [...bodies].filter(([name]) => name !== "charlie").map(([name, manifest]) => ({ name, sha256: sha256(manifest), packageSha256: packages.get(name)! }));
const original: EnabledSkillSource = { libraryId: "source-a", materialsSha256: "1".repeat(64), skills: pins(), excludedSkills: [] };
const settings = () => readPersistentRoomSkillSettings(room, storage);
const effective = () => effectiveRoomEnabledSkills(settings(), body, digest).map((skill) => skill.name);

try {
	assert.equal(settings().enabledSources, undefined, "legacy rooms retain their schema");
	assert(enablePersistentRoomSkill(room, "alpha", body, storage, undefined, digest).ok);
	assert(enablePersistentRoomSource(room, original, storage).ok);
	assert.deepEqual(effective(), ["alpha", "bravo"]);
	assert.equal(configuredRoomSkillPins(settings()).filter((skill) => skill.name === "alpha").length, 2, "independent owners retain their own pins");
	assert(disablePersistentRoomSource(room, "source-a", storage).ok);
	assert.deepEqual(effective(), ["alpha"], "source off retains independent grants");
	assert(enablePersistentRoomSource(room, original, storage).ok);
	assert(setPersistentRoomSourceSkillExcluded(room, "source-a", "alpha", true, storage).ok);
	assert.deepEqual(effective(), ["alpha", "bravo"], "source exclusions leave independent consent alone");
	assert(disablePersistentRoomSkill(room, "alpha", storage).ok);
	assert.deepEqual(effective(), ["bravo"]);
	assert.equal(settings().enabledSources?.length, 1, "single-skill writes preserve source grants");
	assert(setPersistentRoomSourceSkillExcluded(room, "source-a", "alpha", false, storage).ok);
	assert.deepEqual(effective(), ["alpha", "bravo"]);
	bodies.set("charlie", "New unreviewed skill"); packages.set("charlie", "c".repeat(64));
	assert.deepEqual(effective(), ["alpha", "bravo"], "new source skills need grouped review");
	assert(enablePersistentRoomSkill(room, "alpha", body, storage, undefined, digest).ok);
	bodies.set("alpha", "Alpha changed"); packages.set("alpha", "d".repeat(64));
	assert.deepEqual(effective(), ["bravo"], "changed source packages remain unavailable");
	assert(enablePersistentRoomSource(room, { ...original, skills: pins() }, storage).ok);
	assert.deepEqual(effective(), ["alpha", "bravo"], "valid source consent is not masked by stale independent consent");
	assert.equal(computeRoomSkillStatuses(settings(), body, undefined, digest).find((skill) => skill.name === "alpha")?.status, "ok");
	assert(enablePersistentRoomSkill(room, "alpha", body, storage, undefined, digest).ok);
	assert(enablePersistentRoomSource(room, original, storage).ok);
	assert.deepEqual(effective(), ["alpha", "bravo"], "valid independent consent is not masked by stale source consent");

	const skillTool = createReadSkillTool({ agentId: room, storage, lookupSkill: (name) => body(name) ? { manifest: body(name)!, body: body(name)!, description: "Synthetic", packageSha256: digest(name)! } : null });
	const read = await skillTool.execute("skill", { name: "alpha" }, undefined, undefined, {} as any);
	assert.equal((read.details as any)?.outcome, "ok", "read_skill uses the same any-valid union");

	const source = { libraryId: "source-a", materialsSha256: original.materialsSha256, source: "https://example.invalid/brand", revision: "approved-old-revision", files: [{ path: "shared/logo.svg", kind: "svg" as const, size: 4 }, { path: "extras/guide.md", kind: "markdown" as const, size: 20 }] };
	let reads = 0;
	let revokeDuringRead = false;
	const sourceTool = createReadLibraryReferenceTool({
		agentId: room, storage,
		resolveSource: (_id, hash) => hash === source.materialsSha256 ? source : null,
		listReferences: (_id, _hash, reference, options) => {
			if (reference === "../extras") { assert.equal(options.from, "shared/logo.svg"); return { path: "extras", folders: [], files: [source.files[1]] }; }
			return { path: reference, folders: reference ? [] : ["shared", "extras"], files: reference ? source.files.filter((file) => file.path === reference) : [] };
		},
		resolveReference: async (_id, hash, reference) => {
			reads++;
			assert.equal(hash, original.materialsSha256, "reads retain the room-approved older material version");
			if (revokeDuringRead) disablePersistentRoomSource(room, "source-a", storage);
			return { content: [{ type: "text", text: reference }], details: { outcome: "ok", materialsSha256: hash } };
		},
	});
	const call = (reference?: string) => sourceTool.execute("material", { libraryId: "source-a", reference }, undefined, undefined, {} as any);
	assert.equal((await call()).details?.outcome, "ok");
	assert.equal(reads, 0, "listing does not load material bytes");
	const relativeFolder = await sourceTool.execute("relative-folder", { libraryId: "source-a", reference: "../extras", from: "shared/logo.svg" }, undefined, undefined, {} as any);
	assert.equal(relativeFolder.details?.listing, true, "relative folders without a trailing slash use the store's safe path resolver");
	assert.equal(reads, 0, "relative folders list instead of falling through to file extraction");
	assert.equal((await call("extras/guide.md")).details?.outcome, "ok", "unassigned reviewed extras can be read");
	assert.equal((await call("skills/alpha/SKILL.md")).details?.outcome, "not-selected", "source material access cannot bypass skill consent");
	revokeDuringRead = true;
	assert.equal((await call("extras/guide.md")).details?.outcome, "not-enabled", "revocation during asynchronous parsing is respected");
	assert.equal((await call()).details?.outcome, "not-enabled");
	assert(effective().includes("alpha"), "material source revocation still preserves manual skill consent");
	assert(buildEnabledSourcesIndexSection([{ ...source, name: "Brand" }]).includes("extras"));
	assert(!buildEnabledSourcesIndexSection([{ ...source, name: "Brand" }]).includes("extras/guide.md"), "the source index stays compact");

	const before = fs.readFileSync(persistentRoomSkillSettingsPath(room, storage), "utf8");
	assert.equal(enablePersistentRoomSource(room, { ...original, skills: [{ name: "alpha", sha256: "invalid", packageSha256: "a".repeat(64) }] }, storage).ok, false);
	assert.equal(fs.readFileSync(persistentRoomSkillSettingsPath(room, storage), "utf8"), before, "invalid grouped consent writes nothing");
	assert.equal(enablePersistentRoomSource(room, { ...original, skills: [original.skills[0], original.skills[0]] }, storage).ok, false, "duplicate members are rejected");
	assert.equal(setPersistentRoomSourceSkillExcluded(room, "source-a", "unknown", true, storage).ok, false);
	fs.writeFileSync(persistentRoomSkillSettingsPath(room, storage), JSON.stringify({ ...settings(), enabledSources: [{ ...original, materialsSha256: "broken" }] }));
	assert.deepEqual(settings().enabledSources, [], "malformed source grants grant nothing");
	assert.equal(settings().enabledSkills.length, 1, "malformed source grants preserve valid independent consent");
	console.log("persistent-room-source-settings-smoke: OK");
} finally { fs.rmSync(temporary, { recursive: true, force: true }); }
