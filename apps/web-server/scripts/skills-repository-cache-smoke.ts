import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { disposeAllCheckouts, fetchRepoCandidate, getCheckout, readRepositoryMaterial, reconfigureRepositoryScan, registerCheckout, removeCheckout, RepositoryBlobCache, repositoryScanFromToken, scanRepository } from "../src/skills-repo-fetch.js";

const bytes = new RepositoryBlobCache(4);
bytes.set("a", Buffer.from("aa")).set("b", Buffer.from("bb"));
assert.equal(bytes.get("a")?.toString(), "aa");
bytes.set("c", Buffer.from("cc"));
assert.equal(bytes.has("b"), false, "the least recently read object is evicted");
assert.equal(bytes.get("a")?.toString(), "aa");
bytes.set("a", Buffer.from("a")).set("d", Buffer.from("dd"));
assert.equal(bytes.has("c"), false, "replacement updates byte accounting");
bytes.set("oversized", Buffer.from("12345"));
assert.equal(bytes.has("oversized"), false, "oversized inspection bytes do not poison the cache");
assert.equal(bytes.get("d")?.toString(), "dd");
bytes.clear();
bytes.set("again", Buffer.from("1234"));
assert.equal(bytes.size, 1);

const work = fs.mkdtempSync(path.join(os.tmpdir(), "exxperts-repository-cache-"));
const repo = path.join(work, "repo");
function git(...args: string[]): string {
	const result = spawnSync("git", args, { cwd: repo, encoding: "utf8" });
	assert.equal(result.status, 0, result.stderr);
	return result.stdout.trim();
}
function write(relative: string, content: string): void {
	const file = path.join(repo, relative);
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.writeFileSync(file, content);
}
function commit(): void { git("add", "-A"); git("-c", "user.name=Smoke", "-c", "user.email=smoke@example.invalid", "commit", "-qm", "fixture"); }

try {
	fs.mkdirSync(repo);
	git("init", "-q", "-b", "main");
	git("config", "uploadpack.allowFilter", "true");
	write("skills/brand/SKILL.md", "---\nname: brand\n---\nRead `references/rules.md`.\n");
	write("skills/brand/references/rules.md", "Original rules.\n");
	write("other/extra/SKILL.md", "---\nname: extra\n---\nAnother skill.\n");
	write("assets/logo.svg", "<svg xmlns='http://www.w3.org/2000/svg'></svg>\n");
	write("assets/run.cmd", "echo do-not-run\n");
	commit();
	const policy = { designRepo: false, allowedTypes: ["markdown"], skillRoot: "skills", referenceRoots: [] };
	const [first, concurrent, isolated] = await Promise.all([
		scanRepository(`${repo}#main`, policy, "first", true),
		scanRepository(`${repo}#main`, { ...policy, skillRoot: "other" }, "first", true),
		scanRepository(`${repo}#main`, policy, "second", true),
	]);
	const firstDir = getCheckout(first.token)!.dir;
	assert.equal(getCheckout(concurrent.token)!.dir, firstDir, "concurrent policies in the same access context share a single clone");
	assert.deepEqual(concurrent.skills.map((skill) => skill.name), ["extra"], "each consumer keeps its own discovery policy");
	assert.notEqual(getCheckout(isolated.token)!.dir, firstDir, "different library access contexts cannot share clones");
	assert.notEqual(isolated.accessId, first.accessId);
	const checking = await scanRepository(`${repo}#main`, policy, "first", true);
	assert.notEqual(checking.token, first.token, "each consumer owns a separate token even when its policy is identical");
	removeCheckout(checking.token);
	assert.equal(repositoryScanFromToken(first.token).revision, first.revision, "background check cleanup cannot revoke an open browser's token");
	assert.equal(isolated.libraryId, "second", "library ownership remains isolated");
	assert.deepEqual(first.skills.map((skill) => skill.name), ["brand"]);
	const derived = await reconfigureRepositoryScan(first.token, { ...policy, designRepo: true, allowedTypes: ["markdown", "svg"], referenceRoots: ["."], skillRoot: "" }, "first");
	assert.equal(getCheckout(derived.token)!.dir, firstDir);
	assert.deepEqual(derived.skills.map((skill) => skill.name), ["brand", "extra"], "changing discovery scope fetches safe manifests without cloning");
	assert.deepEqual(repositoryScanFromToken(first.token).policy, first.policy, "earlier review policies stay immutable");
	assert.equal((await readRepositoryMaterial(derived.token, "assets/logo.svg")).kind, "svg");
	await assert.rejects(readRepositoryMaterial(first.token, "assets/logo.svg"), /not enabled/);
	await assert.rejects(readRepositoryMaterial(derived.token, "other/extra/SKILL.md"), /separate instructions/);
	await assert.rejects(readRepositoryMaterial(derived.token, "assets/run.cmd"), /unsupported/);
	removeCheckout(first.token);
	removeCheckout(concurrent.token);
	removeCheckout(isolated.token);
	assert.equal(fs.existsSync(firstDir), true, "another live derived token leases the directory");
	assert.equal((await fetchRepoCandidate(derived.token, "skills/brand", ["skills/brand/references/rules.md"])).references.length, 1);
	write("skills/brand/references/rules.md", "Changed upstream.\n");
	commit();
	const reused = await scanRepository(`${repo}#main`, derived.policy, "first", true);
	assert.equal(reused.revision, first.revision, "ordinary browsing keeps the reviewed commit");
	assert.equal(getCheckout(reused.token)!.dir, firstDir);
	const [fresh, otherFresh, isolatedFresh] = await Promise.all([
		scanRepository(`${repo}#main`, derived.policy, "first", true, { forceRefresh: true }),
		scanRepository(`${repo}#main`, policy, "first", true, { forceRefresh: true }),
		scanRepository(`${repo}#main`, policy, "second", true, { forceRefresh: true }),
	]);
	assert.notEqual(fresh.revision, first.revision);
	assert.equal(getCheckout(fresh.token)!.dir, getCheckout(otherFresh.token)!.dir, "concurrent forced refreshes in the same context also share their clone");
	assert.notEqual(getCheckout(fresh.token)!.dir, getCheckout(isolatedFresh.token)!.dir, "forced refreshes remain isolated across library access contexts");
	assert.equal((await readRepositoryMaterial(derived.token, "skills/brand/references/rules.md")).bytes.toString(), "Original rules.\n");
	assert.equal((await readRepositoryMaterial(fresh.token, "skills/brand/references/rules.md")).bytes.toString(), "Changed upstream.\n");
	removeCheckout(derived.token);
	assert.equal(fs.existsSync(firstDir), true, "the cache retains its own directory lease until idle expiry");
	await assert.rejects(scanRepository(`${repo}#another`, policy, "first", true, { token: fresh.token }), /another source, branch or access context/);
	const leasedDirectory = path.join(work, "leased-checkout");
	fs.mkdirSync(leasedDirectory);
	const leaseA = registerCheckout(leasedDirectory, "synthetic");
	const leaseB = registerCheckout(leasedDirectory, "synthetic");
	removeCheckout(leaseA);
	assert(fs.existsSync(leasedDirectory));
	removeCheckout(leaseB);
	assert.equal(fs.existsSync(leasedDirectory), false, "the final directory lease cleans up its files");
	disposeAllCheckouts();
	assert.equal(fs.existsSync(firstDir), false, "shutdown cleans cache-owned directory leases as well");
	console.log("skills-repository-cache-smoke: OK");
} finally {
	disposeAllCheckouts();
	fs.rmSync(work, { recursive: true, force: true });
}
