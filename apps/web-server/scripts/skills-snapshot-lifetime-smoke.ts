import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { disposeAllCheckouts, fetchRepoCandidate, importReviewedRepoSkill, loadFeaturedSource, readRepoReference, scanRepository } from "../src/skills-repo-fetch.js";

const work = fs.mkdtempSync(path.join(os.tmpdir(), "exxperts-snapshot-lifetime-"));
const repo = path.join(work, "repo");
const realNow = Date.now;
const previousLocal = process.env.EXXETA_SKILLS_ALLOW_LOCAL_REPO;
try {
	fs.mkdirSync(repo);
	fs.writeFileSync(path.join(repo, "SKILL.md"), "---\nname: lifetime-skill\n---\nSynthetic instructions.\n");
	fs.writeFileSync(path.join(repo, "reference.md"), "Reviewed reference.\n");
	for (const args of [["init", "-q", "-b", "main"], ["config", "uploadpack.allowFilter", "true"], ["add", "-A"], ["-c", "user.name=Smoke", "-c", "user.email=smoke@example.invalid", "commit", "-qm", "fixture"]]) {
		const result = spawnSync("git", args, { cwd: repo, encoding: "utf8" });
		assert.equal(result.status, 0, result.stderr);
	}
	const scan = await scanRepository(`${repo}#main`, {}, "synthetic-library", true);
	assert.equal(scan.ref, "main");
	assert.equal(scan.libraryId, "synthetic-library");
	let now = realNow();
	Date.now = () => now;
	now += 11 * 60_000;
	const first = await fetchRepoCandidate(scan.token, "", ["reference.md"]);
	now += 11 * 60_000;
	assert.equal((await readRepoReference(scan.token, "", "reference.md")).bytes.toString(), "Reviewed reference.\n");
	now += 11 * 60_000;
	const installed = path.join(work, "installed");
	await importReviewedRepoSkill(scan.token, "", ["reference.md"], first.reviewSha256, installed);
	assert.equal(fs.readFileSync(path.join(installed, "reference.md"), "utf8"), "Reviewed reference.\n", "active review survives beyond 15 minutes without changing its bytes");
	now += 16 * 60_000;
	const expired = (error: unknown) => (error as any)?.code === "REPOSITORY_SNAPSHOT_EXPIRED";
	await assert.rejects(fetchRepoCandidate(scan.token, "", []), expired);
	await assert.rejects(readRepoReference(scan.token, "", "reference.md"), expired);
	const rejected = path.join(work, "must-not-install");
	await assert.rejects(importReviewedRepoSkill(scan.token, "", ["reference.md"], first.reviewSha256, rejected), expired);
	assert.equal(fs.existsSync(rejected), false);
	assert.equal(fs.readFileSync(path.join(installed, "reference.md"), "utf8"), "Reviewed reference.\n");
	process.env.EXXETA_SKILLS_ALLOW_LOCAL_REPO = "1";
	const [featured, concurrentFeatured] = await Promise.all([loadFeaturedSource({ source: repo, author: "Synthetic" }), loadFeaturedSource({ source: repo, author: "Synthetic" })]);
	assert.equal(featured.token, concurrentFeatured.token, "concurrent featured requests share one clone and snapshot");
	assert(featured.token);
	now += 11 * 60_000;
	const refreshedFeatured = await loadFeaturedSource({ source: repo, author: "Synthetic" });
	assert.notEqual(refreshedFeatured.token, featured.token);
	await fetchRepoCandidate(featured.token, "", []);
	Date.now = realNow;
	const fresh = await scanRepository(`${repo}#main`, {}, "synthetic-library", true);
	disposeAllCheckouts();
	await assert.rejects(fetchRepoCandidate(fresh.token, "", []), expired, "server cleanup invalidates old tokens without altering installed packages");
	console.log("skills-snapshot-lifetime-smoke: OK");
} finally {
	Date.now = realNow;
	if (previousLocal === undefined) delete process.env.EXXETA_SKILLS_ALLOW_LOCAL_REPO; else process.env.EXXETA_SKILLS_ALLOW_LOCAL_REPO = previousLocal;
	disposeAllCheckouts();
	fs.rmSync(work, { recursive: true, force: true });
}
