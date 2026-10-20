import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { scanRepository, fetchRepoCandidate, importReviewedRepoSkill, readRepoReference, previewRepoFile, disposeAllCheckouts, getCheckout } from "../src/skills-repo-fetch.js";
import { agentSkillsDir, readManagedSkillPackage, writeSkillProvenance } from "../src/skills-store.js";
import { saveSkillLibrary, readSkillLibraries, deleteSkillLibrary, checkSkillLibrary, prepareLibraryUpdate, skillBelongsToLibrary } from "../src/skills-libraries.js";
import type { RepositoryFilePolicy } from "../src/skills-file-policy.js";
import { readManagedSkillReferenceBytes } from "../src/skills-reference-reading.js";

const work = fs.mkdtempSync(path.join(os.tmpdir(), "exxperts-library-snapshot-"));
const repo = path.join(work, "repo");
const previousState = process.env.EXXPERTS_STATE_HOME;
const previousLocal = process.env.EXXETA_SKILLS_ALLOW_LOCAL_REPO;
process.env.EXXPERTS_STATE_HOME = path.join(work, "profile");
process.env.EXXETA_SKILLS_ALLOW_LOCAL_REPO = "1";

function git(...args: string[]): string {
	const result = spawnSync("git", args, { cwd: repo, encoding: "utf8" });
	assert.equal(result.status, 0, result.stderr);
	return result.stdout.trim();
}
function write(relative: string, bytes: Buffer | string): void {
	const dest = path.join(repo, relative);
	fs.mkdirSync(path.dirname(dest), { recursive: true });
	fs.writeFileSync(dest, bytes);
}
function commit(): void { git("add", "-A"); git("-c", "user.name=Smoke", "-c", "user.email=smoke@example.invalid", "commit", "-qm", "fixture"); }

try {
	fs.mkdirSync(repo);
	git("init", "-q", "-b", "main");
	git("config", "uploadpack.allowFilter", "true");
	write("skills/brand-a/SKILL.md", "---\nname: brand-a\ndescription: First brand\n---\nUse ../../brands/a/colors.css and ../../brands/a/manual.pdf.\n");
	write("skills/brand-b/SKILL.md", "---\nname: brand-b\n---\nSecond brand.\n");
	write("skills/brand-a/reference.md", "Selected Markdown only.\n");
	write("skills/brand-a/run.py", "raise Exception('must not run or import')\n");
	write("skills/brand-a/run.cmd", "echo must-not-execute > executed.txt\n");
	write("skills/brand-a/link.md", "../../outside.md");
	write("brands/a/colors.css", "body { color: #111111; }\n");
	write("brands/a/manual.pdf", "%PDF-1.4\n");
	write("unrelated/other.md", "Not a skill reference.\n");
	write("README.md", "# Not a skill\n");
	commit();
	const linkObject = git("hash-object", "-w", "skills/brand-a/link.md");
	git("update-index", "--add", "--cacheinfo", `120000,${linkObject},skills/brand-a/link.md`);
	git("-c", "user.name=Smoke", "-c", "user.email=smoke@example.invalid", "commit", "-qm", "Git symlink mode without filesystem privileges");
	const policy: RepositoryFilePolicy = { designRepo: true, allowedTypes: ["markdown", "styles", "pdf"], skillRoot: "skills", referenceRoots: ["brands/a"] };
	const library = saveSkillLibrary({ name: "Two brands", source: repo, ref: "main", ...policy });
	assert(skillBelongsToLibrary({ source: repo, ref: "main" }, library));
	assert(!skillBelongsToLibrary({ source: repo }, library), "default and named refs remain distinct");
	assert(!skillBelongsToLibrary({ source: repo, ref: "main", libraryId: "another-library" }, library), "an explicit different binding overrides matching source/ref");
	assert(skillBelongsToLibrary({ source: repo }, { id: library.id, source: repo, ref: "" }), "empty refs normalize consistently");
	assert.equal(readSkillLibraries()[0].ref, "main");
	const scan = await scanRepository(`${repo}#main`, policy, library.id, true);
	assert.deepEqual(scan.skills.map((skill) => skill.name), ["brand-a", "brand-b"]);
	assert.equal(scan.files.find((file) => file.path.endsWith("run.py"))?.allowed, false);
	assert.equal(scan.files.find((file) => file.path.endsWith("link.md"))?.allowed, false, "Git symlink mode is rejected independently of the host OS");
	assert.equal(scan.files.find((file) => file.path === "unrelated/other.md")?.allowed, false, "repository structure is visible without permitting unrelated files");
	const selected = ["skills/brand-a/reference.md", "brands/a/colors.css", "brands/a/manual.pdf"];
	assert((await previewRepoFile(scan.token, "skills/brand-a/SKILL.md")).text?.includes("First brand"), "the main manifest can be previewed without being a selected reference");
	await assert.rejects(previewRepoFile(scan.token, "skills/brand-a/run.cmd"), /not permitted|excluded|unsupported/);
	await assert.rejects(previewRepoFile(scan.token, "unrelated/other.md"), /outside|not permitted|excluded/);
	const excludedObject = git("rev-parse", "HEAD:skills/brand-a/run.cmd");
	const objects = spawnSync("git", ["cat-file", "--batch-all-objects", "--batch-check=%(objectname)"], { cwd: getCheckout(scan.token)!.dir, encoding: "utf8" });
	assert.equal(objects.status, 0, objects.stderr);
	assert(!objects.stdout.split(/\r?\n/).includes(excludedObject), "denied previews do not download excluded program bytes");
	assert.equal(fs.existsSync(path.join(repo, "executed.txt")), false);
	await assert.rejects(previewRepoFile(scan.token, "skills/brand-a/link.md"), /symlink/);
	await assert.rejects(previewRepoFile(scan.token, "../outside.md"), /unsafe/);
	await assert.rejects(previewRepoFile("unknown-token", "README.md"), /expired/);
	const candidate = await fetchRepoCandidate(scan.token, "skills/brand-a", selected);
	assert.equal(candidate.references.length, 3);
	assert.equal(candidate.references.find((ref) => ref.path === "brands/a/colors.css")?.localPath, ".skill-references/brands/a/colors.css");
	await assert.rejects(fetchRepoCandidate(scan.token, "skills/brand-a", ["skills/brand-a/run.py"]), /not permitted|unsupported/);
	await assert.rejects(fetchRepoCandidate(scan.token, "skills/brand-a", ["skills/brand-a/link.md"]), /symlinks|invalid repository object/);
	await assert.rejects(fetchRepoCandidate(scan.token, "skills/brand-a", ["unrelated/other.md"]), /outside/);
	const wholeRepo = await scanRepository(`${repo}#main`, { ...policy, referenceRoots: ["."] }, undefined, true);
	assert.deepEqual(wholeRepo.policy.referenceRoots, [""]);
	assert.equal(wholeRepo.files.find((file) => file.path === "unrelated/other.md")?.allowed, true);
	const siblingCandidate = await fetchRepoCandidate(wholeRepo.token, "skills/brand-a", ["unrelated/other.md"]);
	assert.equal(siblingCandidate.references[0].localPath, ".skill-references/unrelated/other.md");
	const packageParent = path.join(work, "packages");
	fs.mkdirSync(packageParent);
	const siblingPackage = path.join(packageParent, "sibling-package");
	const siblingImport = await importReviewedRepoSkill(wholeRepo.token, "skills/brand-a", ["unrelated/other.md"], siblingCandidate.reviewSha256, siblingPackage);
	writeSkillProvenance(siblingPackage, siblingImport.provenance);
	assert.equal((await readManagedSkillReferenceBytes(siblingPackage, "../../unrelated/other.md")).bytes.toString(), "Not a skill reference.\n", "selected sibling paths are preserved and accessible to the agent");
	const parentAlias = path.join(work, "packages-alias");
	const directoryLinkType = process.platform === "win32" ? "junction" : "dir";
	fs.symlinkSync(packageParent, parentAlias, directoryLinkType);
	const aliasedPackage = path.join(parentAlias, "sibling-package");
	assert.equal(readManagedSkillPackage(aliasedPackage)?.packageSha256, readManagedSkillPackage(siblingPackage)?.packageSha256, "parent directory aliases such as macOS /var preserve the verified package");
	assert.equal((await readManagedSkillReferenceBytes(aliasedPackage, "../../unrelated/other.md")).bytes.toString(), "Not a skill reference.\n", "selected references remain readable through a parent alias");
	const linkedPackage = path.join(work, "linked-package");
	fs.symlinkSync(siblingPackage, linkedPackage, directoryLinkType);
	assert.throws(() => readManagedSkillPackage(linkedPackage), /cannot be symbolic links/, "the package directory itself must still be regular");
	const referenceDirectory = path.join(siblingPackage, ".skill-references", "unrelated");
	const movedReferences = path.join(work, "moved-references");
	fs.renameSync(referenceDirectory, movedReferences);
	fs.symlinkSync(movedReferences, referenceDirectory, directoryLinkType);
	assert.throws(() => readManagedSkillPackage(aliasedPackage), /contains a symbolic link/, "a parent alias must not permit linked reference directories inside the package");
	await assert.rejects(fetchRepoCandidate(wholeRepo.token, "skills/brand-a", ["skills/brand-a/run.py"]), /not permitted|unsupported/);
	await assert.rejects(fetchRepoCandidate(wholeRepo.token, "skills/brand-a", ["skills/brand-a/link.md"]), /symlinks|invalid repository object/);
	await assert.rejects(fetchRepoCandidate(scan.token, "skills/brand-a", ["../secret.md"]), /unsafe/);
	await assert.rejects(fetchRepoCandidate(scan.token, "skills/brand-a", [selected[0], selected[0]]), /duplicate/);
	await assert.rejects(fetchRepoCandidate("unknown-token", "skills/brand-a", []), /expired/);
	assert.equal((await readRepoReference(scan.token, "skills/brand-a", "brands/a/manual.pdf")).bytes.toString(), "%PDF-1.4\n");
	const suppliedStaging = fs.mkdtempSync(path.join(work, ".skill-library-import-"));
	const rename = fs.renameSync;
	fs.renameSync = ((from, to) => {
		if (path.resolve(String(to)) === suppliedStaging) throw Object.assign(new Error("Windows denied replacing the caller's staging directory"), { code: "EPERM" });
		return rename(from, to);
	}) as typeof fs.renameSync;
	try {
		await importReviewedRepoSkill(scan.token, "skills/brand-a", selected, candidate.reviewSha256, suppliedStaging);
		assert.equal(fs.readFileSync(path.join(suppliedStaging, "reference.md"), "utf8"), "Selected Markdown only.\n", "a caller-owned empty staging directory needs no replacement rename");
	} finally { fs.renameSync = rename; }
	const failedStaging = fs.mkdtempSync(path.join(work, ".skill-library-import-"));
	const writeFile = fs.writeFileSync;
	fs.writeFileSync = ((file, data, options) => {
		if (path.resolve(String(file)) === path.join(failedStaging, "reference.md")) throw Object.assign(new Error("fixture disk is full"), { code: "ENOSPC" });
		return writeFile(file, data, options);
	}) as typeof fs.writeFileSync;
	try {
		await assert.rejects(importReviewedRepoSkill(scan.token, "skills/brand-a", selected, candidate.reviewSha256, failedStaging), /disk is full/);
		assert.equal(fs.existsSync(failedStaging), false, "failed staging writes leave no partial package");
	} finally { fs.writeFileSync = writeFile; }
	const destination = path.join(agentSkillsDir(), "brand-a");
	await assert.rejects(importReviewedRepoSkill(scan.token, "skills/brand-a", [], candidate.reviewSha256, destination), /reviewed again/);
	const imported = await importReviewedRepoSkill(scan.token, "skills/brand-a", selected, candidate.reviewSha256, destination);
	writeSkillProvenance(destination, imported.provenance);
	assert.equal(fs.existsSync(path.join(destination, "run.py")), false);
	assert.equal(fs.readFileSync(path.join(destination, ".skill-references/brands/a/manual.pdf"), "utf8"), "%PDF-1.4\n");
	await assert.rejects(importReviewedRepoSkill(scan.token, "skills/brand-a", selected, candidate.reviewSha256, destination), /already exists/);
	let checked = await checkSkillLibrary(library.id);
	assert.equal(checked.updates?.find((update) => update.name === "brand-a")?.status, "unchanged");
	assert.equal(checked.updates?.find((update) => update.name === "brand-b")?.status, "new");
	write("unrelated/other.md", "Different irrelevant file.\n");
	commit();
	checked = await checkSkillLibrary(library.id);
	assert.equal(checked.updates?.find((update) => update.name === "brand-a")?.status, "unchanged", "unrelated Git changes do not produce skill updates");
	write("brands/a/colors.css", "body { color: #222222; }\n");
	commit();
	checked = await checkSkillLibrary(library.id);
	assert.equal(checked.updates?.find((update) => update.name === "brand-a")?.status, "changed");
	const update = await prepareLibraryUpdate(library.id, "brand-a");
	assert.equal(update.update.changes?.find((change) => change.path === "brands/a/colors.css")?.after, "body { color: #222222; }\n");
	assert.equal(fs.readFileSync(path.join(destination, ".skill-references/brands/a/colors.css"), "utf8"), "body { color: #111111; }\n", "checks do not install remotely changed bytes");
	const frozen = await fetchRepoCandidate(scan.token, "skills/brand-a", selected);
	assert.equal(frozen.reviewSha256, candidate.reviewSha256, "review token stays bound to the original commit");
	fs.writeFileSync(path.join(destination, "reference.md"), "Local edit\n");
	checked = await checkSkillLibrary(library.id);
	assert.equal(checked.updates?.find((entry) => entry.name === "brand-a")?.status, "local-conflict");
	await assert.rejects(prepareLibraryUpdate(library.id, "brand-a"), /local package changed/);
	fs.writeFileSync(path.join(destination, "reference.md"), "Selected Markdown only.\n");
	fs.unlinkSync(path.join(repo, "brands/a/manual.pdf"));
	commit();
	checked = await checkSkillLibrary(library.id);
	assert.equal(checked.updates?.find((entry) => entry.name === "brand-a")?.status, "changed", "remote reference removal permits reviewed deselection");
	const removalReview = await prepareLibraryUpdate(library.id, "brand-a", selected.filter((entry) => !entry.endsWith("manual.pdf")));
	assert.equal(removalReview.update.changes?.find((entry) => entry.path.endsWith("manual.pdf"))?.status, "removed");
	assert.equal(deleteSkillLibrary(library.id), true);
	assert.equal(fs.existsSync(destination), true, "removing a library preserves installed skills");
	disposeAllCheckouts();
	fs.renameSync(repo, path.join(work, "removed-source"));
	assert.equal((await readManagedSkillReferenceBytes(destination, "../../brands/a/colors.css")).bytes.toString(), "body { color: #111111; }\n", "local references survive snapshot disposal, source removal and library deletion without fetching Git");
	const config = path.join(process.env.EXXPERTS_STATE_HOME!, ".exxperts/app/skill-libraries.json");
	fs.writeFileSync(config, "{broken");
	assert.throws(() => saveSkillLibrary({ name: "Must not overwrite", source: repo }), /cannot be read/);
	assert.equal(fs.readFileSync(config, "utf8"), "{broken");
	console.log("skills-library-snapshot-smoke: OK");
} finally {
	disposeAllCheckouts();
	if (previousState === undefined) delete process.env.EXXPERTS_STATE_HOME; else process.env.EXXPERTS_STATE_HOME = previousState;
	if (previousLocal === undefined) delete process.env.EXXETA_SKILLS_ALLOW_LOCAL_REPO; else process.env.EXXETA_SKILLS_ALLOW_LOCAL_REPO = previousLocal;
	fs.rmSync(work, { recursive: true, force: true });
}
