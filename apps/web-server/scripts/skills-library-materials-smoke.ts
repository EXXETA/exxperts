import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { productAppStatePath } from "../../../pi-package/product-state-paths.js";
import { saveSkillLibrary, scanSkillLibrary } from "../src/skills-libraries.js";
import { disposeAllCheckouts } from "../src/skills-repo-fetch.js";
import { acceptLibraryMaterials, currentLibraryMaterialsSha256, listLibraryMaterialReferences, prepareLibraryMaterials, readLibraryMaterialBytes, readLibraryMaterialReference, readLibraryMaterialsIndex, seedLibraryMaterialsFromSkills } from "../src/skills-library-materials.js";
import { referenceBytesSha256, referenceLocalPath, type RepositoryFilePolicy } from "../src/skills-file-policy.js";
import { sha256, writeSkillProvenance } from "../src/skills-store.js";
import { enablePersistentRoomSource, persistentRoomSkillSettingsPath } from "../src/persistent-room-skill-settings.js";

const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), "exxperts-materials-smoke-"));
const previousStateHome = process.env.EXXPERTS_STATE_HOME;
const previousLocal = process.env.EXXETA_SKILLS_ALLOW_LOCAL_REPO;
process.env.EXXPERTS_STATE_HOME = path.join(fixtureRoot, "state");
process.env.EXXETA_SKILLS_ALLOW_LOCAL_REPO = "1";
const repository = path.join(fixtureRoot, "repository");
const policy: RepositoryFilePolicy = { designRepo: true, allowedTypes: ["markdown", "svg"], skillRoot: "skills", referenceRoots: [""] };
function write(root: string, relative: string, bytes: Buffer | string): void {
	const file = path.join(root, ...relative.split("/"));
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.writeFileSync(file, bytes);
}
const text = (result: Awaited<ReturnType<typeof readLibraryMaterialReference>>) => result.content.filter((part) => part.type === "text").map((part) => part.text).join("\n");

try {
	fs.mkdirSync(repository);
	write(repository, "skills/brand/SKILL.md", "---\nname: brand\ndescription: Fixture\n---\nUse shared material.\n");
	write(repository, "shared/guide.md", "First line\nRead [detail](../assets/details.md).\nLast line\n");
	write(repository, "assets/details.md", "Synthetic brand details\n");
	write(repository, "assets/icon.svg", '<svg xmlns="http://www.w3.org/2000/svg"><script>window.fixture=true</script></svg>');
	write(repository, "shared/run.js", "console.log('never imported');\n");
	const git = (args: string[]) => execFileSync("git", ["-c", "core.hooksPath=", ...args], { cwd: repository, stdio: "pipe" });
	git(["init", "--initial-branch=main"]);
	git(["config", "uploadpack.allowFilter", "true"]);
	git(["add", "."]);
	git(["-c", "user.name=Fixture", "-c", "user.email=fixture@example.test", "commit", "-m", "Synthetic material fixture"]);
	const library = saveSkillLibrary({ name: "Fixture", source: repository, ...policy });
	const scan = await scanSkillLibrary(library.id);
	assert.equal(currentLibraryMaterialsSha256(library.id), null);
	assert.equal(readLibraryMaterialsIndex(library.id), null);
	await assert.rejects(prepareLibraryMaterials(library.id, scan.token, ["shared/run.js"], null), /not allowed/);
	await assert.rejects(prepareLibraryMaterials(library.id, scan.token, ["skills/brand/SKILL.md"], null), /manifests/);
	await assert.rejects(prepareLibraryMaterials(library.id, scan.token, ["../assets/details.md"], null), /unsafe/);
	await assert.rejects(prepareLibraryMaterials(library.id, scan.token, ["assets/details.md", "ASSETS/DETAILS.MD"], null), /Duplicate/);
	await assert.rejects(prepareLibraryMaterials(library.id, scan.token, Array.from({ length: 2001 }, (_, i) => `shared/${i}.md`), null), /2000/);
	await assert.rejects(prepareLibraryMaterials("other-source", scan.token, [], null), /another library/);
	const chosen = ["shared/guide.md", "assets/details.md", "assets/icon.svg"];
	const review = await prepareLibraryMaterials(library.id, scan.token, chosen, null);
	assert.equal(currentLibraryMaterialsSha256(library.id), null, "preparing a review saves no material version");
	assert.deepEqual(review.added.sort(), [...chosen].sort());
	assert.deepEqual(review.removed, []);
	const original = await acceptLibraryMaterials(library.id, review.candidateSha256);
	const originalHash = original.materialsSha256;
	assert.equal(currentLibraryMaterialsSha256(library.id), originalHash);
	assert.deepEqual(readLibraryMaterialsIndex(library.id), original);
	write(repository, "unrelated.md", "Unrelated new commit.\n");
	git(["add", "."]);
	git(["-c", "user.name=Fixture", "-c", "user.email=fixture@example.test", "commit", "-m", "Unrelated content"]);
	const unchangedScan = await scanSkillLibrary(library.id, { forceRefresh: true });
	const unchangedMaterials = await prepareLibraryMaterials(library.id, unchangedScan.token, chosen, originalHash);
	assert.equal(unchangedMaterials.manifest.materialsSha256, originalHash, "unrelated commits retain existing material versions and room pins");
	const publishLock = productAppStatePath("skill-library-materials", library.id, ".publish.lock");
	const recoveryReview = await prepareLibraryMaterials(library.id, scan.token, chosen, originalHash);
	const liveOwner = JSON.stringify({ pid: process.pid, owner: "00000000-0000-4000-8000-000000000001" });
	fs.writeFileSync(publishLock, liveOwner);
	await assert.rejects(acceptLibraryMaterials(library.id, recoveryReview.candidateSha256), /being saved/);
	assert.equal(fs.readFileSync(publishLock, "utf8"), liveOwner, "an active owner is never removed");
	fs.writeFileSync(publishLock, "malformed owner record");
	await assert.rejects(acceptLibraryMaterials(library.id, recoveryReview.candidateSha256), /invalid.*lock|lock is invalid/);
	assert.equal(fs.readFileSync(publishLock, "utf8"), "malformed owner record", "an unverifiable owner is preserved for repair");
	const exited = spawnSync(process.execPath, ["-e", "process.exit(0)"], { stdio: "pipe" });
	assert.equal(exited.status, 0);
	assert.throws(() => process.kill(exited.pid, 0), (error: unknown) => (error as NodeJS.ErrnoException).code === "ESRCH", "the crash fixture owner is demonstrably dead");
	fs.writeFileSync(publishLock, JSON.stringify({ pid: exited.pid, owner: "00000000-0000-4000-8000-000000000002" }));
	assert.equal((await acceptLibraryMaterials(library.id, recoveryReview.candidateSha256)).materialsSha256, originalHash, "a crashed owner does not block later reviewed imports");
	assert.equal(fs.existsSync(publishLock), false, "successful recovery releases its own lock");

	const retryLibrary = saveSkillLibrary({ name: "Windows publication fixture", source: repository, ...policy });
	const retryScan = await scanSkillLibrary(retryLibrary.id);
	const retryBase = productAppStatePath("skill-library-materials", retryLibrary.id);
	const retryPointer = path.join(retryBase, "current.json");
	const realRename = fs.renameSync;
	const isStageMove = (from: fs.PathLike, to: fs.PathLike) => path.dirname(String(from)) === retryBase && path.basename(String(from)).startsWith(".staging-") && path.dirname(String(to)) === path.join(retryBase, "versions");
	const retryFirstReview = await prepareLibraryMaterials(retryLibrary.id, retryScan.token, chosen, null);
	let stageAttempts = 0;
	fs.renameSync = ((from, to) => {
		if (isStageMove(from, to) && ++stageAttempts < 3) throw Object.assign(new Error("Synthetic Windows directory rename failure"), { code: "EPERM" });
		return realRename(from, to);
	}) as typeof fs.renameSync;
	let retryFirst;
	try { retryFirst = await acceptLibraryMaterials(retryLibrary.id, retryFirstReview.candidateSha256); }
	finally { fs.renameSync = realRename; }
	assert.equal(stageAttempts, 3, "transient directory permission errors retry the same atomic move");
	assert.equal(currentLibraryMaterialsSha256(retryLibrary.id), retryFirst.materialsSha256);
	const retryRoomStorage = { persistentAgentsRoot: path.join(fixtureRoot, "retry-rooms") };
	assert(enablePersistentRoomSource("publication-room", { libraryId: retryLibrary.id, materialsSha256: retryFirst.materialsSha256, skills: [], excludedSkills: [] }, retryRoomStorage).ok);
	const retryGrantPath = persistentRoomSkillSettingsPath("publication-room", retryRoomStorage);
	const retryGrantBytes = fs.readFileSync(retryGrantPath);
	const originalRetryPointer = fs.readFileSync(retryPointer);
	const retryNext = await prepareLibraryMaterials(retryLibrary.id, retryScan.token, ["shared/guide.md"], retryFirst.materialsSha256);
	stageAttempts = 0;
	fs.renameSync = ((from, to) => {
		if (isStageMove(from, to)) { stageAttempts++; throw Object.assign(new Error("Synthetic permanent directory lock"), { code: "EPERM" }); }
		return realRename(from, to);
	}) as typeof fs.renameSync;
	try { await assert.rejects(acceptLibraryMaterials(retryLibrary.id, retryNext.candidateSha256), (error: any) => error.statusCode === 503 && error.code === "EPERM" && error.message.includes("Existing files were preserved")); }
	finally { fs.renameSync = realRename; }
	assert.equal(stageAttempts, 5, "permanent directory failures have a bounded retry count");
	assert.deepEqual(fs.readFileSync(retryPointer), originalRetryPointer);
	assert.equal(fs.existsSync(path.join(retryBase, "versions", retryNext.manifest.materialsSha256)), false);
	assert.deepEqual(fs.readFileSync(retryGrantPath), retryGrantBytes, "failed publication cannot alter source consent");
	assert(text(await readLibraryMaterialReference(retryLibrary.id, retryFirst.materialsSha256, "assets/details.md")).includes("Synthetic brand details"));
	let pointerAttempts = 0;
	fs.renameSync = ((from, to) => {
		if (String(to) === retryPointer) { pointerAttempts++; throw Object.assign(new Error("Synthetic permanent pointer lock"), { code: "EACCES" }); }
		return realRename(from, to);
	}) as typeof fs.renameSync;
	try { await assert.rejects(acceptLibraryMaterials(retryLibrary.id, retryNext.candidateSha256), (error: any) => error.statusCode === 503 && error.code === "EACCES"); }
	finally { fs.renameSync = realRename; }
	assert.equal(pointerAttempts, 5);
	assert.deepEqual(fs.readFileSync(retryPointer), originalRetryPointer, "failed pointer replacement keeps the complete older version active");
	assert(fs.existsSync(path.join(retryBase, "versions", retryNext.manifest.materialsSha256)), "a complete unpublished version is retained for a safe retry");
	pointerAttempts = 0;
	fs.renameSync = ((from, to) => {
		if (String(to) === retryPointer && ++pointerAttempts < 3) throw Object.assign(new Error("Synthetic transient pointer lock"), { code: "EBUSY" });
		return realRename(from, to);
	}) as typeof fs.renameSync;
	let retrySecond;
	try { retrySecond = await acceptLibraryMaterials(retryLibrary.id, retryNext.candidateSha256); }
	finally { fs.renameSync = realRename; }
	assert.equal(pointerAttempts, 3);
	assert.equal(currentLibraryMaterialsSha256(retryLibrary.id), retrySecond.materialsSha256);
	assert.deepEqual(fs.readFileSync(retryGrantPath), retryGrantBytes, "a successful newer save retains the older room pin");
	const retrySecondPointer = fs.readFileSync(retryPointer);
	const policyRace = await prepareLibraryMaterials(retryLibrary.id, retryScan.token, ["assets/icon.svg"], retrySecond.materialsSha256);
	stageAttempts = 0;
	fs.renameSync = ((from, to) => {
		if (isStageMove(from, to)) {
			stageAttempts++;
			setTimeout(() => saveSkillLibrary({ ...retryLibrary, allowedTypes: ["markdown"] }), 0);
			throw Object.assign(new Error("Synthetic backoff before source change"), { code: "EPERM" });
		}
		return realRename(from, to);
	}) as typeof fs.renameSync;
	try { await assert.rejects(acceptLibraryMaterials(retryLibrary.id, policyRace.candidateSha256), /settings changed/); }
	finally { fs.renameSync = realRename; saveSkillLibrary(retryLibrary); }
	assert.equal(stageAttempts, 1, "source configuration is checked before retrying after a yield");
	assert.deepEqual(fs.readFileSync(retryPointer), retrySecondPointer);
	stageAttempts = 0;
	fs.renameSync = ((from, to) => {
		if (isStageMove(from, to)) {
			stageAttempts++;
			setTimeout(() => fs.writeFileSync(retryPointer, originalRetryPointer), 0);
			throw Object.assign(new Error("Synthetic backoff before pointer change"), { code: "EBUSY" });
		}
		return realRename(from, to);
	}) as typeof fs.renameSync;
	try { await assert.rejects(acceptLibraryMaterials(retryLibrary.id, policyRace.candidateSha256), /materials changed/); }
	finally { fs.renameSync = realRename; }
	assert.equal(stageAttempts, 1, "the expected current version is checked again after retry backoff");
	assert.deepEqual(fs.readFileSync(retryPointer), originalRetryPointer, "a conflicting current version is never overwritten");
	assert.deepEqual(fs.readFileSync(retryGrantPath), retryGrantBytes);
	assert.equal(fs.readdirSync(retryBase).some((name) => name.startsWith(".staging-") || name.startsWith(".current-") || name === ".publish.lock"), false);
	assert.deepEqual(listLibraryMaterialReferences(library.id, originalHash).folders, ["assets", "shared"]);
	const listing = listLibraryMaterialReferences(library.id, originalHash, "assets", { limit: 1 });
	assert.equal(listing.files.length, 1);
	assert.equal(listing.nextOffset, 2);
	assert.equal(listLibraryMaterialReferences(library.id, originalHash, "assets", { offset: 2 }).files.length, 1);
	const relative = await readLibraryMaterialReference(library.id, originalHash, "../assets/details.md", { from: "shared/guide.md" });
	assert(text(relative).includes("Synthetic brand details"));
	assert(text(relative).includes("read_library_reference using from="));
	assert.equal(relative.details?.materialsSha256, originalHash);
	assert.equal(relative.details?.packageSha256, undefined);
	assert.equal((await readLibraryMaterialReference(library.id, originalHash, "shared/guide.md", { offset: 1, limit: 1 })).details?.nextOffset, 2);
	const svg = await readLibraryMaterialReference(library.id, originalHash, "assets/icon.svg");
	assert(text(svg).includes("<script>window.fixture=true</script>"), "SVG remains inert source text");
	await assert.rejects(readLibraryMaterialBytes(library.id, originalHash, "../../outside.md", "shared/guide.md"), /unsafe/);
	await assert.rejects(readLibraryMaterialBytes(library.id, originalHash, "assets/details.md", "foreign.md"), /source must/);
	await assert.rejects(readLibraryMaterialBytes(library.id, originalHash, "skills/brand/SKILL.md"), /not included/);
	assert.throws(() => readLibraryMaterialsIndex("../escape", originalHash), /identifier/);
	const a = await prepareLibraryMaterials(library.id, scan.token, ["shared/guide.md"], originalHash);
	const b = await prepareLibraryMaterials(library.id, scan.token, ["assets/details.md"], originalHash);
	assert.deepEqual(a.removed, ["assets/details.md", "assets/icon.svg"]);
	const newer = await acceptLibraryMaterials(library.id, a.candidateSha256);
	await assert.rejects(acceptLibraryMaterials(library.id, b.candidateSha256), /changed/);
	assert.equal(currentLibraryMaterialsSha256(library.id), newer.materialsSha256);
	assert(text(await readLibraryMaterialReference(library.id, originalHash, "assets/details.md")).includes("Synthetic brand details"), "old room-pinned versions remain readable");
	await assert.rejects(readLibraryMaterialBytes(library.id, newer.materialsSha256, "assets/details.md"), /not included/);
	const oldVersion = productAppStatePath("skill-library-materials", library.id, "versions", originalHash);
	const oldMaterial = path.join(oldVersion, "files", "assets", "details.md");
	const originalBytes = fs.readFileSync(oldMaterial);
	fs.writeFileSync(oldMaterial, "Changed brand details!!!\n");
	await assert.rejects(readLibraryMaterialBytes(library.id, originalHash, "assets/details.md"), /changed|limit/);
	fs.writeFileSync(oldMaterial, originalBytes);
	const oldManifest = path.join(oldVersion, "manifest.json");
	const rawManifest = fs.readFileSync(oldManifest);
	const corrupted = JSON.parse(rawManifest.toString());
	corrupted.files[0].sha256 = "0".repeat(64);
	fs.writeFileSync(oldManifest, JSON.stringify(corrupted));
	assert.throws(() => readLibraryMaterialsIndex(library.id, originalHash), /fingerprint/);
	fs.writeFileSync(oldManifest, rawManifest);
	const assetFolder = path.join(oldVersion, "files", "assets");
	const savedAssetFolder = path.join(oldVersion, "files", "saved-assets");
	fs.renameSync(assetFolder, savedAssetFolder);
	try {
		fs.symlinkSync(savedAssetFolder, assetFolder, process.platform === "win32" ? "junction" : "dir");
		await assert.rejects(readLibraryMaterialBytes(library.id, originalHash, "assets/details.md"), /symbolic link/);
	} finally {
		if (fs.existsSync(assetFolder)) { if (process.platform === "win32") fs.rmdirSync(assetFolder); else fs.unlinkSync(assetFolder); }
		fs.renameSync(savedAssetFolder, assetFolder);
	}
	const stalePolicy = await prepareLibraryMaterials(library.id, scan.token, chosen, newer.materialsSha256);
	saveSkillLibrary({ ...library, allowedTypes: ["markdown"] });
	await assert.rejects(acceptLibraryMaterials(library.id, stalePolicy.candidateSha256), /settings changed/);
	assert.equal(currentLibraryMaterialsSha256(library.id), newer.materialsSha256, "failed policy CAS preserves the accepted version");
	saveSkillLibrary(library);
	const currentPointer = productAppStatePath("skill-library-materials", library.id, "current.json");
	const pointerBytes = fs.readFileSync(currentPointer);
	fs.writeFileSync(currentPointer, "bad json");
	assert.throws(() => currentLibraryMaterialsSha256(library.id));
	fs.writeFileSync(currentPointer, pointerBytes);
	assert.equal(fs.readdirSync(path.dirname(currentPointer)).filter((name) => name.startsWith(".staging-")).length, 0, "failed writes clean their own staging folders");

	const seedLibrary = saveSkillLibrary({ name: "Seed", source: repository, ...policy });
	function seedSkill(name: string, referenceBody: string): string {
		const directory = path.join(fixtureRoot, "packages", name);
		const manifest = `---\nname: ${name}\ndescription: Fixture\n---\nSeed fixture\n`;
		const skillPath = `skills/${name}`;
		const originalPath = "shared/selected.md";
		const bytes = Buffer.from(referenceBody);
		const localPath = referenceLocalPath(originalPath, skillPath);
		write(directory, "SKILL.md", manifest);
		write(directory, localPath, bytes);
		writeSkillProvenance(directory, { source: seedLibrary.source, importedAt: "2026-10-14T00:00:00Z", license: null, sha256: sha256(manifest), repo: { libraryId: seedLibrary.id, source: seedLibrary.source, revision: "a".repeat(40), skillPath, policy, references: [{ path: originalPath, localPath, kind: "markdown", size: bytes.length, sha256: referenceBytesSha256(bytes) }] } });
		return directory;
	}
	const firstPackage = seedSkill("first", "Reviewed selection\n");
	const secondPackage = seedSkill("second", "Conflicting selection\n");
	const beforePackage = fs.readFileSync(path.join(firstPackage, "provenance.json"));
	const conflict = await seedLibraryMaterialsFromSkills(seedLibrary.id, [firstPackage, secondPackage]);
	assert.equal(conflict.seeded, false);
	assert.deepEqual(conflict.conflicts, [{ path: "shared/selected.md", skills: ["first", "second"] }]);
	assert.equal(currentLibraryMaterialsSha256(seedLibrary.id), null, "conflicting reviewed copies are never silently merged");
	const seedBase = productAppStatePath("skill-library-materials", seedLibrary.id);
	let seedMoves = 0;
	fs.renameSync = ((from, to) => {
		if (path.dirname(String(from)) === seedBase && path.basename(String(from)).startsWith(".staging-") && ++seedMoves < 3) throw Object.assign(new Error("Synthetic Windows seeding failure"), { code: "EPERM" });
		return realRename(from, to);
	}) as typeof fs.renameSync;
	let seeded;
	try { seeded = await seedLibraryMaterialsFromSkills(seedLibrary.id, [firstPackage]); }
	finally { fs.renameSync = realRename; }
	assert.equal(seedMoves, 3, "room-source seeding uses the same bounded atomic rename retry");
	assert.equal(seeded.seeded, true);
	assert.equal(seeded.manifest?.files.length, 1);
	assert.equal(seeded.manifest?.files[0].revision, "a".repeat(40), "seeded files retain their original reviewed commit");
	assert.deepEqual(fs.readFileSync(path.join(firstPackage, "provenance.json")), beforePackage, "seeding leaves existing skill packages unchanged");
	assert.equal((await seedLibraryMaterialsFromSkills(seedLibrary.id, [firstPackage, secondPackage])).seeded, false, "seeding never overwrites accepted source materials");
	const trackedLegacy = saveSkillLibrary({ name: "Tracked legacy", source: repository, ...policy });
	const legacyPackage = seedSkill("legacy", "Reviewed legacy material\n");
	const legacyProvenance = path.join(legacyPackage, "provenance.json");
	const directImport = JSON.parse(fs.readFileSync(legacyProvenance, "utf8"));
	delete directImport.repo.libraryId;
	fs.writeFileSync(legacyProvenance, JSON.stringify(directImport));
	const legacyBeforeSeed = fs.readFileSync(legacyProvenance);
	const trackedSeed = await seedLibraryMaterialsFromSkills(trackedLegacy.id, [legacyPackage]);
	assert.equal(trackedSeed.seeded, true, "an exact-source legacy direct import seeds its newly tracked library without Git");
	assert.deepEqual(fs.readFileSync(legacyProvenance), legacyBeforeSeed, "tracking does not rewrite the legacy package identity");
	const otherRef = saveSkillLibrary({ name: "Different ref", source: repository, ref: "other", ...policy });
	assert.equal((await seedLibraryMaterialsFromSkills(otherRef.id, [legacyPackage])).seeded, false, "legacy references never cross branch or tag boundaries");
	const tamperedLibrary = saveSkillLibrary({ name: "Tampered", source: repository, ...policy });
	const packet = JSON.parse(beforePackage.toString());
	packet.repo.libraryId = tamperedLibrary.id;
	fs.writeFileSync(path.join(firstPackage, "provenance.json"), JSON.stringify(packet));
	write(firstPackage, packet.repo.references[0].localPath, "Unreviewed change\n");
	await assert.rejects(seedLibraryMaterialsFromSkills(tamperedLibrary.id, [firstPackage]), /changed since import/);
	const emptyLibrary = saveSkillLibrary({ name: "Empty references", source: repository, ...policy });
	const emptyPackage = path.join(fixtureRoot, "packages", "empty");
	const emptyManifest = "---\nname: empty\ndescription: Fixture\n---\nInstructions without materials\n";
	write(emptyPackage, "SKILL.md", emptyManifest);
	writeSkillProvenance(emptyPackage, { source: emptyLibrary.source, importedAt: "2026-10-14T00:00:00Z", license: null, sha256: sha256(emptyManifest), repo: { libraryId: emptyLibrary.id, source: emptyLibrary.source, revision: "b".repeat(40), skillPath: "skills/empty", policy, references: [] } });
	const empty = await seedLibraryMaterialsFromSkills(emptyLibrary.id, [emptyPackage]);
	assert.equal(empty.seeded, true);
	assert.deepEqual(empty.manifest?.files, []);
	assert.equal(currentLibraryMaterialsSha256(emptyLibrary.id), empty.manifest?.materialsSha256, "source activation without references still has an accepted local version");
	console.log("skills-library-materials smoke passed");
} finally {
	disposeAllCheckouts();
	if (previousStateHome === undefined) delete process.env.EXXPERTS_STATE_HOME; else process.env.EXXPERTS_STATE_HOME = previousStateHome;
	if (previousLocal === undefined) delete process.env.EXXETA_SKILLS_ALLOW_LOCAL_REPO; else process.env.EXXETA_SKILLS_ALLOW_LOCAL_REPO = previousLocal;
	if (path.dirname(path.resolve(fixtureRoot)) === path.resolve(os.tmpdir()) && path.basename(fixtureRoot).startsWith("exxperts-materials-smoke-")) fs.rmSync(fixtureRoot, { recursive: true, force: true });
}
